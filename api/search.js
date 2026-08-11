'use strict';

/*
 * api/search.js — live discovery lane with page-fetch verification
 *
 * Called by api/alternatives.js when the curated catalogue can't answer.
 *
 * Pipeline:
 *   1. Serper /shopping    → structured data (price, image, merchant name) but
 *                            NO usable destination URL — every `link` is a
 *                            google.com search URL.
 *   2. Resolve merchant URL → a second Serper web search per candidate, using
 *                            merchant name + product title, to find the real
 *                            product page.
 *   3. Fetch that page      → the only place actual fibre composition lives.
 *                            Snippets don't reliably state it, and guessing
 *                            from brand or appearance is how a polyester top
 *                            ends up recommended as a natural alternative.
 *   4. Verify with Claude   → composition, price, confirm it's the right garment.
 *   5. Write to staging     → naturals as promotion candidates, everything else
 *                            as a rejected skip-list entry so we never pay to
 *                            re-verify the same URL.
 *
 * Steps 2-4 are the expensive part. They're bounded by MAX_RESOLVE so a single
 * scan can't fan out indefinitely.
 */

// ── Fibre classification (mirrors alternatives.js) ─────────────────────────────

const NATURAL_FIBRES = [
  'cotton', 'linen', 'wool', 'silk', 'cashmere', 'hemp',
  'jute', 'ramie', 'alpaca', 'mohair', 'angora', 'camel', 'flax',
];
const SEMI_SYNTHETIC = [
  'viscose', 'ecovero', 'lyocell', 'tencel', 'modal', 'rayon', 'cupro', 'acetate', 'bamboo',
];

function isNatural(name) {
  const l = String(name).toLowerCase();
  if (SEMI_SYNTHETIC.some(n => l.includes(n))) return false;
  return NATURAL_FIBRES.some(n => l.includes(n));
}

function naturalShare(fibres) {
  let nat = 0, total = 0;
  for (const [name, pct] of Object.entries(fibres || {})) {
    const v = Number(pct) || 0;
    total += v;
    if (isNatural(name)) nat += v;
  }
  return total > 0 ? (nat / total) * 100 : 0;
}

// ── Retailer classification ────────────────────────────────────────────────────

// Retailers we have (or are pursuing) an affiliate relationship with. One of
// these is preferred for the primary slot since the click can actually earn.
// Keep in sync with approved Awin/CJ/Impact programs.
const AFFILIATE_RETAILERS = [
  'net-a-porter.com', 'matchesfashion.com', 'mytheresa.com',
  'nordstrom.com', 'saksfifthavenue.com', 'bloomingdales.com',
  'arket.com', 'cosstores.com', 'everlane.com', 'thereformation.com',
  'sezane.com', 'toa.st',
];

const EXCLUDED_DOMAINS = [
  'google.', 'amazon.', 'ebay.', 'etsy.com', 'poshmark.com', 'depop.com',
  'vinted.', 'thredup.com', 'therealreal.com', 'lyst.com', 'shopstyle.com',
  'pinterest.', 'shein.', 'temu.', 'romwe.', 'boohoo.', 'prettylittlething.',
  'fashionnova.', 'forever21.', 'hm.com', 'zara.com', 'primark.', 'asos.com',
  'wikipedia.org', 'reddit.com', 'youtube.com', 'tiktok.com', 'instagram.com',
];

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function isExcluded(url) {
  const d = domainOf(url);
  return !d || EXCLUDED_DOMAINS.some(bad => d.includes(bad));
}

function isAffiliateRetailer(url) {
  const d = domainOf(url);
  return AFFILIATE_RETAILERS.some(r => d.includes(r));
}

// ── Supabase helpers ───────────────────────────────────────────────────────────

