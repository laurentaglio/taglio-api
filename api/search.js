'use strict';

/*
 * api/search.js — live product search lane
 *
 * Complements api/alternatives.js (the database lane). Where alternatives.js
 * queries the curated Supabase catalogue, this endpoint searches the live web
 * for natural fibre alternatives — the "discovery" path that surfaces indie
 * labels the catalogue doesn't cover yet.
 *
 * Two lanes, composed into one result set:
 *   - AFFILIATE lane: constrained to retailers we have (or expect to have) an
 *     affiliate relationship with. Guarantees at least one monetizable pick.
 *   - INDIE lane: biased toward independent natural fibre labels, with big
 *     aggregators and fast fashion filtered out. This is the differentiator.
 *
 * Results are returned in the SAME shape as alternatives.js so the extension
 * popup needs no changes to render them, with an added `source` field so the
 * UI can distinguish verified catalogue matches from live discoveries.
 */

// ── Retailer classification ────────────────────────────────────────────────────

// Retailers we have or are pursuing affiliate relationships with. A result from
// one of these can produce commission, so we guarantee one in the result set.
// Extend this as Awin/CJ/Impact programs are approved.
const AFFILIATE_RETAILERS = [
  'net-a-porter.com', 'matchesfashion.com', 'mytheresa.com',
  'nordstrom.com', 'saksfifthavenue.com', 'bloomingdales.com',
  'arket.com', 'cosstores.com', 'everlane.com', 'reformation.com',
  'sezane.com', 'toa.st', 'thereformation.com',
];

// Never surface these: aggregators (no direct product page, breaks deep links),
// marketplaces (unreliable fibre data), and fast fashion (wrong register for
// the brand positioning entirely).
const EXCLUDED_DOMAINS = [
  // Aggregators / resale / marketplaces
  'google.com', 'shopping.google.com', 'amazon.', 'ebay.', 'etsy.com',
  'poshmark.com', 'depop.com', 'vinted.', 'thredup.com', 'therealreal.com',
  'lyst.com', 'shopstyle.com', 'polyvore.com', 'pinterest.',
  // Fast fashion
  'shein.', 'temu.', 'romwe.', 'boohoo.', 'prettylittlething.',
  'fashionnova.', 'forever21.', 'hm.com', 'zara.com', 'primark.',
  'asos.com', 'missguided.', 'nastygal.',
  // Editorial / non-shoppable
  'wikipedia.org', 'reddit.com', 'youtube.com', 'tiktok.com',
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
  if (!d) return true;
  return EXCLUDED_DOMAINS.some(bad => d.includes(bad));
}

function isAffiliateRetailer(url) {
  const d = domainOf(url);
  return AFFILIATE_RETAILERS.some(r => d.includes(r));
}

// ── Query construction ─────────────────────────────────────────────────────────

const NATURAL_FIBRE_TERMS = ['linen', 'cotton', 'wool', 'silk', 'cashmere', 'hemp'];

/*
 * Builds a search query for a given lane.
 *
 * The indie lane deliberately avoids naming big retailers and leans on terms
 * that independent labels actually use in their product copy ("100% linen",
 * "made in", "small batch"). We can't hard-filter to indie domains in the
 * query itself, so filtering happens on the results — the query just biases.
 */
/*
 * Builds a search query for a given lane.
 *
 * Prefers `searchQuery` — a natural garment description Claude wrote from the
 * product image ("womens tan linen midi dress square neck"). That works far
 * better than concatenated attributes: keyword soup like
 * "linen OR cotton OR wool blue fitted knit buy" returns category pages and
 * blog posts, because that's what generic keyword queries match.
 *
 * The attribute-built fallback only applies when Claude couldn't produce a
 * description (e.g. no product image available).
 */
function buildQuery({ category, fibre, colorFamily, silhouette, lane, searchQuery }) {
  const parts = [];

  if (searchQuery) {
    parts.push(searchQuery);
  } else {
    if (fibre) parts.push(fibre);
    else parts.push(NATURAL_FIBRE_TERMS.slice(0, 3).join(' '));
    if (colorFamily && colorFamily !== 'multicolor') parts.push(colorFamily);
    if (silhouette && silhouette !== 'other') parts.push(silhouette.replace(/_/g, ' '));
    parts.push(category || 'clothing');
  }

  if (lane === 'indie') {
    // Nudges away from the big chains that dominate generic apparel queries
    parts.push('independent label');
  } else {
    parts.push('shop');
  }

  return parts.join(' ');
}

// ── Product page detection ─────────────────────────────────────────────────────

