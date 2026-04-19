const BASE_ID    = 'appTUc7K43I0Gcg1';
const TABLE_NAME = 'Clientas';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { nombre, telefono, servicio, comentario } = req.body;
  const token = process.env.AIRTABLE_TOKEN;

  if (!token) {
    return res.status(500).json({ error: 'AIRTABLE_TOKEN no configurado' });
  }

  try {
    const airtableRes = await fetch(
      'https://api.airtable.com/v0/' + BASE_ID + '/' + encodeURIComponent(TABLE_NAME),
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'Nombre':    nombre    || 'Desconocida',
            'Teléfono': telefono  || '',
            'Tipo':     'Nueva',
            'Fuente':   'Web',
            'Notas':    'Servicio: ' + (servicio || '') + ' | Comentario: ' + (comentario || '')
          }
        })
      }
    );

    if (!airtableRes.ok) {
      const err = await airtableRes.text();
      return res.status(airtableRes.status).json({ error: err });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
