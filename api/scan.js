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
    all:        ['hotels', 'restaurants', 'cafes', 'retail stores', 'bars', 'spas'],
    hotel:      ['hotels', 'resorts', 'boutique hotels'],
    restaurant: ['restaurants', 'cafes', 'dining'],
    bar:        ['bars', 'lounges', 'nightlife'],
    retail:     ['retail stores', 'boutiques', 'fashion stores'],
    spa:        ['spas', 'wellness centers'],
  };

  const queries = (venueQueries[venueType] || venueQueries.all).slice(0, 3);

  async function searchPlaces(query) {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + ' in ' + location)}&key=${PLACES_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') {
      throw new Error('Google Places error: ' + d.status + ' — ' + (d.error_message || ''));
    }
    return (d.results || []).slice(0, 4);
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
    const venueData = venues.map(v => ({
      name: v.name,
      type: v.types?.[0] || 'venue',
      address: v.formatted_address,
      rating: v.rating,
      reviewCount: v.user_ratings_total,
      website: v.website,
      phone: v.formatted_phone_number,
      reviews: (v.reviews || []).map(r => ({
        text: r.text,
        rating: r.rating,
        source: 'Google Maps'
      }))
    }));

    const prompt = `You are a BGM lead scoring tool for Sound You Can Feel (SYCF), a bespoke background music consultancy based in Dubai run by Kennedy Stephenson.

Below are REAL venues with REAL Google reviews. Analyse each venue's reviews for signals that they need better background music — complaints about atmosphere, music being too loud/quiet/wrong/generic, dead vibe, uncomfortable environment, or any mention of music/ambiance.

Keywords to watch for: ${(keywords || []).join(', ')}
${extraContext ? 'Context: ' + extraContext : ''}

Score each venue:
- HOT (75-100): Clear music/atmosphere complaints in reviews, premium venue
- WARM (45-74): Subtle atmosphere issues, mid-tier venue, potential interest
- COLD (20-44): No music complaints but fits the target profile

For the WhatsApp opener: write what Kennedy would actually send — confident, direct, references something specific about the venue or their reviews. Max 2-3 sentences. No emojis. No "I hope this message finds you well."

VENUES DATA:
${JSON.stringify(venueData, null, 2)}

Return ONLY valid JSON, no markdown:
{
  "leads": [
    {
      "name": "exact venue name",
      "type": "hotel|restaurant|bar|retail|spa|cafe",
      "area": "neighbourhood from address",
      "rating": 4.2,
      "reviewCount": 847,
      "heat": "hot|warm|cold",
      "score": 85,
      "website": "url or null",
      "phone": "phone or null",
      "painPoints": ["specific pain point from actual reviews"],
      "reviews": [
        {
          "source": "Google Maps",
          "excerpt": "relevant excerpt from the actual review text, max 2 sentences",
          "sentiment": "negative|mixed"
        }
      ],
      "whatsappOpener": "Kennedy's personalised opening message"
    }
  ]
}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const raw = await r.text();
    if (!r.ok) throw new Error('Anthropic error: ' + r.status);

    const parsed = JSON.parse(raw);
    const text = parsed.content?.[0]?.text?.trim() || '';
    const clean = text.replace(/```json[\s\S]*?```|```/g, '').trim();
    return JSON.parse(clean);
  }

  try {
    const searchResults = await Promise.all(queries.map(q => searchPlaces(q).catch(() => [])));
    const allPlaces = searchResults.flat();

    const seen = new Set();
    const uniquePlaces = allPlaces.filter(p => {
      if (seen.has(p.place_id)) return false;
      seen.add(p.place_id);
      return true;
    });

    if (!uniquePlaces.length) return res.status(200).json({ leads: [] });

    const top = uniquePlaces.slice(0, 8);
    const detailed = await Promise.all(top.map(p => getPlaceDetails(p.place_id).catch(() => null)));
    const withDetails = detailed.filter(Boolean);

    if (!withDetails.length) return res.status(500).json({ error: 'Could not retrieve venue details from Google Places.' });

    const result = await scoreLeads(withDetails);

    const order = { hot: 0, warm: 1, cold: 2 };
    result.leads.sort((a, b) => (order[a.heat] ?? 3) - (order[b.heat] ?? 3));

    return res.status(200).json(result);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
