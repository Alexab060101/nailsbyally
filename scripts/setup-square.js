// scripts/setup-square.js
// Crea servicios + variaciones + team member + horario en Square Appointments.
// Idempotente: salta servicios que ya existan por nombre.
//
// USO LOCAL (UNA SOLA VEZ):
//   1. Crea .env.local en la raíz con:
//        SQUARE_ACCESS_TOKEN=...
//        SQUARE_LOCATION_ID=...
//   2. Ejecuta: node scripts/setup-square.js
//   3. Revisa square-output.json (queda en .gitignore) con los IDs creados.
//
// NO se despliega. Es script local.
// Producción de Square: https://connect.squareup.com/v2

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- ENV LOAD (sin dotenv, lectura simple de .env.local) ---
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('❌ Falta .env.local en la raíz del proyecto');
    console.error('   Crea uno con: SQUARE_ACCESS_TOKEN=... y SQUARE_LOCATION_ID=...');
    process.exit(1);
  }
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  });
}
loadEnv();

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const API_BASE = 'https://connect.squareup.com/v2';
const SQ_VERSION = '2024-12-18';

if (!TOKEN || !LOCATION_ID) {
  console.error('❌ Faltan SQUARE_ACCESS_TOKEN o SQUARE_LOCATION_ID en .env.local');
  process.exit(1);
}

// --- HTTP helper ---
async function sq(method, route, body) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Square-Version': SQ_VERSION,
    'Content-Type': 'application/json',
  };
  if (body) headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await fetch(API_BASE + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  if (!res.ok) {
    console.error(`\n❌ Square ${method} ${route} → ${res.status}`);
    console.error(JSON.stringify(json, null, 2));
    throw new Error(`Square API error ${res.status}`);
  }
  return json;
}

// --- DEFINICIONES DE SERVICIOS ---
// 5 servicios base (1 variación c/u) + 3 extensiones (4 variaciones c/u con nail art)
const SERVICES = [
  {
    name: 'Retiro Profesional',
    variations: [{ name: 'Estándar', priceCents: 2000, durationMin: 30 }],
  },
  {
    name: 'Manicura Express',
    variations: [{ name: 'Estándar', priceCents: 2500, durationMin: 30 }],
  },
  {
    name: 'Manicura de Precisión con Color',
    variations: [{ name: 'Estándar', priceCents: 3500, durationMin: 90 }],
  },
  {
    name: 'Pedicura Semipermanente',
    variations: [{ name: 'Estándar', priceCents: 4000, durationMin: 60 }],
  },
  {
    name: 'Relleno 3 semanas',
    variations: [{ name: 'Estándar', priceCents: 3000, durationMin: 90 }],
  },
  {
    name: 'Extensión S',
    variations: [
      { name: 'Natural Nude', priceCents: 3000, durationMin: 120 },
      { name: 'Nail Art 1',   priceCents: 3700, durationMin: 135 },
      { name: 'Nail Art 2',   priceCents: 4200, durationMin: 150 },
      { name: 'Nail Art 3',   priceCents: 4500, durationMin: 180 },
    ],
  },
  {
    name: 'Extensión M',
    variations: [
      { name: 'Natural Nude', priceCents: 4000, durationMin: 120 },
      { name: 'Nail Art 1',   priceCents: 4700, durationMin: 135 },
      { name: 'Nail Art 2',   priceCents: 5200, durationMin: 150 },
      { name: 'Nail Art 3',   priceCents: 5500, durationMin: 180 },
    ],
  },
  {
    name: 'Extensión L',
    variations: [
      { name: 'Natural Nude', priceCents: 4500, durationMin: 120 },
      { name: 'Nail Art 1',   priceCents: 5200, durationMin: 135 },
      { name: 'Nail Art 2',   priceCents: 5700, durationMin: 150 },
      { name: 'Nail Art 3',   priceCents: 6000, durationMin: 180 },
    ],
  },
];

