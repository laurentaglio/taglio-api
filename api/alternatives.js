'use strict';

// ── Fibre classification ───────────────────────────────────────────────────────

const NATURAL_FIBRES = [
  'cotton', 'linen', 'wool', 'silk', 'cashmere', 'hemp',
  'jute', 'ramie', 'alpaca', 'mohair', 'angora', 'bamboo',
  'camel', 'vicuna', 'qiviut', 'nettle', 'coir', 'flax',
];
const SEMI_SYNTHETIC = [
  'viscose', 'ecovero', 'lyocell', 'tencel', 'modal', 'rayon', 'cupro', 'acetate',
];

function isNatural(name) {
  const l = name.toLowerCase();
  if (SEMI_SYNTHETIC.some(n => l.includes(n))) return false;
  return NATURAL_FIBRES.some(n => l.includes(n));
}

function analyzeResult(fibres) {
  let naturalRaw = 0, syntheticRaw = 0;
  for (const [fibre, pct] of Object.entries(fibres)) {
    if (isNatural(fibre)) naturalRaw += pct;
    else syntheticRaw += pct;
  }
  const total = naturalRaw + syntheticRaw;
  const naturalPct   = total > 0 ? Math.round((naturalRaw  / total) * 100) : 0;
  const syntheticPct = total > 0 ? 100 - naturalPct : 0;
  return { naturalPct, syntheticPct, passes: naturalPct > 50 };
}

// ── Price helpers ─────────────────────────────────────────────────────────────

const SYMBOL_TO_CURRENCY = { '£': 'GBP', '€': 'EUR', '$': 'USD', '¥': 'JPY' };

function parsePriceAndCurrency(priceStr) {
  if (!priceStr || priceStr === 'unknown') return null;

  // Symbol prefix: £265, €40.00, $129.99
  const symbolMatch = priceStr.match(/([£€$¥])\s*([\d,]+(?:\.\d{1,2})?)/);
  if (symbolMatch) {
    return {
      amount:   parseFloat(symbolMatch[2].replace(/,/g, '')),
      currency: SYMBOL_TO_CURRENCY[symbolMatch[1]],
    };
  }

  // Code suffix: 265 GBP, 265EUR
  const codeMatch = priceStr.match(/([\d,]+(?:\.\d{1,2})?)\s*(GBP|EUR|USD|JPY|CHF|AUD|CAD|SEK|NOK|DKK|NZD)/i);
  if (codeMatch) {
    return {
      amount:   parseFloat(codeMatch[1].replace(/,/g, '')),
      currency: codeMatch[2].toUpperCase(),
    };
  }

  // Bare number — assume USD
  const numMatch = priceStr.match(/([\d,]+(?:\.\d{1,2})?)/);
  if (numMatch) {
    return { amount: parseFloat(numMatch[1].replace(/,/g, '')), currency: 'USD' };
  }

  return null;
}

function formatPrice(amount, currency) {
  if (!amount) return '';
  const SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
  const sym = SYMBOLS[currency] || (currency + '\u00a0');
  const str = Number(amount).toFixed(2).replace(/\.00$/, '');
  return sym + str;
}

function formatFibreComposition(fibreComp) {
  if (!fibreComp || typeof fibreComp !== 'object') return '';
  return Object.entries(fibreComp)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([name, pct]) => `${name} ${pct}%`)
    .join(', ');
}

// ── Category normalisation ────────────────────────────────────────────────────

const CATEGORY_KEYWORDS = [
  'dress', 'coat', 'jacket', 'shirt', 'blouse', 'trouser', 'pant',
  'skirt', 'knit', 'sweater', 'cardigan', 'top', 'suit', 'blazer',
  'jumpsuit', 'overall', 'shorts', 'legging', 'vest', 'hoodie',
];

