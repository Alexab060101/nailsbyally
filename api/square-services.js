// Devuelve la lista pública de servicios bookables de Square (nombre + IDs)
// para que el frontend mapee chips → URL de booking.
// El SQUARE_ACCESS_TOKEN se queda server-side; el navegador solo recibe IDs públicos.

module.exports = async function handler(req, res) {
  const TOKEN = process.env.SQUARE_ACCESS_TOKEN;

  if (!TOKEN) {
    return res.status(500).json({ ok: false, error: 'misconfigured' });
  }

  // Cache 5 min en edge (los IDs no cambian frecuentemente)
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  try {
    const sqRes = await fetch('https://connect.squareup.com/v2/catalog/search-catalog-items', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ product_types: ['APPOINTMENTS_SERVICE'] }),
    });
    const data = await sqRes.json();

    if (!sqRes.ok) {
      console.error('Square catalog error:', sqRes.status);
      return res.status(502).json({ ok: false, error: 'square_api_error' });
    }

    const services = (data.items || []).map(item => ({
      name: item.item_data && item.item_data.name,
      item_id: item.id,
      variations: ((item.item_data && item.item_data.variations) || []).map(v => ({
        name: v.item_variation_data && v.item_variation_data.name,
        variation_id: v.id,
      })),
    })).filter(s => s.name);

    return res.status(200).json({ ok: true, services });
  } catch (err) {
    console.error('square-services error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
};