function supabaseBase() {
  return (process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
}

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey:         key,
    Authorization:  `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function hasServiceCredentials() {
  return !!(supabaseBase() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/*
 * Returns a Set of URLs already in staging, so we skip re-resolving and
 * re-verifying anything we've seen — including rejects. This is the whole
 * point of storing rejections: a polyester item confirmed once should never
 * cost another page fetch.
 */
async function loadSeenUrls(urls) {
  if (!hasServiceCredentials() || urls.length === 0) return new Set();

  try {
    const list = urls.map(u => `"${u.replace(/"/g, '')}"`).join(',');
    const res = await fetch(
      `${supabaseBase()}/rest/v1/products_staging?select=url&url=in.(${encodeURIComponent(list)})`,
      { headers: serviceHeaders() }
    );
    if (!res.ok) {
      console.error('[staging] seen-lookup failed:', res.status, (await res.text()).slice(0, 200));
      return new Set();
    }
    const rows = await res.json();
    return new Set(rows.map(r => r.url));
  } catch (err) {
    console.error('[staging] seen-lookup error:', err.message);
    return new Set();
  }
}

async function writeToStaging(rows) {
  if (!hasServiceCredentials()) {
    console.warn('[staging] skipped: service credentials not configured');
    return;
  }
  if (rows.length === 0) {
    console.log('[staging] nothing to write');
    return;
  }

  const url = `${supabaseBase()}/rest/v1/products_staging?on_conflict=url`;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body:    JSON.stringify(rows),
    });

    if (!res.ok) {
      console.error('[staging] write failed:', res.status, (await res.text()).slice(0, 300), 'url:', url);
      return;
    }
    console.log('[staging] wrote', rows.length, 'rows');
  } catch (err) {
    console.error('[staging] write error:', err.message);
  }
}

// ── Step 1: shopping search ────────────────────────────────────────────────────

async function shoppingSearch(query, gl = 'us') {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('SERPER_API_KEY not configured');

  const res = await fetch('https://google.serper.dev/shopping', {
    method:  'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q: query, num: 20, gl, hl: 'en' }),
  });

  if (!res.ok) throw new Error(`Serper shopping error: ${res.status}`);

  const data = await res.json();
  return (data.shopping || []).map(item => ({
    title:      item.title || '',
    merchant:   item.source || '',
    price:      item.price || null,
    priceValue: typeof item.priceValue === 'number' ? item.priceValue : null,
    image:      item.imageUrl || null,
  }));
}

// ── Step 2: resolve a real merchant product URL ────────────────────────────────

/*
 * Shopping results carry no destination URL, so we search the web for the exact
 * merchant + product and take the first result on the merchant's own domain.
 * Requiring a domain match is what stops us resolving to a marketplace listing
 * or a review blog that happens to mention the product.
 */
async function resolveMerchantUrl(candidate) {
  const key = process.env.SERPER_API_KEY;
  const query = `${candidate.merchant} ${candidate.title}`.trim();

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const merchantToken = candidate.merchant.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const item of (data.organic || [])) {
      const link = item.link || '';
      if (!link || isExcluded(link)) continue;

      const d = domainOf(link).replace(/[^a-z0-9]/g, '');
      // Accept when the merchant name appears in the domain — the signal that
      // this is the brand's own site rather than a third party selling it.
      if (merchantToken && d.includes(merchantToken.slice(0, 8))) return link;
    }

    // Fall back to the first non-excluded result if no domain match. Weaker,
    // but better than dropping a candidate we have good shopping data for.
    const first = (data.organic || []).map(i => i.link).find(l => l && !isExcluded(l));
    return first || null;
  } catch (err) {
    console.error('[resolve] failed for', query, err.message);
    return null;
  }
}

// ── Step 3: fetch the product page ─────────────────────────────────────────────

/*
 * The page is the only reliable source of fibre composition. Strips tags and
 * keeps a chunk of text — enough for composition to appear, bounded so we
 * don't ship an entire page into the model.
 */
async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TaglioBot/1.0)',
        'Accept':     'text/html',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Prefer JSON-LD when present — it's structured and usually carries
    // material and price without the surrounding page noise.
    const jsonLd = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1])
      .join(' ')
      .slice(0, 3000);

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Bias toward the part of the page mentioning composition
    const pctIndex = text.search(/\d{1,3}\s*%/);
    const chunk = pctIndex > 0
      ? text.slice(Math.max(0, pctIndex - 1500), pctIndex + 1500)
      : text.slice(0, 3000);

    return (jsonLd ? jsonLd + ' ' : '') + chunk;
  } catch (err) {
    console.error('[fetch] failed for', url, err.message);
    return null;
  }
}

