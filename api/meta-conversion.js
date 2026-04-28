// Meta Conversions API — server-side endpoint
// Recibe eventos del navegador y los reenvía a Meta con deduplicación por event_id.
// Lee credenciales de variables de entorno (NUNCA hardcoded).

const crypto = require('crypto');

function sha256(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE; // opcional

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.error('Meta CAPI: missing env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  }

  try {
    const body = req.body || {};
    const event_name = body.event_name;
    const event_id = body.event_id;
    const event_source_url = body.event_source_url;
    const fbp = body.fbp;
    const fbc = body.fbc;
    const custom_data = body.custom_data || {};
    const user_ids = body.user_ids || null;

    if (!event_name || !event_id) {
      return res.status(400).json({ ok: false, error: 'event_name and event_id required' });
    }

    // IP cliente
    const xff = req.headers['x-forwarded-for'] || '';
    const client_ip_address = xff.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || undefined;
    const client_user_agent = req.headers['user-agent'] || undefined;

    // Geo desde headers de Vercel (gratuitos, sin lookup extra)
    const country = req.headers['x-vercel-ip-country'];
    const city = req.headers['x-vercel-ip-city'];
    const zp = req.headers['x-vercel-ip-postal-code'];

    // user_data — Meta acepta IP/UA en plano. PII se hashea con SHA-256.
    const user_data = {};
    if (client_ip_address) user_data.client_ip_address = client_ip_address;
    if (client_user_agent) user_data.client_user_agent = client_user_agent;
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;
    if (country) user_data.country = sha256(country);
    if (city) user_data.ct = sha256(city);
    if (zp) user_data.zp = sha256(zp);

    // PII de usuario (nombre, teléfono) — hasheada SHA-256 para Lead/Purchase
    if (user_ids) {
      // Teléfono: solo dígitos, en formato E.164 sin '+'
      if (user_ids.phone) {
        const phoneDigits = String(user_ids.phone).replace(/[^\d]/g, '');
        if (phoneDigits) user_data.ph = sha256(phoneDigits);
      }
      if (user_ids.firstName) user_data.fn = sha256(user_ids.firstName);
      if (user_ids.lastName)  user_data.ln = sha256(user_ids.lastName);
      if (user_ids.email)     user_data.em = sha256(user_ids.email);
      if (user_ids.country)   user_data.country = sha256(user_ids.country);
    }

    const event = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      action_source: 'website',
      user_data,
    };
    if (event_source_url) event.event_source_url = event_source_url;
    if (custom_data && Object.keys(custom_data).length) event.custom_data = custom_data;

    const payload = { data: [event] };
    if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;

    const url = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
    const metaRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const meta = await metaRes.json();

    if (!metaRes.ok) {
      console.error('Meta CAPI error:', metaRes.status, JSON.stringify(meta));
      return res.status(502).json({ ok: false, error: 'Meta API error', meta });
    }

    return res.status(200).json({ ok: true, meta });
  } catch (err) {
    console.error('CAPI handler error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
};
