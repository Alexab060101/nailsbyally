const SQ_BASE = process.env.SQUARE_SANDBOX === 'true'
  ? 'https://connect.squareupsandbox.com/v2'
  : 'https://connect.squareup.com/v2';

async function sq(path, method, body) {
  const r = await fetch(SQ_BASE + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + (process.env.SQUARE_ACCESS_TOKEN_PRODU || process.env.SQUARE_ACCESS_TOKEN),
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-18'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await r.json();
  if (!r.ok) {
    const detail = (json.errors && json.errors[0] && json.errors[0].detail) || JSON.stringify(json);
    throw new Error('[Square ' + r.status + '] ' + detail);
  }
  return json;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const locationId = process.env.SQUARE_LOCATION_ID;

  // ── GET ?action=locations (diagnóstico) ─────────────────────────────────
  if (req.method === 'GET' && req.query.action === 'locations') {
    try {
      const data = await sq('/locations');
      const locs = (data.locations || []).map(function(l) {
        return { id: l.id, name: l.name, status: l.status };
      });
      return res.status(200).json({ locations: locs });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ?action=services ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.query.action === 'services') {
    try {
      let cursor = null;
      const items = [], variations = [];

      do {
        const url = '/catalog/list?types=ITEM,ITEM_VARIATION' + (cursor ? '&cursor=' + cursor : '');
        const data = await sq(url);
        (data.objects || []).forEach(function(o) {
          if (o.type === 'ITEM') items.push(o);
          if (o.type === 'ITEM_VARIATION') variations.push(o);
        });
        cursor = data.cursor || null;
      } while (cursor);

      const itemMap = {};
      items.forEach(function(item) {
        itemMap[item.id] = (item.item_data && item.item_data.name) || '';
      });

      // Return ALL variations — name matching handles relevance
      const services = variations
        .filter(function(v) { return v.item_variation_data; })
        .map(function(v) {
          const d = v.item_variation_data;
          const durMs = d.service_duration;
          return {
            variationId:      v.id,
            variationVersion: v.version,
            parentName:       itemMap[d.item_id] || '',
            variationName:    d.name || '',
            durationMinutes:  durMs != null ? Math.round(durMs / 60000) : null,
            priceMoney:       d.price_money || null
          };
        });

      return res.status(200).json({ services: services });
    } catch(e) {
      console.error('[square-booking /services]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ?action=days ─────────────────────────────────────────────────────
  if (req.method === 'GET' && req.query.action === 'days') {
    const { serviceVariationId, year, month } = req.query;
    if (!serviceVariationId || !year || !month) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const y = parseInt(year), m = parseInt(month);
    const monthStart = new Date(Date.UTC(y, m - 1, 1));
    const now        = new Date();
    const firstDay   = monthStart > now ? monthStart : now;
    const lastDay    = new Date(Date.UTC(y, m, 0, 23, 59, 59));

    try {
      const data = await sq('/bookings/availability/search', 'POST', {
        query: {
          filter: {
            start_at_range: {
              start_at: firstDay.toISOString(),
              end_at:   lastDay.toISOString()
            },
            location_id: locationId,
            segment_filters: [{ service_variation_id: serviceVariationId }]
          }
        }
      });

      const days = {};
      (data.availabilities || []).forEach(function(a) {
        days[a.start_at.slice(0, 10)] = true;
      });

      return res.status(200).json({ availableDays: Object.keys(days) });
    } catch(e) {
      console.error('[square-booking /days]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ?action=availability ─────────────────────────────────────────────
  if (req.method === 'GET' && req.query.action === 'availability') {
    const { serviceVariationId, date } = req.query;
    if (!serviceVariationId || !date) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const startAt = date + 'T06:00:00Z';
    const endAt   = date + 'T21:00:00Z';

    try {
      const data = await sq('/bookings/availability/search', 'POST', {
        query: {
          filter: {
            start_at_range: { start_at: startAt, end_at: endAt },
            location_id: locationId,
            segment_filters: [{ service_variation_id: serviceVariationId }]
          }
        }
      });

      const slots = (data.availabilities || []).map(function(a) {
        const seg = a.appointment_segments && a.appointment_segments[0];
        return {
          startAt:      a.start_at,
          teamMemberId: seg && seg.team_member_id || null
        };
      });

      return res.status(200).json({ slots: slots });
    } catch(e) {
      console.error('[square-booking /availability]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST (crear reserva) ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { nombre, telefono, serviceVariationId, serviceVariationVersion, teamMemberId, startAt, durationMinutes } = req.body || {};

    if (!nombre || !telefono || !serviceVariationId || !startAt) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    try {
      // Find or create customer
      let customerId = null;
      try {
        const searchRes = await sq('/customers/search', 'POST', {
          query: { filter: { phone_number: { exact: telefono } } }
        });
        if (searchRes.customers && searchRes.customers.length > 0) {
          customerId = searchRes.customers[0].id;
        }
      } catch(_) { /* will create below */ }

      if (!customerId) {
        const nameParts = nombre.trim().split(' ');
        const createRes = await sq('/customers', 'POST', {
          given_name:   nameParts[0] || nombre,
          family_name:  nameParts.slice(1).join(' ') || '',
          phone_number: telefono
        });
        customerId = createRes.customer.id;
      }

      // Build booking segment
      const segment = {
        service_variation_id: serviceVariationId,
        team_member_id:       teamMemberId || 'ANY'
      };
      if (serviceVariationVersion) segment.service_variation_version = Number(serviceVariationVersion);
      if (durationMinutes)         segment.duration_minutes = Number(durationMinutes);

      const bookRes = await sq('/bookings', 'POST', {
        idempotency_key: Date.now() + '-' + Math.random().toString(36).slice(2),
        booking: {
          start_at:    startAt,
          location_id: locationId,
          customer_id: customerId,
          customer_note: 'Reserva desde nailsbyally.es',
          appointment_segments: [segment]
        }
      });

      return res.status(200).json({
        ok:        true,
        bookingId: bookRes.booking.id,
        startAt:   bookRes.booking.start_at
      });
    } catch(e) {
      console.error('[square-booking /create]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
