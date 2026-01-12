const fastify = require('fastify')({ logger: true });
const Database = require('better-sqlite3');
const path = require('path');

// En producción (EasyPanel), usaríamos volúmenes persistentes o conectaríamos a Postgres.
// Para este MVP, usamos SQLite local en el contenedor.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'guardian.db');
const db = new Database(dbPath);

// Configuración
const MAX_DAILY_MESSAGES_IG = 30; // 30-40 safe zone
const MIN_DELAY_SECONDS = 300; // 5 minutos entre mensajes mínimo por seguridad general en ráfagas (ajustable)

// Inicializar DB
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL, -- 'instagram' | 'whatsapp'
    handle TEXT NOT NULL,   -- @usuario o telefono
    status TEXT DEFAULT 'nuevo',
    interaction_count INTEGER DEFAULT 0,
    last_contacted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY, -- YYYY-MM-DD
    ig_messages_sent INTEGER DEFAULT 0,
    wa_messages_sent INTEGER DEFAULT 0
  );
`);

// API: Verificar si puedo contactar
fastify.post('/can-contact', async (request, reply) => {
  const { platform, handle } = request.body;
  const today = new Date().toISOString().split('T')[0];

  // 1. Verificar Estadísticas Diarias
  const stats = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today) || { ig_messages_sent: 0, wa_messages_sent: 0 };
  
  if (platform === 'instagram' && stats.ig_messages_sent >= MAX_DAILY_MESSAGES_IG) {
    return { sensitive: true, allowed: false, reason: 'daily_limit_reached', current: stats.ig_messages_sent, max: MAX_DAILY_MESSAGES_IG };
  }

  // 2. Verificar Estado del Lead
  // Generar ID único basado en handle y plataforma
  const id = `${platform}_${handle}`;
  let lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

  if (!lead) {
    // Lead nuevo
    return { allowed: true, status: 'new', reason: 'clean_slate' };
  }

  if (lead.status === 'stop' || lead.status === 'dnd') {
    return { allowed: false, reason: 'lead_opt_out' };
  }
  
  if (lead.status === 'respondio') {
    return { allowed: true, reason: 'ongoing_conversation' }; // Si ya respondió, la IA toma el control sin límites de "cold outreach"
  }

  // Regla de Follow-up: Solo si pasaron 24h
  if (lead.last_contacted_at) {
    const last = new Date(lead.last_contacted_at);
    const now = new Date();
    const diffHours = (now - last) / (1000 * 60 * 60);
    if (diffHours < 24) {
      return { allowed: false, reason: 'too_soon_for_followup', wait_hours: 24 - diffHours };
    }
  }

  return { allowed: true, status: lead.status };
});

// API: Registrar Intento Exitoso (Llamar ESTO cuando n8n envíe el mensaje)
fastify.post('/log-attempt', async (request, reply) => {
  const { platform, handle, new_status } = request.body;
  const today = new Date().toISOString().split('T')[0];
  const id = `${platform}_${handle}`;

  const tx = db.transaction(() => {
    // Update Lead
    const exists = db.prepare('SELECT id FROM leads WHERE id = ?').get(id);
    if (!exists) {
      db.prepare('INSERT INTO leads (id, platform, handle, status, interaction_count, last_contacted_at) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)').run(id, platform, handle, new_status || 'primer_mensaje_enviado');
    } else {
      db.prepare('UPDATE leads SET interaction_count = interaction_count + 1, last_contacted_at = CURRENT_TIMESTAMP, status = ? WHERE id = ?').run(new_status || 'followup_enviado', id);
    }

    // Update Stats
    db.prepare(`INSERT INTO daily_stats (date, ${platform === 'instagram' ? 'ig_messages_sent' : 'wa_messages_sent'}) VALUES (?, 1) 
      ON CONFLICT(date) DO UPDATE SET ${platform === 'instagram' ? 'ig_messages_sent = ig_messages_sent + 1' : 'wa_messages_sent = wa_messages_sent + 1'}`).run(today);
  });

  tx();
  return { success: true };
});

// API: Actualizar Estado (Webhook desde Respuesta)
fastify.post('/update-status', async (request, reply) => {
  const { platform, handle, status } = request.body;
  const id = `${platform}_${handle}`;
  
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
  return { success: true };
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log(`Guardian activado en http://0.0.0.0:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