// ── Step 4: verify with Claude ─────────────────────────────────────────────────

async function verifyProduct({ sourceImageUrl, sourceAttrs, candidate, pageText }) {
  const blocks = [];
  if (sourceImageUrl) {
    blocks.push({ type: 'image', source: { type: 'url', url: sourceImageUrl } });
  }
  blocks.push({
    type: 'text',
    text:
      `The image above (if present) is the garment a shopper is viewing.\n` +
      `Its attributes: ${JSON.stringify(sourceAttrs || {})}\n\n` +
      `Below is text from a candidate alternative's product page.\n` +
      `Product: ${candidate.title}\nMerchant: ${candidate.merchant}\n\n` +
      `PAGE TEXT:\n${(pageText || '').slice(0, 4000)}\n\n` +
      `Extract and judge:\n` +
      `- shell_fibres: the outer/shell fabric composition as fibre names mapped to ` +
      `integer percentages, taken from the page text. If the page does not state ` +
      `composition, return an empty object {}. Never guess.\n` +
      `- price: the price as it appears on the page, with currency symbol, or null.\n` +
      `- product_name: the garment name, cleaned of site boilerplate.\n` +
      `- brand_name: the brand's proper name.\n` +
      `- visual_match: 0-10, how closely this resembles the shopper's garment in ` +
      `silhouette, pattern and character. Be strict; 7+ means genuinely similar.\n` +
      `- is_product_page: false if this is a category listing, blog post or guide.\n\n` +
      `Respond ONLY with JSON:\n` +
      `{ "shell_fibres": {"linen": 100}, "price": "$128.00", "product_name": "...", ` +
      `"brand_name": "...", "visual_match": 8, "is_product_page": true }`,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 500,
      messages:   [{ role: 'user', content: blocks }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);

  const data  = await res.json();
  const text  = data?.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

// ── Tiering ────────────────────────────────────────────────────────────────────

function parsePriceValue(priceStr, fallback) {
  if (typeof fallback === 'number') return fallback;
  const n = parseFloat(String(priceStr || '').replace(/[^\d.]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function assignTier(value, sourcePriceUsd) {
  if (!value || !sourcePriceUsd || sourcePriceUsd <= 0) return null;
  const ratio = value / sourcePriceUsd;
  if (ratio < 0.30 || ratio > 2.50) return null;
  if (ratio <= 0.70) return 'accessible';
  if (ratio <= 1.30) return 'similar';
  return 'elevated';
}

// ── Query construction ─────────────────────────────────────────────────────────

function buildQuery({ searchQuery, category, fibre, color_family, silhouette, lane }) {
  const parts = [];

  if (searchQuery) {
    parts.push(searchQuery);
  } else {
    if (fibre) parts.push(fibre);
    if (color_family && color_family !== 'multicolor') parts.push(color_family);
    if (silhouette && silhouette !== 'other') parts.push(silhouette.replace(/_/g, ' '));
    parts.push(category || 'clothing');
  }

  if (lane === 'indie') parts.push('independent brand');
  return parts.join(' ');
}

// ── Config ─────────────────────────────────────────────────────────────────────

const MIN_VISUAL_MATCH  = 6;
const MIN_NATURAL_SHARE = 50;   // shell must be predominantly natural to qualify
const MAX_RESOLVE       = 8;    // caps per-scan cost and latency
const MAX_SHOWN         = 3;

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    imageUrl, category, attributes, fibre, searchQuery, sourcePriceUsd, gl,
  } = req.body || {};

  try {
    const sourceAttrs = attributes || {};

    const [affiliateRaw, indieRaw] = await Promise.all([
      shoppingSearch(buildQuery({ searchQuery, category, fibre, ...sourceAttrs, lane: 'affiliate' }), gl),
      shoppingSearch(buildQuery({ searchQuery, category, fibre, ...sourceAttrs, lane: 'indie' }), gl),
    ]);

    // Dedupe by merchant+title, since the same product appears in both lanes
    const seenKeys = new Set();
    const pool = [...affiliateRaw, ...indieRaw].filter(c => {
      const k = `${c.merchant}|${c.title}`.toLowerCase();
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });

    console.log('[search] shopping pool:', pool.length);

    // Resolve merchant URLs, capped
    const toResolve = pool.slice(0, MAX_RESOLVE);
    const resolved = (await Promise.all(
      toResolve.map(async c => ({ ...c, url: await resolveMerchantUrl(c) }))
    )).filter(c => c.url && !isExcluded(c.url));

    console.log('[search] resolved urls:', resolved.length, 'of', toResolve.length);

    // Skip anything already in staging — including past rejections, so a
    // known-synthetic product never costs another fetch.
    const seenUrls = await loadSeenUrls(resolved.map(c => c.url));
    const fresh = resolved.filter(c => !seenUrls.has(c.url));

    console.log('[search] fresh (not already staged):', fresh.length);

    // Fetch + verify each
    const verified = (await Promise.all(fresh.map(async c => {
      const pageText = await fetchPageText(c.url);
      if (!pageText) return null;
      try {
        const v = await verifyProduct({ sourceImageUrl: imageUrl, sourceAttrs, candidate: c, pageText });
        return v ? { ...c, ...v } : null;
      } catch (err) {
        console.error('[verify] failed:', err.message);
        return null;
      }
    }))).filter(Boolean);

    // Split on actual composition read from the page — not a snippet guess
    const naturals = verified.filter(v =>
      v.is_product_page !== false &&
      Object.keys(v.shell_fibres || {}).length > 0 &&
      naturalShare(v.shell_fibres) >= MIN_NATURAL_SHARE
    );
    const rejects = verified.filter(v => !naturals.includes(v));

    console.log('[search] verified:', verified.length, 'natural:', naturals.length);

    // Write both: naturals as promotion candidates, rejects as skip-list entries
    await writeToStaging([
      ...naturals.map(v => ({
        name:               v.product_name || v.title,
        url:                v.url,
        image_url:          v.image,
        brand:              v.brand_name || v.merchant,
        source_domain:      domainOf(v.url),
        source_query:       searchQuery || '',
        fibre_composition:  v.shell_fibres,
        shell_natural:      true,
        price_original:     parsePriceValue(v.price, v.priceValue),
        visual_match_score: v.visual_match,
        fibre_confidence:   'likely',
        review_status:      'pending',
      })),
      ...rejects.map(v => ({
        name:               v.product_name || v.title,
        url:                v.url,
        source_domain:      domainOf(v.url),
        source_query:       searchQuery || '',
        fibre_composition:  v.shell_fibres || {},
        shell_natural:      false,
        fibre_confidence:   'rejected',
        review_status:      'rejected',
        rejection_reason:   Object.keys(v.shell_fibres || {}).length === 0
          ? 'no composition found on page'
          : 'shell not predominantly natural',
      })),
    ]);

    // Only naturals that also match visually are shown to the shopper
    const showable = naturals
      .filter(v => (v.visual_match || 0) >= MIN_VISUAL_MATCH)
      .sort((a, b) => (b.visual_match || 0) - (a.visual_match || 0));

    const affiliatePick = showable.find(v => isAffiliateRetailer(v.url));
    const ordered = affiliatePick
      ? [affiliatePick, ...showable.filter(v => v !== affiliatePick)]
      : showable;

    const alternatives = ordered.slice(0, MAX_SHOWN).map(v => {
      const value = parsePriceValue(v.price, v.priceValue);
      return {
        brand:       v.brand_name || v.merchant,
        product:     v.product_name || v.title,
        url:         v.url,
        image:       v.image,
        price:       v.price || '',
        tier:        assignTier(value, sourcePriceUsd) || 'discovery',
        material:    Object.entries(v.shell_fibres || {})
                       .sort(([, a], [, b]) => b - a)
                       .slice(0, 2)
                       .map(([n, p]) => `${n} ${p}%`)
                       .join(', '),
        match_score: v.visual_match,
        source:      'search',
        verified:    true,   // composition read from the product page itself
        affiliate:   isAffiliateRetailer(v.url),
      };
    });

    console.log('[search] returning', alternatives.length, 'alternatives');

    return res.status(200).json({ alternatives, source: 'search' });
  } catch (err) {
    console.error('search handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
