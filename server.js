const fastify = require('fastify')({ logger: true });
fastify.register(require('@fastify/cors'), { 
  origin: '*'
});
// --------------------
const Database = require('better-sqlite3');
const path = require('path');
const OpenAI = require('openai');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
    intent TEXT DEFAULT NULL, -- 'aprender' | 'sistemas' | 'info' | 'desconfianza' | NULL
    score INTEGER DEFAULT 0, -- 0-10 scoring automático
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

// 📊 API: Estadísticas del Día (FASE 3 - Dashboard)
fastify.get('/stats/today', async (request, reply) => {
  const today = new Date().toISOString().split('T')[0];
  
  const stats = db.prepare(`
    SELECT 
      COALESCE(ig_messages_sent, 0) as ig_enviados,
      COALESCE(wa_messages_sent, 0) as wa_enviados
    FROM daily_stats 
    WHERE date = ?
  `).get(today) || { ig_enviados: 0, wa_enviados: 0 };
  
  const total_leads = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  const respondieron = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'respondio'").get();
  
  return {
    mensajes_enviados: stats.ig_enviados + stats.wa_enviados,
    respuestas_ia: respondieron.count,
    total_leads: total_leads.count,
    fecha: today
  };
});
// 📋 API: Obtener Leads (CRM)
fastify.get('/leads', async (request, reply) => {
  const { status } = request.body || request.query || {}; 
  let query = 'SELECT * FROM leads';
  const params = [];
  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }
  query += ' ORDER BY last_contacted_at DESC LIMIT 50';
  const leads = db.prepare(query).all(...params);
  return leads;
});

// 🔥 API: Obtener Leads Calientes (score >= 6)
fastify.get('/leads/hot', async (request, reply) => {
  const leads = db.prepare('SELECT * FROM leads WHERE score >= 6 ORDER BY score DESC, last_contacted_at DESC LIMIT 20').all();
  return leads;
});

// 🤖 API: Clasificar Intención del Lead
fastify.post('/ai/classify-intent', async (request, reply) => {
  const { message, handle, platform } = request.body;
  
  if (!message) {
    return reply.code(400).send({ error: 'message is required' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Sos un clasificador de intenciones para leads de trading/inversiones. 
Clasificá el mensaje en UNA de estas categorías:
- "aprender": quiere aprender a operar/tradear
- "sistemas": quiere sistemas automatizados/managed accounts
- "info": solo curiosidad, pidiendo info general
- "desconfianza": menciona estafas, desconfianza, miedo
- "tiene_broker": ya opera o tiene broker
- "sin_capital": no tiene dinero para invertir
- "promesas": busca ganancias garantizadas o números mágicos

Respondé SOLO con la categoría, nada más.`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0.3,
      max_tokens: 20
    });

    const intent = completion.choices[0].message.content.trim().toLowerCase();
    
    // Actualizar intent en la DB si se proveyó handle y platform
    if (handle && platform) {
      const id = `${platform}_${handle}`;
      db.prepare('UPDATE leads SET intent = ? WHERE id = ?').run(intent, id);
    }

    return { intent, message };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'OpenAI API error', details: error.message });
  }
});

// 💬 API: Generar Respuesta Personalizada
fastify.post('/ai/generate-response', async (request, reply) => {
  const { lead_context, user_message, intent } = request.body;
  
  if (!user_message) {
    return reply.code(400).send({ error: 'user_message is required' });
  }

  try {
    const systemPrompt = `Rol: Sos un asesor senior de One Percent. Tu función NO es vender, es iniciar conversaciones naturales, calificar interés y derivar solo a leads de alta intención.
Tono: Humano, cercano, profesional, cero presión. Escribís como una persona real, no como un bot ni vendedor agresivo.
Objetivo: Detectar si la persona tiene interés REAL en automatizar operaciones, generar ingresos con sistemas asistidos, o aprender trading profesional.

REGLAS CLAVE:
1. NUNCA hables de precios ni hagas ofertas
2. NUNCA envíes links en el primer mensaje
3. NUNCA pidas una llamada en el primer mensaje
4. Máximo 2 preguntas por mensaje
5. Mensajes cortos (máximo 3 líneas)
6. Si no hay interés real, cerrás con respeto

Intención detectada: ${intent || 'desconocida'}

Contexto del lead: ${JSON.stringify(lead_context || {})}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user_message }
      ],
      temperature: 0.7,
      max_tokens: 150
    });

    const response = completion.choices[0].message.content.trim();
    return { response, intent };
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'OpenAI API error', details: error.message });
  }
});

// 📊 API: Actualizar Score del Lead
fastify.post('/leads/update-score', async (request, reply) => {
  const { platform, handle, intent, has_capital, responds_fast } = request.body;
  
  if (!platform || !handle) {
    return reply.code(400).send({ error: 'platform and handle are required' });
  }

  // Calcular score (0-10)
  let score = 0;
  
  // Intent scoring
  if (intent === 'sistemas') score += 3;
  else if (intent === 'aprender') score += 2;
  else if (intent === 'tiene_broker') score += 2;
  else if (intent === 'promesas') score -= 3;
  else if (intent === 'sin_capital') score -= 2;
  
  // Behavioral scoring
  if (has_capital) score += 3;
  if (responds_fast) score += 1;
  
  // Get lead to check interaction count
  const id = `${platform}_${handle}`;
  const lead = db.prepare('SELECT interaction_count FROM leads WHERE id = ?').get(id);
  
  if (lead && lead.interaction_count >= 2) score += 1; // Engagement bonus
  
  // Clamp score 0-10
  score = Math.max(0, Math.min(10, score));
  
  // Update DB
  db.prepare('UPDATE leads SET score = ? WHERE id = ?').run(score, id);
  
  return { score, id };
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


 "Add AI endpoints for intent classification and scoring"



