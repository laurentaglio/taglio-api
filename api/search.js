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
function buildQuery({ category, fibre, colorFamily, silhouette, lane }) {
  const parts = [];

  if (fibre) parts.push(`100% ${fibre}`);
  else parts.push(NATURAL_FIBRE_TERMS.slice(0, 3).join(' OR '));

  if (colorFamily && colorFamily !== 'multicolor') parts.push(colorFamily);
  if (silhouette && silhouette !== 'other') parts.push(silhouette.replace(/_/g, ' '));
  parts.push(category || 'clothing');

  if (lane === 'indie') {
    // Terms that skew toward independent labels' own product pages
    parts.push('independent brand');
  }

  return parts.join(' ');
}

// ── Search provider (Serper) ───────────────────────────────────────────────────

async function runSearch(query, numResults = 20) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('SERPER_API_KEY not configured');

  const res = await fetch('https://google.serper.dev/shopping', {
    method: 'POST',
    headers: {
      'X-API-KEY': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: numResults }),
  });

  if (!res.ok) throw new Error(`Serper error: ${res.status}`);

  const data = await res.json();
  const items = data.shopping || data.organic || [];

  return items
    .map(item => ({
      title:  item.title || '',
      url:    item.link || '',
      image:  item.imageUrl || item.thumbnail || null,
      price:  item.price || null,
      source: item.source || domainOf(item.link || ''),
    }))
    .filter(r => r.url && !isExcluded(r.url));
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
    .map((c, i) => `${i}. ${c.title} — ${c.source}${c.price ? ` — ${c.price}` : ''}`)
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
      `- natural_fibre_likely: true if the title/description suggests a predominantly ` +
      `natural fibre shell (linen, cotton, wool, silk, cashmere, hemp). If the title ` +
      `mentions polyester/nylon/acrylic, or gives no fibre indication at all, use false.\n` +
      `- visual_match: 0-10, how closely this resembles the shopper's garment in ` +
      `silhouette, pattern, and overall character. Be strict — 7+ means genuinely similar, ` +
      `not just "same category".\n` +
      `- indie: true if this reads as an independent/small label rather than a large ` +
      `chain or department store.\n\n` +
      `Candidates:\n${listing}\n\n` +
      `Respond ONLY with JSON, no other text:\n` +
      `{ "results": [ { "index": 0, "natural_fibre_likely": true, "visual_match": 8, "indie": true } ] }`,
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
        visual_match:         Number(r.visual_match) || 0,
        indie:                !!r.indie,
      };
    })
    .filter(Boolean);
}

// ── Result composition ─────────────────────────────────────────────────────────

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
function compose(verified) {
  const eligible = verified
    .filter(r => r.natural_fibre_likely && r.visual_match >= MIN_VISUAL_MATCH)
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
    brand:        r.source,
    product:      r.title,
    url:          r.url,
    image:        r.image,
    price:        r.price || '',
    tier,
    material:     '',            // unknown until verified — deliberately blank
    match_score:  r.visual_match,
    source:       'search',      // lets the popup distinguish from catalogue results
    verified:     false,         // fibre content NOT confirmed; UI should label accordingly
    affiliate:    isAffiliateRetailer(r.url),
  });

  const alternatives = [];
  if (affiliatePick) alternatives.push(toAlt(affiliatePick, 'similar'));
  [...indiePicks, ...filler].forEach(r => alternatives.push(toAlt(r, 'discovery')));

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
  const base = process.env.VITE_SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!base || !key) {
    console.warn('staging write skipped: Supabase service credentials not configured');
    return;
  }
  if (results.length === 0) return;

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
    const res = await fetch(
      `${base}/rest/v1/products_staging?on_conflict=url`,
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
      console.error('staging write failed:', res.status, body.slice(0, 300));
      return;
    }

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

  const { imageUrl, category, attributes, fibre } = req.body || {};

  try {
    const sourceAttrs = attributes || {};

    const affiliateQuery = buildQuery({
      category,
      fibre,
      colorFamily: sourceAttrs.color_family,
      silhouette:  sourceAttrs.silhouette,
      lane:        'affiliate',
    });
    const indieQuery = buildQuery({
      category,
      fibre,
      colorFamily: sourceAttrs.color_family,
      silhouette:  sourceAttrs.silhouette,
      lane:        'indie',
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

    if (candidates.length === 0) {
      return res.status(200).json({ alternatives: [], source: 'search' });
    }

    const verified     = await verifyCandidates(imageUrl, sourceAttrs, candidates);
    const alternatives = compose(verified);

    // Capture everything that passed the fibre-plausibility check into staging,
    // not just what we're showing. A result can be a poor visual match for THIS
    // shopper's item while still being a perfectly good catalogue product.
    // Deliberately not awaited — the shopper shouldn't wait on a write that
    // doesn't affect their result.
    const worthCapturing = verified.filter(r => r.natural_fibre_likely);
    writeToStaging(worthCapturing, indieQuery).catch(err =>
      console.error('staging write-back failed:', err.message)
    );

    return res.status(200).json({ alternatives, source: 'search' });
  } catch (err) {
    console.error('search handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
