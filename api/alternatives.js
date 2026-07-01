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
  const naturalPct = total > 0 ? Math.round((naturalRaw / total) * 100) : 0;
  const syntheticPct = total > 0 ? 100 - naturalPct : 0;
  const passes = naturalPct > 50;
  return { naturalPct, syntheticPct, passes };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'Taglio API is live' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, materials, category, price, language } = req.body || {};
  if (!materials) return res.status(400).json({ error: 'materials is required' });

  try {
    // Step 1: Claude extracts fibres and generates search queries
    const contentBlocks = [];
    if (imageUrl) {
      contentBlocks.push({ type: 'image', source: { type: 'url', url: imageUrl } });
    }
    contentBlocks.push({
      type: 'text',
      text:
        `You are a fashion assistant. Analyse this product.\n` +
        `Materials text (may be in any language): ${materials}\n` +
        `Category: ${category || 'clothing'}\n` +
        `Price: ${price || 'unknown'}\n\n` +
        `1. Extract the fabric composition as fibre names in English mapped to integer percentages.\n` +
        `2. Generate 3 shopping search queries IN ENGLISH to find visually similar natural-fibre clothing alternatives to buy online. Always write queries in English regardless of the product page language. Each query MUST include the natural fibre material (cotton/linen/wool/silk/cashmere/leather) + the garment type + optionally color. Keep each query under 6 words. Match the price range: ${price || 'mid-range'}.\n\n` +
        `Respond ONLY in this exact JSON format, no other text:\n` +
        `{\n` +
        `  "fibres": { "polyester": 95, "spandex": 5 },\n` +
        `  "queries": ["linen midi dress", "cotton wrap dress", "silk slip dress"]\n` +
        `}`,
    });

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!anthropicRes.ok) throw new Error(`Anthropic error: ${anthropicRes.status}`);

    const anthropicData = await anthropicRes.json();
    const text = anthropicData?.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Anthropic response');

    const { fibres = {}, queries = [] } = JSON.parse(match[0]);
    console.log('Claude queries:', queries);
console.log('Claude fibres:', fibres);
    const analysis = analyzeResult(fibres);

    // Step 2: Serper shopping search for each query
    const alternatives = [];
    for (const query of queries.slice(0, 3)) {
      if (alternatives.length >= 3) break;
      try {
        const serperRes = await fetch('https://google.serper.dev/shopping', {
          method: 'POST',
          headers: {
            'X-API-KEY': process.env.SERPER_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: query, num: 3 }),
        });

        const serperData = await serperRes.json();
        console.log('Serper results for:', query, '| count:', serperData.shopping?.length || 0);

        if (serperData.shopping) {
          for (const item of serperData.shopping) {
            if (alternatives.length >= 3) break;
            alternatives.push({
              brand: item.source || '',
              product: item.title || '',
              url: item.link || '',
              image: item.imageUrl || null,
              price: item.price || '',
            });
          }
        }
      } catch (err) {
        console.error('Serper search error for query:', query, err);
      }
    }

    return res.status(200).json({ fibres, ...analysis, alternatives });
  } catch (err) {
    console.error('alternatives handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
