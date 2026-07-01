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

const SITES = [
  'faithfullthebrand.com',
  'thereformation.com',
  'everlane.com',
  'christydawn.com',
  'sezane.com',
  'quince.com',
  'jennikayne.com',
  'rouje.com',
  'coucouintimates.com',
].map(s => `site:${s}`).join(' OR ');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Taglio API is live' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, materials, category, price, language } = req.body || {};
  if (!materials) return res.status(400).json({ error: 'materials is required' });

  try {
    const contentBlocks = [];
    if (imageUrl) {
      contentBlocks.push({ type: 'image', source: { type: 'url', url: imageUrl } });
    }
    contentBlocks.push({
      type: 'text',
      text:
        `You are a fashion assistant. Analyse this product.\n` +
        `Materials text (may be in any language): ${materials}\n` +
        `Category: ${category || 'clothing'}\n\n` +
        `1. Extract the fabric composition as fibre names in English mapped to integer percentages.\n` +
        `2. Generate 3 short search queries (under 5 words each) to find visually similar natural-fibre alternatives.\n\n` +
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
    const analysis = analyzeResult(fibres);

    const alternatives = [];
    for (const query of queries.slice(0, 3)) {
      if (alternatives.length >= 3) break;
      const searchUrl =
        `https://www.googleapis.com/customsearch/v1` +
        `?key=${process.env.GOOGLE_API_KEY}` +
        `&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}` +
        `&q=${encodeURIComponent(query + ' ' + SITES)}` +
        `&num=3`;
      try {
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();
        console.log('Google search for:', query, '| results:', searchData.items?.length || 0);
        if (searchData.items) {
          for (const item of searchData.items) {
            if (alternatives.length >= 3) break;
            alternatives.push({
              brand: new URL(item.link).hostname.replace('www.', '').split('.')[0],
              product: item.title.split('|')[0].split('-')[0].trim(),
              url: item.link,
              image: item.pagemap?.cse_image?.[0]?.src || null,
              price: '',
            });
          }
        }
      } catch (err) {
        console.error('Google search error for query:', query, err);
      }
    }

    return res.status(200).json({ fibres, ...analysis, alternatives });
  } catch (err) {
    console.error('alternatives handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
