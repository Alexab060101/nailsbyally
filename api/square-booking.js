const SQ = 'https://connect.squareup.com/v2';

function sq(path, method, body) {
  return fetch(SQ + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-18'
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(function(r){ return r.json(); });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Normalize names for matching: lowercase, remove accents, collapse spaces
function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const locationId = process.env.SQUARE_LOCATION_ID;

  // ── GET /api/square-booking?action=services ──────────────────────────────
  if (req.method === 'GET' && req.query.action === 'services') {
    try {
      // Fetch all ITEM and ITEM_VARIATION from Square Catalog
      let cursor = null;
      const items = [], variations = [];

      do {
        const url = '/catalog/list?types=ITEM,ITEM_VARIATION' + (cursor ? '&cursor=' + cursor : '');
        const data = await sq(url);
        if (data.errors) return res.status(500).json({ error: data.errors[0].detail });
        (data.objects || []).forEach(function(o) {
          if (o.type === 'ITEM') items.push(o);
          if (o.type === 'ITEM_VARIATION') variations.push(o);
        });
        cursor = data.cursor || null;
      } while (cursor);

      // Build map: variationId → { name, durationMinutes, priceMoney, parentName }
      const itemMap = {};
      items.forEach(function(item) {
        itemMap[item.id] = item.item_data && item.item_data.name || '';
      });

      const services = variations
        .filter(function(v) {
          // Only variations that belong to appointable items
          return v.item_variation_data &&
                 v.item_variation_data.service_duration !== undefined;
        })
        .map(function(v) {
          const d = v.item_variation_data;
          return {
            variationId: v.id,
            variationVersion: v.version,
            parentName: itemMap[d.item_id] || '',
            variationName: d.name || '',
            durationMinutes: Math.round((d.service_duration || 0) / 60000),
            priceMoney: d.price_money || null
          };
        });

      return res.status(200).json({ services: services });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET /api/square-booking?action=availability ───────────────────────────
  if (req.method === 'GET' && req.query.action === 'availability') {
    const { serviceVariationId, date } = req.query;
    if (!serviceVariationId || !date) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    // date = "YYYY-MM-DD", search 08:00–21:00 local (Europe/Madrid = UTC+1/+2)
    // Use UTC to avoid issues; Square returns UTC times
    const startAt = date + 'T06:00:00Z'; // 08:00 Madrid winter / 07:00 summer — Square filters by business hours
    const endAt   = date + 'T21:00:00Z';

    try {
      const data = await sq('/bookings/availability/search', 'POST', {
        query: {
          filter: {
            start_at_range: { start_at: startAt, end_at: endAt },
            location_id: locationId,
            segment_filters: [{
              service_variation_id: serviceVariationId
            }]
          }
        }
      });

      if (data.errors) return res.status(500).json({ error: data.errors[0].detail });

      const slots = (data.availabilities || []).map(function(a) {
        return {
          startAt: a.start_at,
          teamMemberId: (a.appointment_segments && a.appointment_segments[0] && a.appointment_segments[0].team_member_id) || null
        };
      });

      return res.status(200).json({ slots: slots });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET /api/square-booking?action=days ──────────────────────────────────
  // Returns which days of a given month have any availability
  if (req.method === 'GET' && req.query.action === 'days') {
    const { serviceVariationId, year, month } = req.query;
    if (!serviceVariationId || !year || !month) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const y = parseInt(year), m = parseInt(month);
    const firstDay = new Date(Date.UTC(y, m - 1, 1));
    const lastDay  = new Date(Date.UTC(y, m, 0, 23, 59, 59));

    try {
      const data = await sq('/bookings/availability/search', 'POST', {
        query: {
          filter: {
            start_at_range: {
              start_at: firstDay.toISOString(),
              end_at:   lastDay.toISOString()
            },
            location_id: locationId,
            segment_filters: [{
              service_variation_id: serviceVariationId
            }]
          }
        }
      });

      if (data.errors) return res.status(500).json({ error: data.errors[0].detail });

      const days = {};
      (data.availabilities || []).forEach(function(a) {
        const d = a.start_at.slice(0, 10);
        days[d] = true;
      });

      return res.status(200).json({ availableDays: Object.keys(days) });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST /api/square-booking (crear reserva) ─────────────────────────────
  if (req.method === 'POST') {
    const { nombre, telefono, serviceVariationId, serviceVariationVersion, teamMemberId, startAt, durationMinutes } = req.body || {};

    if (!nombre || !telefono || !serviceVariationId || !startAt) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    try {
      // 1. Find or create customer
      let customerId = null;

      const searchRes = await sq('/customers/search', 'POST', {
        query: { filter: { phone_number: { exact: telefono } } }
      });

      if (searchRes.customers && searchRes.customers.length > 0) {
        customerId = searchRes.customers[0].id;
      } else {
        const nameParts = nombre.trim().split(' ');
        const createRes = await sq('/customers', 'POST', {
          given_name:   nameParts[0] || nombre,
          family_name:  nameParts.slice(1).join(' ') || '',
          phone_number: telefono
        });
        if (createRes.errors) return res.status(500).json({ error: createRes.errors[0].detail });
        customerId = createRes.customer.id;
      }

      // 2. Create booking
      const bookingBody = {
        booking: {
          start_at: startAt,
          location_id: locationId,
          customer_id: customerId,
          customer_note: 'Reserva desde nailsbyally.es',
          appointment_segments: [{
            service_variation_id: serviceVariationId,
            team_member_id: teamMemberId || 'TeamMemberBook',
            duration_minutes: durationMinutes || 60
          }]
        },
        idempotency_key: Date.now() + '-' + Math.random().toString(36).slice(2)
      };

      if (serviceVariationVersion) {
        bookingBody.booking.appointment_segments[0].service_variation_version = serviceVariationVersion;
      }

      const bookRes = await sq('/bookings', 'POST', bookingBody);
      if (bookRes.errors) return res.status(500).json({ error: bookRes.errors[0].detail });

      return res.status(200).json({
        ok: true,
        bookingId: bookRes.booking.id,
        startAt:   bookRes.booking.start_at
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
