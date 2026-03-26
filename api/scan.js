module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { city, area, venueType, keywords, extraContext } = req.body;

  if (!city) {
    return res.status(400).json({ error: 'City is required.' });
  }

  const location = area ? `${area}, ${city}` : city;
  const venueDesc = venueType === 'all'
    ? 'hotels, restaurants, bars, cafes, retail stores, spas'
    : venueType;

  const prompt = `You are a B2B lead intelligence tool for Sound You Can Feel (SYCF), a premium sonic branding and background music consultancy based in Dubai, run by Kennedy Stephenson with 25 years of experience working with Marriott, Dior, Bvlgari and Jumeirah.

Your task: Generate 6 realistic, highly plausible BGM (background music) leads for ${venueDesc} venues in ${location}.

These leads are based on the kind of reviews that actually appear on Google Maps, TripAdvisor, Booking.com, Zomato, Yelp, Talabat, OpenTable and Foursquare for real venues in this area. Use your knowledge of real venues, real review patterns, and real complaints that hospitality businesses receive about their music and atmosphere.

Keywords to look for: ${(keywords || []).join(', ')}
${extraContext ? 'Additional context: ' + extraContext : ''}

For each lead, create a realistic venue with plausible details for this specific location. Score each lead:
- HOT: Multiple negative music/atmosphere mentions, clear pain, premium venue (score 75-100)
- WARM: 1-2 music mentions, mid-tier venue, potential interest (score 45-74)
- COLD: Subtle atmosphere mentions, smaller venue, lower priority (score 20-44)

Distribute across: 2 hot, 2 warm, 2 cold leads.

Sources to simulate reviews from: Google Maps, TripAdvisor, Booking.com, Zomato, Yelp, Talabat, OpenTable, Foursquare.

Return ONLY valid JSON, no markdown, no explanation, no preamble:
{
  "leads": [
    {
      "name": "venue name",
      "type": "hotel|restaurant|bar|retail|spa",
      "area": "specific area/neighbourhood",
      "rating": 4.2,
      "reviewCount": 847,
      "heat": "hot|warm|cold",
      "score": 85,
      "painPoints": ["too loud at dinner service", "wrong genre for brand positioning"],
      "reviews": [
        {
          "source": "TripAdvisor",
          "excerpt": "realistic review excerpt mentioning music or atmosphere issue, 1-2 sentences",
          "sentiment": "negative|mixed"
        },
        {
          "source": "Google Maps",
          "excerpt": "second realistic review excerpt",
          "sentiment": "negative|mixed"
        }
      ],
      "whatsappOpener": "personalised WhatsApp opening message Kennedy Stephenson would send to this specific venue referencing their exact issue. Professional, confident, no emojis, max 3 sentences. Reference a specific detail about their space or reviews."
    }
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const rawText = await response.text();

    if (!response.ok) {
      let errMsg = 'Anthropic API error ' + response.status;
      try { errMsg = JSON.parse(rawText)?.error?.message || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }

    let data;
    try { data = JSON.parse(rawText); } catch (_) {
      return res.status(500).json({ error: 'Unexpected response from Anthropic API.' });
    }

    const raw = data.content?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json[\s\S]*?```|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); } catch (_) {
      return res.status(500).json({ error: 'Model returned invalid JSON. Try again.' });
    }

    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