/*
 * Web search returns category pages ("Women's Sweaters & Cardigans"), blog
 * posts ("12 Things I Wish I Knew Before Knitting"), and lookbooks alongside
 * actual products. None of those are usable as alternatives — you can't link a
 * shopper to a category page and call it a match.
 *
 * This is a cheap pre-filter on URL shape and title; Claude does the more
 * reliable judgement in the verification pass.
 */
const NON_PRODUCT_URL_PATTERNS = [
  '/blog/', '/journal/', '/magazine/', '/stories/', '/guide',
  '/collections/all', '/category/', '/categories/', '/c/',
  '/search', '/help', '/about', '/lookbook', '/edit/',
];

const NON_PRODUCT_TITLE_PATTERNS = [
  'things i wish', 'how to', 'guide to', 'best ', ' vs ', 'why ',
  'what to wear', 'trends', 'roundup', 'we tried',
];

function looksLikeProductPage(result) {
  const url   = (result.url || '').toLowerCase();
  const title = (result.title || '').toLowerCase();

  if (NON_PRODUCT_URL_PATTERNS.some(p => url.includes(p))) return false;
  if (NON_PRODUCT_TITLE_PATTERNS.some(p => title.includes(p))) return false;

  // Plural category-style titles with no specific garment named
  if (/^(women|men)('|’)?s\s+\w+(\s*&\s*\w+)?s?$/i.test(result.title || '')) return false;

  return true;
}

// ── Search provider (Serper) ───────────────────────────────────────────────────

/*
 * Uses Serper's regular web search endpoint, NOT /shopping.
 *
 * /shopping returns Google Shopping listings whose `link` points at
 * google.com/shopping/product/... — aggregator pages, not merchant sites.
 * Those fail the domain filter (correctly: they'd reintroduce the "opens to
 * Google Shopping instead of the brand" problem) and can't carry an affiliate
 * deep link. Regular web search returns the retailer's own product URLs.
 *
 * Tradeoff: web results don't carry structured price/image fields the way
 * shopping results do, so price often arrives null and images come from the
 * page rather than a product feed. Worth it for real merchant links.
 */
/*
 * Uses Serper's /shopping endpoint.
 *
 * Shopping results carry the structured data we actually need — price, currency,
 * product image, merchant name — which regular web search does not. The one
 * problem with them is that `link` often points at a Google Shopping page rather
 * than the merchant's own site. That's a link-resolution problem (handled by
 * resolveMerchantUrl below), NOT a reason to abandon the data source: switching
 * to web search fixed the links but threw away prices, images and tiers with them.
 */
async function runSearch(query, numResults = 20) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('SERPER_API_KEY not configured');

  const res = await fetch('https://google.serper.dev/shopping', {
    method: 'POST',
    headers: {
      'X-API-KEY': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: numResults, gl: 'us', hl: 'en' }),
  });

  if (!res.ok) throw new Error(`Serper error: ${res.status}`);

  const data = await res.json();
  const items = data.shopping || [];

  if (items.length === 0) {
    console.log('[search] serper returned no items; response keys:', Object.keys(data));
    return [];
  }

  // One-time visibility into what fields shopping results actually carry, so we
  // can see which one holds a real merchant URL. Remove once link resolution is
  // confirmed working.
  console.log('[search] sample shopping item:', JSON.stringify(items[0]).slice(0, 500));

  const mapped = items.map(item => ({
    title:        item.title || '',
    url:          resolveMerchantUrl(item),
    googleUrl:    item.link || '',
    image:        item.imageUrl || item.thumbnail || null,
    price:        item.price || null,
    priceValue:   typeof item.priceValue === 'number' ? item.priceValue : null,
    currency:     item.currency || null,
    source:       item.source || '',        // merchant name, e.g. "Everlane"
    snippet:      item.snippet || item.delivery || '',
  }));

  // Only keep results where we have a real merchant URL — a Google Shopping
  // link is not something we can send a shopper to, or attach affiliate
  // tracking to.
  const kept = mapped.filter(r => r.url && !isExcluded(r.url));

  console.log('[search] shopping results:', {
    returned:        items.length,
    merchantUrlOk:   mapped.filter(r => r.url).length,
    afterExclusions: kept.length,
  });

  return kept;
}

/*
 * Shopping results expose the destination merchant in different fields
 * depending on the result type. Try each in turn; return null if all we have
 * is a Google-owned URL, since that can't be linked to or affiliate-tracked.
 */