// --- API CALLS ---
async function listExistingServices() {
  const data = await sq('POST', '/catalog/search-catalog-items', {
    product_types: ['APPOINTMENTS_SERVICE'],
  });
  return data.items || [];
}

async function createService(svc) {
  const slug = svc.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const itemId = '#item_' + slug;
  const variations = svc.variations.map((v, i) => ({
    type: 'ITEM_VARIATION',
    id: '#var_' + slug + '_' + i,
    item_variation_data: {
      item_id: itemId,
      name: v.name,
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: v.priceCents, currency: 'EUR' },
      service_duration: v.durationMin * 60 * 1000, // ms
      available_for_booking: true,
    },
  }));
  return sq('POST', '/catalog/object', {
    object: {
      type: 'ITEM',
      id: itemId,
      present_at_all_locations: true,
      item_data: {
        name: svc.name,
        product_type: 'APPOINTMENTS_SERVICE',
        variations,
      },
    },
  });
}

async function ensureTeamMember() {
  const found = await sq('POST', '/team-members/search', {
    query: { filter: { status: 'ACTIVE' } },
  });
  const existing = (found.team_members || []).find(t => t.given_name === 'Ally');
  if (existing) return existing;
  const created = await sq('POST', '/team-members', {
    team_member: {
      given_name: 'Ally',
      assigned_locations: {
        assignment_type: 'EXPLICIT_LOCATIONS',
        location_ids: [LOCATION_ID],
      },
    },
  });
  return created.team_member;
}

async function setBookable(teamMemberId) {
  return sq('PUT', '/bookings/team-member-booking-profiles/' + teamMemberId, {
    team_member_booking_profile: {
      is_bookable: true,
      display_name: 'Ally',
    },
  });
}

async function setBusinessHours() {
  const days = ['MON','TUE','WED','THU','FRI','SAT'];
  const periods = days.map(day => ({
    day_of_week: day,
    start_local_time: '10:00:00',
    end_local_time: '19:00:00',
  }));
  return sq('PUT', '/locations/' + LOCATION_ID, {
    location: { business_hours: { periods } },
  });
}

// --- MAIN ---
async function main() {
  console.log('🟢 Square setup — production');
  console.log('   Location:', LOCATION_ID);

  console.log('\n— Servicios —');
  const existing = await listExistingServices();
  const existingByName = new Map(existing.map(i => [i.item_data.name, i]));
  console.log(`   Encontrados ${existing.length} servicios ya existentes`);

  const result = [];
  for (const svc of SERVICES) {
    if (existingByName.has(svc.name)) {
      const e = existingByName.get(svc.name);
      console.log(`   · saltando (existe): ${svc.name}`);
      result.push({
        name: svc.name,
        item_id: e.id,
        variations: (e.item_data.variations || []).map(v => ({
          name: v.item_variation_data.name,
          variation_id: v.id,
        })),
      });
      continue;
    }
    const created = await createService(svc);
    const item = created.catalog_object;
    console.log(`   + creado: ${svc.name} (${item.id})`);
    result.push({
      name: svc.name,
      item_id: item.id,
      variations: (item.item_data.variations || []).map(v => ({
        name: v.item_variation_data.name,
        variation_id: v.id,
      })),
    });
  }

  console.log('\n— Team Member —');
  const member = await ensureTeamMember();
  console.log(`   ✓ Ally: ${member.id}`);
  await setBookable(member.id);
  console.log('   ✓ marcada como bookable');

  console.log('\n— Horario de la location —');
  await setBusinessHours();
  console.log('   ✓ Lunes-Sábado 10:00–19:00, domingo cerrado');

  // Output para HTML mapping
  const output = {
    generated_at: new Date().toISOString(),
    location_id: LOCATION_ID,
    booking_base: 'https://book.squareup.com/appointments/02ta1zehrirhfw/location/' + LOCATION_ID + '/services',
    services: result,
  };
  const outPath = path.join(__dirname, '..', 'square-output.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('\n✅ Listo. IDs guardados en square-output.json');
  console.log('   (fichero ignorado por git)');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
