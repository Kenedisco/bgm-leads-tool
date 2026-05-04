module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const PLACES_KEY    = process.env.GOOGLE_PLACES_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Anthropic API key not configured.' });
  if (!PLACES_KEY)    return res.status(500).json({ error: 'Google Places API key not configured.' });

  const { city, area, venueType, keywords, extraContext } = req.body;
  if (!city) return res.status(400).json({ error: 'City is required.' });

  const location = area ? `${area}, ${city}` : city;

  const venueQueries = {
    all:        ['hotels', 'restaurants cafes'],
    hotel:      ['hotels resorts'],
    restaurant: ['restaurants cafes'],
    bar:        ['bars lounges'],
    retail:     ['retail boutiques'],
    spa:        ['spas wellness'],
  };

  // Only 1-2 queries to stay within timeout
  const queries = (venueQueries[venueType] || venueQueries.all).slice(0, 2);

  async function searchPlaces(query) {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + ' in ' + location)}&key=${PLACES_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') {
      throw new Error('Google Places error: ' + d.status + ' — ' + (d.error_message || ''));
    }
    return (d.results || []).slice(0, 3);
  }

  async function getPlaceDetails(placeId) {
    const fields = 'name,rating,user_ratings_total,reviews,formatted_address,website,formatted_phone_number,types';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${PLACES_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'OK') return null;
    return d.result;
  }

  async function scoreLeads(venues) {
    // Keep payload small — 4 venues max, 2 reviews each, 200 chars per review
    const venueData = venues.slice(0, 4).map(v => ({
      name: v.name,
      type: (v.types || [])[0] || 'venue',
      area: (v.formatted_address || '').split(',').slice(0, 2).join(','),
      rating: v.rating,
      reviewCount: v.user_ratings_total,
      website: v.website || null,
      phone: v.formatted_phone_number || null,
      reviews: (v.reviews || []).slice(0, 2).map(r => ({
        text: (r.text || '').substring(0, 200),
        rating: r.rating
      }))
    }));

    const prompt = `BGM lead scoring for Sound You Can Feel, Dubai. Score these venues based on their Google reviews — look for music/atmosphere complaints (too loud, too quiet, wrong vibe, generic, dead atmosphere, uncomfortable).

HOT 75-100: clear music complaints, premium venue
WARM 45-74: subtle atmosphere issues
COLD 20-44: no complaints but fits profile

WhatsApp opener: 1-2 sentences, confident, specific, no emojis.

VENUES: ${JSON.stringify(venueData)}

Respond with ONLY this JSON structure, nothing else:
{"leads":[{"name":"","type":"","area":"","rating":0,"reviewCount":0,"heat":"","score":0,"website":null,"phone":null,"painPoints":[],"reviews":[{"source":"Google Maps","excerpt":"","sentiment":""}],"whatsappOpener":""}]}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const raw = await r.text();
    if (!r.ok) throw new Error('Anthropic error: ' + r.status + ' — ' + raw.substring(0, 300));

    const parsed = JSON.parse(raw);
    const text = (parsed.content?.[0]?.text || '').trim();

    // Strip markdown if present
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    // Try direct parse first
    try {
      return JSON.parse(clean);
    } catch (_) {
      // Fallback: extract JSON object
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Claude returned non-JSON: ' + clean.substring(0, 300));
      return JSON.parse(match[0]);
    }
  }

  try {
    // Run place searches sequentially to avoid timeout
    const allPlaces = [];
    for (const q of queries) {
      try {
        const results = await searchPlaces(q);
        allPlaces.push(...results);
      } catch (_) {}
    }

    // Deduplicate
    const seen = new Set();
    const uniquePlaces = allPlaces.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    if (!uniquePlaces.length) return res.status(200).json({ leads: [] });

    // Get details for top 4 only — sequentially
    const withDetails = [];
    for (const p of uniquePlaces.slice(0, 4)) {
      try {
        const detail = await getPlaceDetails(p.place_id);
        if (detail) withDetails.push(detail);
      } catch (_) {}
    }

    if (!withDetails.length) return res.status(500).json({ error: 'Could not retrieve venue details.' });

    const result = await scoreLeads(withDetails);

    const order = { hot: 0, warm: 1, cold: 2 };
    result.leads.sort((a, b) => (order[a.heat] ?? 3) - (order[b.heat] ?? 3));

    return res.status(200).json(result);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