function resolveMerchantUrl(item) {
  const candidates = [
    item.productLink,     // direct merchant link on some results
    item.merchantLink,
    item.offerLink,
    item.link,            // often google.com/shopping/... — checked last
  ].filter(Boolean);

  for (const candidate of candidates) {
    const d = domainOf(candidate);
    if (d && !d.includes('google.')) return candidate;
  }

  return null;
}

// ── Claude verification ────────────────────────────────────────────────────────

/*
 * Search results give us a title, an image and a price — but no verified fibre
 * content. This step asks Claude to judge, from the listing image and title,
 * whether each candidate is plausibly a natural fibre garment AND a visual
 * match for the source item.
 *
 * IMPORTANT: this is a *plausibility* check, not a guarantee. Unlike catalogue
 * products (where fibre content was verified at ingestion), these results are
 * returned to the UI marked `verified: false` so the extension can label them
 * as discoveries rather than confirmed matches.
 */
async function verifyCandidates(sourceImageUrl, sourceAttrs, candidates) {
  if (candidates.length === 0) return [];

  const listing = candidates
    .map((c, i) => {
      const parts = [`${i}. ${c.title} — ${c.source}`];
      if (c.price) parts.push(`— ${c.price}`);
      if (c.snippet) parts.push(`\n   ${c.snippet.slice(0, 200)}`);
      return parts.join(' ');
    })
    .join('\n');

  const contentBlocks = [];
  if (sourceImageUrl) {
    contentBlocks.push({ type: 'image', source: { type: 'url', url: sourceImageUrl } });
  }
  contentBlocks.push({
    type: 'text',
    text:
      `The image above (if present) is the garment a shopper is currently viewing.\n` +
      `Its attributes: ${JSON.stringify(sourceAttrs || {})}\n\n` +
      `Below are candidate alternative products found via search. For each, judge:\n` +
      `- natural_fibre_likely: true ONLY if the title or snippet gives positive evidence ` +
      `of a natural fibre shell — it names linen, cotton, wool, silk, cashmere or hemp. ` +
      `If it mentions polyester/nylon/acrylic/viscose, use false. If fibre content is not ` +
      `mentioned at all, use false: absence of evidence is not evidence, and surfacing a ` +
      `synthetic garment as a natural alternative is the worst failure this product can have. ` +
      `Do not infer fibre from brand reputation or how a garment looks.\n` +
      `- is_product_page: true only if this is a single specific purchasable garment. ` +
      `False for category/collection listings ("Women's Sweaters"), blog posts, guides, ` +
      `or lookbooks — those can't be linked to as an alternative.\n` +
      `- visual_match: 0-10, how closely this resembles the shopper's garment in ` +
      `silhouette, pattern, and overall character. Be strict — 7+ means genuinely similar, ` +
      `not just "same category". Score 0 if is_product_page is false.\n` +
      `- indie: true if this reads as an independent/small label rather than a large ` +
      `chain or department store.\n` +
      `- brand_name: the brand's proper name, cleaned up (e.g. "Astr The Label", not ` +
      `"astrthelabel.com"). Use the domain only if no brand name is discernible.\n` +
      `- product_name: the garment's name, with site boilerplate and the brand name ` +
      `stripped (e.g. "Adeline Knit Top", not "Adeline Knit Top | Shop Now | Brand").\n\n` +
      `Candidates:\n${listing}\n\n` +
      `Respond ONLY with JSON, no other text:\n` +
      `{ "results": [ { "index": 0, "natural_fibre_likely": true, "is_product_page": true, "visual_match": 8, "indie": true, "brand_name": "Astr The Label", "product_name": "Adeline Knit Top" } ] }`,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);

  const data = await res.json();
  const text = data?.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (_) {
    return [];
  }

  return (parsed.results || [])
    .map(r => {
      const candidate = candidates[r.index];
      if (!candidate) return null;
      return {
        ...candidate,
        natural_fibre_likely: !!r.natural_fibre_likely,
        is_product_page:      r.is_product_page !== false,
        visual_match:         Number(r.visual_match) || 0,
        indie:                !!r.indie,
        brand_name:           typeof r.brand_name === 'string' ? r.brand_name : null,
        product_name:         typeof r.product_name === 'string' ? r.product_name : null,
      };
    })
    .filter(Boolean);
}

// ── Price handling ─────────────────────────────────────────────────────────────

/*
 * Shopping results give price as a display string ("$128.00") and sometimes a
 * numeric priceValue. Only show something that actually reads as a price — a
 * bare number with no currency is worse than showing nothing, since the shopper
 * can't tell what it means.
 */
function formatSearchPrice(r) {
  if (typeof r.price === 'string' && /[£€$¥]|\d[.,]\d{2}/.test(r.price)) return r.price;
  if (typeof r.priceValue === 'number' && r.currency) {
    const symbols = { USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
    return (symbols[r.currency] || r.currency + '\u00a0') + r.priceValue.toFixed(2).replace(/\.00$/, '');
  }
  return '';
}

/*
 * Buckets a search result into the same price tiers the catalogue uses, so
 * discoveries slot into the existing "Similar price / Investment pick /
 * Everyday alternative" framing rather than being an untiered pile.
 * Returns null when we have no usable price — those fall back to 'discovery'.
 */
function assignTier(r, sourcePriceUsd) {
  if (!sourcePriceUsd || sourcePriceUsd <= 0) return null;

  const value = typeof r.priceValue === 'number'
    ? r.priceValue
    : parseFloat(String(r.price || '').replace(/[^\d.]/g, ''));

  if (!value || Number.isNaN(value)) return null;

  const ratio = value / sourcePriceUsd;
  if (ratio < 0.30 || ratio > 2.50) return null;   // outside hard bounds
  if (ratio <= 0.70) return 'accessible';
  if (ratio <= 1.30) return 'similar';
  return 'elevated';
}



const MIN_VISUAL_MATCH = 6;   // below this, it's not a real alternative
const MAX_INDIE_RESULTS = 3;

/*
 * Composes the final result set: one affiliate-eligible pick (the reliably
 * monetizable option, shown as the primary card) plus indie discoveries.
 *
 * If no affiliate result clears the bar, we return indie results only rather
 * than promoting a weak affiliate match — a bad primary card is worse than
 * no affiliate link on that view.
 */
function compose(verified, sourcePriceUsd) {
  const eligible = verified
    .filter(r => r.natural_fibre_likely && r.is_product_page && r.visual_match >= MIN_VISUAL_MATCH)
    .sort((a, b) => b.visual_match - a.visual_match);

  const affiliatePick = eligible.find(r => isAffiliateRetailer(r.url)) || null;

  const indiePicks = eligible
    .filter(r => r !== affiliatePick && r.indie)
    .slice(0, MAX_INDIE_RESULTS);

  // If we found nothing indie, fall back to any remaining eligible results so
  // the shopper still sees options — just not labelled as indie discoveries.
  const filler = indiePicks.length === 0
    ? eligible.filter(r => r !== affiliatePick).slice(0, MAX_INDIE_RESULTS)
    : [];

  const toAlt = (r, tier) => ({
    brand:        r.brand_name || r.source || domainOf(r.url),
    product:      r.product_name || r.title,
    url:          r.url,
    image:        r.image,
    price:        formatSearchPrice(r),
    tier,
    material:     '',            // unknown until verified — deliberately blank
    match_score:  r.visual_match,
    source:       'search',      // lets the popup distinguish from catalogue results
    verified:     false,         // fibre content NOT confirmed; UI should label accordingly
    affiliate:    isAffiliateRetailer(r.url),
  });

  const alternatives = [];
  if (affiliatePick) {
    alternatives.push(toAlt(affiliatePick, assignTier(affiliatePick, sourcePriceUsd) || 'discovery'));
  }
  [...indiePicks, ...filler].forEach(r =>
    alternatives.push(toAlt(r, assignTier(r, sourcePriceUsd) || 'discovery'))
  );

  return alternatives;
}

// ── Staging write-back ─────────────────────────────────────────────────────────

/*
 * Writes discovered products into products_staging so the catalogue grows from
 * real usage rather than only from manual seeding.
 *
 * Uses the SERVICE ROLE key, not the anon key: products_staging has RLS enabled
 * with no public policies, precisely because unverified rows must not be
 * reachable from the client. Never expose SUPABASE_SERVICE_ROLE_KEY to the
 * extension — it belongs only in this server-side function.
 *
 * Fire-and-forget by design: a staging write failing should never degrade what
 * the shopper sees, so errors are logged and swallowed.
 */
async function writeToStaging(results, sourceQuery) {
  // Strip any trailing slash — a base ending in "/" produces "//rest/v1/..."
  // which PostgREST rejects as an invalid path (PGRST125).
  const base = (process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('[staging] called with', results.length, 'results; credentials present:',
    { base: !!base, key: !!key });

  if (!base || !key) {
    console.warn('[staging] skipped: Supabase service credentials not configured');
    return;
  }
  if (results.length === 0) {
    console.log('[staging] nothing to write');
    return;
  }

  const rows = results.map(r => ({
    name:               r.title,
    url:                r.url,
    image_url:          r.image,
    brand:              r.source,
    source_domain:      domainOf(r.url),
    source_query:       sourceQuery,
    visual_match_score: r.visual_match,
    fibre_confidence:   r.natural_fibre_likely ? 'likely' : 'unconfirmed',
    review_status:      'pending',
  }));

  try {
    // on_conflict on url + merge-duplicates: rediscovering a product updates it
    // rather than erroring or duplicating. times_seen is bumped separately below.
    const targetUrl = `${base}/rest/v1/products_staging?on_conflict=url`;
    console.log('[staging] POST', targetUrl);

    const res = await fetch(
      targetUrl,
      {
        method: 'POST',
        headers: {
          apikey:          key,
          Authorization:   `Bearer ${key}`,
          'Content-Type':  'application/json',
          Prefer:          'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      console.error('[staging] write failed:', res.status, body.slice(0, 300));
      return;
    }

    console.log('[staging] wrote', rows.length, 'rows, status', res.status);

    // Bump times_seen for any URL we've seen before. Done as a separate RPC-less
    // update since PostgREST upsert can't express "increment on conflict".
    await Promise.all(rows.map(row =>
      fetch(
        `${base}/rest/v1/rpc/increment_staging_seen`,
        {
          method: 'POST',
          headers: {
            apikey:         key,
            Authorization:  `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_url: row.url }),
        }
      ).catch(() => {})   // best-effort; missing RPC shouldn't break anything
    ));
  } catch (err) {
    console.error('staging write error:', err.message);
  }
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, category, attributes, fibre, searchQuery, sourcePriceUsd } = req.body || {};

  try {
    const sourceAttrs = attributes || {};

    const affiliateQuery = buildQuery({
      category,
      fibre,
      colorFamily: sourceAttrs.color_family,
      silhouette:  sourceAttrs.silhouette,
      lane:        'affiliate',
      searchQuery,
    });
    const indieQuery = buildQuery({
      category,
      fibre,
      colorFamily: sourceAttrs.color_family,
      silhouette:  sourceAttrs.silhouette,
      lane:        'indie',
      searchQuery,
    });

    // Run both lanes. The affiliate lane is a narrower query (it'll naturally
    // surface bigger retailers); the indie lane biases toward small labels.
    const [affiliateRaw, indieRaw] = await Promise.all([
      runSearch(affiliateQuery),
      runSearch(indieQuery),
    ]);

    // Dedupe by URL across both lanes
    const seen = new Set();
    const candidates = [...affiliateRaw, ...indieRaw].filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 24);   // cap what we send to Claude, for cost and latency

    // Diagnostics: these three numbers tell you exactly which stage is dropping
    // candidates. Remove once the thresholds are tuned.
    console.log('[search] queries:', { affiliateQuery, indieQuery });
    console.log('[search] raw results:', {
      affiliate: affiliateRaw.length,
      indie:     indieRaw.length,
      deduped:   candidates.length,
    });

    if (candidates.length === 0) {
      console.log('[search] no candidates survived domain filtering');
      return res.status(200).json({ alternatives: [], source: 'search' });
    }

    const verified     = await verifyCandidates(imageUrl, sourceAttrs, candidates);
    const alternatives = compose(verified, sourcePriceUsd);

    console.log('[search] verification:', {
      verified:      verified.length,
      naturalFibre:  verified.filter(r => r.natural_fibre_likely).length,
      productPages:  verified.filter(r => r.is_product_page).length,
      passedVisual:  verified.filter(r => r.visual_match >= MIN_VISUAL_MATCH).length,
      passedBoth:    verified.filter(r => r.natural_fibre_likely && r.visual_match >= MIN_VISUAL_MATCH).length,
      shown:         alternatives.length,
      scoreSample:   verified.slice(0, 5).map(r => ({
        t: r.title?.slice(0, 40), nat: r.natural_fibre_likely, vis: r.visual_match,
      })),
    });

    // Capture everything that passed the fibre and product-page checks into
    // staging, not just what we're showing. A result can be a poor visual match
    // for THIS shopper's item while still being a perfectly good catalogue product.
    //
    // MUST be awaited: on serverless, the function can be frozen or terminated
    // the moment the response is sent, which kills any in-flight promise. A
    // fire-and-forget write here silently never completes.
    const worthCapturing = verified.filter(r => r.natural_fibre_likely && r.is_product_page);
    await writeToStaging(worthCapturing, indieQuery).catch(err =>
      console.error('[staging] write-back failed:', err.message)
    );

    return res.status(200).json({ alternatives, source: 'search' });
  } catch (err) {
    console.error('search handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