function normalizeCategory(raw) {
  if (!raw) return 'clothing';
  const lower = raw.toLowerCase();
  for (const kw of CATEGORY_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  // Fall back to first meaningful word
  return lower.split(/[\s>\/&,]+/).find(w => w.length > 2) || 'clothing';
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

// Trailing slashes on the configured URL produce "//rest/v1/..." which
// PostgREST rejects as an invalid path (PGRST125), so normalise once here.
function supabaseBase() {
  return (process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
}

function supabaseHeaders() {
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function toUsd(amount, currency) {
  if (!currency || currency === 'USD') return amount;

  const base = supabaseBase();
  const res = await fetch(
    `${base}/rest/v1/fx_rates?currency=eq.${encodeURIComponent(currency)}&order=rate_date.desc&limit=1&select=rate_to_usd`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) {
    // Log rather than silently returning the unconverted amount — a failing FX
    // lookup means every price comparison downstream is wrong, and swallowing
    // it makes that invisible.
    console.error('[fx] lookup failed:', res.status, (await res.text()).slice(0, 200));
    return amount;
  }
  const rows = await res.json();
  const rate = rows[0]?.rate_to_usd;
  return rate ? amount * Number(rate) : amount;
}

// Pull a wider candidate pool per tier than we'll actually show, so there's
// something to rank by attribute overlap. Requires the products table to have
// pattern / embellishment / silhouette / color_family columns populated at
// ingestion (same controlled vocabulary as PATTERN_VALUES etc. above) — if the
// ingestion pipeline doesn't extract these yet, this scoring degrades to a no-op
// and effectively falls back to recency, so that pipeline needs the same fields added.
const CANDIDATE_POOL_SIZE = 20;
const RESULTS_PER_TIER    = 3;

async function queryTier(category, minUsd, maxUsd) {
  const base = supabaseBase();

  const params = [
    `select=${encodeURIComponent('id,brand,name,url,image_url,price_original,currency_original,price_base,fibre_composition,pattern,embellishments,silhouette,color_family')}`,
    'shell_natural=eq.true',
    `category=ilike.${encodeURIComponent('*' + category + '*')}`,
    `price_base=gte.${minUsd.toFixed(2)}`,
    `price_base=lte.${maxUsd.toFixed(2)}`,
    'order=created_at.desc',
    `limit=${CANDIDATE_POOL_SIZE}`,
  ].join('&');

  const url = `${base}/rest/v1/products?${params}`;
  const res = await fetch(url, { headers: supabaseHeaders() });

  if (!res.ok) {
    // Previously returned [] silently, which made a failing query
    // indistinguishable from a genuinely empty catalogue — masking real errors
    // (wrong URL, table not exposed, RLS) as "no matches found".
    console.error('[catalogue] query failed:', res.status,
      (await res.text()).slice(0, 200), 'url:', url);
    return [];
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// ── Claude fibre + visual attribute extraction ────────────────────────────────

// Controlled vocabularies — keep these constrained so results are queryable/scoreable,
// not free text. Extend the lists if new values keep showing up in practice.
const PATTERN_VALUES       = ['solid', 'striped', 'floral', 'geometric', 'checked', 'animal_print', 'abstract', 'other'];
const EMBELLISHMENT_VALUES = ['embroidery', 'beading', 'sequins', 'buttons', 'lace_trim', 'applique', 'other'];
const SILHOUETTE_VALUES    = ['fitted', 'a_line', 'oversized', 'straight', 'wrap', 'flared', 'relaxed', 'other'];

async function parseFibresAndAttributes(imageUrl, materials, category, language) {
  const contentBlocks = [];
  if (imageUrl) {
    contentBlocks.push({ type: 'image', source: { type: 'url', url: imageUrl } });
  }
  contentBlocks.push({
    type: 'text',
    text:
      `You are a fashion assistant. Analyse this product.\n` +
      `Materials text (may be in any language, including ${language || 'en'}): ${materials}\n` +
      `Category: ${category || 'clothing'}\n\n` +
      `Extract the following:\n` +
      `1. shell_fibres: the OUTER/SHELL fabric composition only, as fibre names in English mapped to integer ` +
      `percentages. This is the primary fabric — ignore lining, trim, or interfacing here. This is what ` +
      `determines whether the garment counts as natural fibre, so keep it strictly to the shell/outer layer.\n` +
      `2. lining_fibres: the LINING composition only, as fibre names mapped to integer percentages. If the ` +
      `materials text does not mention a separate lining, or the garment has no lining, return an empty object {}. ` +
      `Do not guess a lining if none is stated.\n` +
      `3. embellishments: an array of decorative details visible on the shell/outer layer of the garment in the ` +
      `image — e.g. embroidery, beading, sequins, buttons, lace trim, appliqué. Use ONLY these controlled values: ` +
      `${JSON.stringify(EMBELLISHMENT_VALUES)}. Return an empty array [] if the shell is plain with no embellishment. ` +
      `Include a value only if it's clearly visible — don't guess from category alone.\n` +
      `4. search_query: a short natural search phrase (5-9 words) describing this ` +
      `garment as a shopper would search for it — gender, colour, fabric, garment type, ` +
      `and one or two distinguishing details. Examples: "womens tan linen midi dress ` +
      `square neck", "mens navy wool crewneck sweater". Describe the garment ITSELF, ` +
      `not a list of keywords, and do not include brand names or the word "buy".\n` +
      `5. Visual attributes read directly from the product image. Use ONLY these controlled values ` +
      `(pick the single closest match, use "other" only if truly none fit):\n` +
      `   - pattern: one of ${JSON.stringify(PATTERN_VALUES)}\n` +
      `   - silhouette: one of ${JSON.stringify(SILHOUETTE_VALUES)}\n` +
      `   - color_family: a single common color word (e.g. "red", "navy", "multicolor")\n` +
      `If no image is provided, set all visual attribute fields to null and embellishments to [] rather than guessing from text.\n\n` +
      `Respond ONLY in this exact JSON format, no other text:\n` +
      `{ "shell_fibres": { "polyester": 95, "elastane": 5 }, "lining_fibres": { "polyester": 100 }, ` +
      `"embellishments": ["embroidery", "buttons"], ` +
      `"search_query": "womens tan linen midi dress square neck", ` +
      `"attributes": { "pattern": "floral", "silhouette": "a_line", "color_family": "multicolor" } }`,
  });

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 400,
      messages:   [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!anthropicRes.ok) throw new Error(`Anthropic error: ${anthropicRes.status}`);

  const anthropicData = await anthropicRes.json();
  const text  = anthropicData?.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Anthropic response');

  const parsed = JSON.parse(match[0]);
  return {
    fibres:        parsed.shell_fibres || {},
    liningFibres:  parsed.lining_fibres || {},
    embellishments: Array.isArray(parsed.embellishments) ? parsed.embellishments : [],
    searchQuery:   typeof parsed.search_query === 'string' ? parsed.search_query : null,
    attributes:    parsed.attributes || { pattern: null, silhouette: null, color_family: null },
  };
}

// ── Visual attribute scoring ───────────────────────────────────────────────────
// Simple weighted overlap score against the source product's attributes.
// Embellishment and pattern carry the most weight since those are the details
// that were previously getting lost entirely (e.g. embroidered dresses matched
// against plain ones in the same category/price band).

const ATTRIBUTE_WEIGHTS = { embellishments: 3, pattern: 3, silhouette: 2, color_family: 1 };

function scoreAttributeMatch(sourceAttrs, sourceEmbellishments, candidateAttrs, candidateEmbellishments) {
  let score = 0;
  if (sourceAttrs && candidateAttrs) {
    for (const key of ['pattern', 'silhouette', 'color_family']) {
      if (sourceAttrs[key] && candidateAttrs[key] && sourceAttrs[key] === candidateAttrs[key]) {
        score += ATTRIBUTE_WEIGHTS[key];
      }
    }
  }
  const srcEmb = sourceEmbellishments || [];
  const candEmb = candidateEmbellishments || [];
  if (srcEmb.length > 0 && candEmb.some(e => srcEmb.includes(e))) {
    score += ATTRIBUTE_WEIGHTS.embellishments;
  }
  return score;
}

// ── Price tier definitions ────────────────────────────────────────────────────

const TIER_DEFS = [
  { name: 'similar',    minFactor: 0.70, maxFactor: 1.30, label: 'Similar price' },
  { name: 'accessible', minFactor: 0.30, maxFactor: 0.70, label: 'Everyday alternative' },
  { name: 'elevated',   minFactor: 1.30, maxFactor: 2.50, label: 'Investment pick' },
];

// Hard bounds (applied before tier bucketing)
const HARD_MIN_FACTOR = 0.30;
const HARD_MAX_FACTOR = 2.50;

// ── Search lane ───────────────────────────────────────────────────────────────

// Calls the sibling api/search.js endpoint. Kept as an HTTP call rather than a
// direct import so the two lanes stay independently deployable and one failing
// can't take the other down.
async function runSearchFallback({ imageUrl, category, attributes, fibres, searchQuery }) {
  const base = process.env.SEARCH_API_BASE || 'https://taglio-api.vercel.app';

  // Pass the dominant natural fibre (if the source item has one) so the search
  // query can anchor on it — e.g. a linen-blend dress should surface linen
  // alternatives, not generic "natural fibre" results.
  const dominantNatural = Object.entries(fibres || {})
    .filter(([name]) => isNatural(name))
    .sort(([, a], [, b]) => b - a)[0]?.[0] || null;

  const res = await fetch(`${base}/api/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ imageUrl, category, attributes, fibre: dominantNatural, searchQuery }),
  });

  if (!res.ok) throw new Error(`search endpoint returned ${res.status}`);

  const data = await res.json();
  return Array.isArray(data.alternatives) ? data.alternatives : [];
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, materials, category, price, language } = req.body || {};
  if (!materials) return res.status(400).json({ error: 'materials is required' });

  try {
    // Step 1: Extract fibre composition + visual attributes via Claude
    const { fibres, liningFibres, embellishments, searchQuery, attributes: sourceAttrs } =
      await parseFibresAndAttributes(imageUrl, materials, category, language);
    const analysis = analyzeResult(fibres);

    // Step 2: Natural products need no alternatives
    if (analysis.passes) {
      return res.status(200).json({ fibres, liningFibres, embellishments, ...analysis, tiers: {}, alternatives: [] });
    }

    // Step 3: Parse input price → USD base
    const parsed = parsePriceAndCurrency(price);
    if (!parsed || parsed.amount <= 0) {
      return res.status(200).json({ fibres, liningFibres, embellishments, ...analysis, tiers: {}, alternatives: [] });
    }
    const priceBaseUsd = await toUsd(parsed.amount, parsed.currency);

    // Hard-bound sanity check (skip matching for unusually cheap/free items)
    if (priceBaseUsd < 5) {
      return res.status(200).json({
        fibres, liningFibres, embellishments, ...analysis, input_price_base: priceBaseUsd, tiers: {}, alternatives: [],
      });
    }

    const normCategory = normalizeCategory(category);
    const hardMin = priceBaseUsd * HARD_MIN_FACTOR;
    const hardMax = priceBaseUsd * HARD_MAX_FACTOR;

    // Step 4: Query the catalogue and the live search lane IN PARALLEL.
    //
    // Both always run — search isn't gated behind the catalogue coming up short.
    // Two reasons: (1) the catalogue skews toward larger retailers with feeds,
    // so indie discovery would be suppressed exactly when the catalogue is
    // healthiest; (2) running search on every scan is what populates staging,
    // which is how the catalogue grows at all. Gating it would mean the
    // catalogue only ever fills in areas where it's already weak.
    //
    // Catalogue results are still PREFERRED in the output ordering — they have
    // verified fibre content and known affiliate relationships. Search results
    // follow, clearly marked as unverified discoveries.
    const tiers   = {};
    const allAlts = [];

    const catalogueWork = (async () => {
      for (const tier of TIER_DEFS) {
        const minUsd = Math.max(priceBaseUsd * tier.minFactor, hardMin);
        const maxUsd = Math.min(priceBaseUsd * tier.maxFactor, hardMax);
        if (minUsd >= maxUsd) continue;

        const rows = await queryTier(normCategory, minUsd, maxUsd);
        if (rows.length === 0) continue;

        const scored = rows
          .map(p => ({
            row: p,
            score: scoreAttributeMatch(
              sourceAttrs,
              embellishments,
              { pattern: p.pattern, silhouette: p.silhouette, color_family: p.color_family },
              p.embellishments
            ),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, RESULTS_PER_TIER);

        const alts = scored.map(({ row: p, score }) => ({
          brand:       p.brand,
          product:     p.name,
          url:         p.url,
          image:       p.image_url || null,
          price:       formatPrice(p.price_original, p.currency_original),
          price_base:  p.price_base,
          tier:        tier.name,
          material:    formatFibreComposition(p.fibre_composition),
          match_score: score,
          source:      'catalogue',
          verified:    true,
        }));

        tiers[tier.name] = { label: tier.label, alternatives: alts };
        allAlts.push(...alts);
      }
    })();

    const searchWork = runSearchFallback({
      imageUrl,
      category:   normCategory,
      attributes: sourceAttrs,
      fibres,
      searchQuery,
    }).catch(searchErr => {
      // Search failing must never break the response — the catalogue result
      // (even an empty one) is still worth returning.
      console.error('search lane failed:', searchErr);
      return [];
    });

    const [, searchAlts] = await Promise.all([catalogueWork, searchWork]);

    // Verified catalogue matches first, discoveries after
    const merged = [...allAlts, ...searchAlts];

    let source = 'catalogue';
    if (allAlts.length > 0 && searchAlts.length > 0) source = 'mixed';
    else if (allAlts.length === 0) source = 'search';

    return res.status(200).json({
      fibres,
      liningFibres,
      embellishments,
      ...analysis,
      input_price_base: priceBaseUsd,
      tiers,
      alternatives: merged,
      source,
    });
  } catch (err) {
    console.error('alternatives handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
