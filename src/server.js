const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'servicedesk-pi-secret-change-me-' + Date.now();
const DB_PATH = path.join(__dirname, '..', 'db', 'servicedesk.db');

if (!fs.existsSync(DB_PATH)) {
  console.log('⚠️  Datenbank nicht gefunden. Führe Setup aus...');
  require('./setup-db');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Email tables
db.exec(`
  CREATE TABLE IF NOT EXISTS email_config (
    id INTEGER PRIMARY KEY,
    smtp_host TEXT DEFAULT '',
    smtp_port INTEGER DEFAULT 587,
    smtp_user TEXT DEFAULT '',
    smtp_pass TEXT DEFAULT '',
    smtp_secure INTEGER DEFAULT 0,
    imap_host TEXT DEFAULT '',
    imap_port INTEGER DEFAULT 993,
    imap_user TEXT DEFAULT '',
    imap_pass TEXT DEFAULT '',
    from_name TEXT DEFAULT 'ServiceDesk Pro',
    from_email TEXT DEFAULT '',
    notifications_enabled INTEGER DEFAULT 1,
    auto_ticket_enabled INTEGER DEFAULT 1,
    poll_interval INTEGER DEFAULT 5,
    connection_type TEXT DEFAULT 'imap',
    ms_tenant_id TEXT DEFAULT '',
    ms_client_id TEXT DEFAULT '',
    ms_client_secret TEXT DEFAULT '',
    ms_mailbox TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO email_config (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS email_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE,
    from_email TEXT,
    from_name TEXT,
    subject TEXT,
    body TEXT,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP,
    ticket_id INTEGER REFERENCES tickets(id),
    processed INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER REFERENCES tickets(id),
    direction TEXT,
    to_email TEXT,
    from_email TEXT,
    subject TEXT,
    body TEXT,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent'
  );
`);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(morgan('short'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ===== AUTH MIDDLEWARE =====
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nicht autorisiert' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Token ungültig' }); }
};
const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins' });
  next();
};

const paginate = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  return { page, limit, offset: (page - 1) * limit };
};

const nextNumber = (prefix) => {
  const tbl = { TK: 'tickets', INC: 'incidents', AST: 'assets', CHG: 'changes' };
  const col = { TK: 'ticket_number', INC: 'incident_number', AST: 'asset_tag', CHG: 'change_number' };
  const last = db.prepare(`SELECT ${col[prefix]} as num FROM ${tbl[prefix]} ORDER BY id DESC LIMIT 1`).get();
  if (!last) return `${prefix}-001`;
  return `${prefix}-${String(parseInt(last.num.split('-')[1]) + 1).padStart(3, '0')}`;
};

// ===== EMAIL HELPERS =====
function getEmailConfig() {
  return db.prepare('SELECT * FROM email_config WHERE id = 1').get();
}

async function createTransport() {
  const cfg = getEmailConfig();
  if (!cfg.smtp_host || !cfg.smtp_user) return null;
  const port = parseInt(cfg.smtp_port) || 587;
  // Port 465 = direktes SSL/TLS, Port 587/25 = STARTTLS
  const secure = port === 465;
  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port: port,
    secure: secure,
    ...(port === 587 ? { requireTLS: true } : {}),
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    tls: { rejectUnauthorized: false }
  });
}

async function sendMail(to, subject, html, ticketId = null) {
  const cfg = getEmailConfig();
  if (!cfg.notifications_enabled || !cfg.smtp_host) return;
  try {
    const transport = await createTransport();
    if (!transport) return;
    await transport.sendMail({ from: `"${cfg.from_name}" <${cfg.from_email}>`, to, subject, html });
    db.prepare('INSERT INTO email_log (ticket_id, direction, to_email, from_email, subject, body, status) VALUES (?,?,?,?,?,?,?)').run(ticketId, 'sent', to, cfg.from_email, subject, html, 'sent');
  } catch (err) {
    console.error('E-Mail Fehler:', err.message);
    db.prepare('INSERT INTO email_log (ticket_id, direction, to_email, from_email, subject, body, status) VALUES (?,?,?,?,?,?,?)').run(ticketId, 'sent', to, cfg.from_email, subject, html, 'failed');
  }
}


// ===== MIME BODY EXTRACTOR =====
function decodePart(body, headers) {
  const isQP = headers.includes('quoted-printable');
  const isB64 = headers.includes('base64');
  if (isQP) return decodeQP(body);
  if (isB64) { try { return Buffer.from(body.replace(/\s/g,''),'base64').toString('utf-8'); } catch(e) {} }
  return body;
}

function extractBody(source) {
  const raw = source.toString();
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) {
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return raw.slice(0, 3000);
    const hdrs = raw.slice(0, headerEnd).toLowerCase();
    const body = raw.slice(headerEnd + 4);
    return decodePart(body, hdrs).slice(0, 8000);
  }
  const boundary = '--' + boundaryMatch[1].trim();
  const parts = raw.split(boundary);
  let html = '', text = '';
  // Map of CID -> base64 data URI for inline images
  const cidMap = {};

  for (const part of parts) {
    if (!part || part === '--' || part.trim() === '--') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd);
    const headers = rawHeaders.toLowerCase();
    let body = part.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);

    // Extract inline images with Content-ID
    const cidMatch = rawHeaders.match(/Content-ID:\s*<([^>]+)>/i);
    const ctMatch = rawHeaders.match(/Content-Type:\s*([^;\r\n]+)/i);
    if (cidMatch && ctMatch && headers.includes('base64')) {
      const cid = cidMatch[1].trim();
      const mime = ctMatch[1].trim();
      const b64 = body.replace(/\s/g, '');
      cidMap[cid] = `data:${mime};base64,${b64}`;
      continue;
    }

    const decoded = decodePart(body, headers);
    if (headers.includes('text/html') && !html) html = decoded;
    else if (headers.includes('text/plain') && !text) text = decoded;
  }

  // Replace cid: references with data URIs
  let result = html || (text ? text.replace(/\n/g, '<br>') : raw.slice(0, 3000));
  for (const [cid, dataUri] of Object.entries(cidMap)) {
    result = result.split(`cid:${cid}`).join(dataUri);
  }
  return result.slice(0, 65536); // 64KB limit
}
function decodeQP(s) {
  return s.replace(/=\r\n/g,'').replace(/=([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
}

async function pollImap() {
  const cfg = getEmailConfig();
  if (!cfg.auto_ticket_enabled || !cfg.imap_host || !cfg.imap_user) return;
  const client = new ImapFlow({
    host: cfg.imap_host, port: cfg.imap_port, secure: true,
    auth: { user: cfg.imap_user, pass: cfg.imap_pass },
    logger: false
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    for await (const msg of client.fetch('1:*', { envelope: true, bodyStructure: true, source: true })) {
      const msgId = msg.envelope.messageId;
      if (!msgId) continue;
      const exists = db.prepare('SELECT id FROM email_inbox WHERE message_id = ?').get(msgId);
      if (exists) continue;

      const fromAddr = msg.envelope.from?.[0];
      const fromEmail = fromAddr?.address || '';
      const fromName = fromAddr?.name || fromAddr?.address || '';
      const subject = msg.envelope.subject || '(Kein Betreff)';
      const body = msg.source ? extractBody(msg.source) : '';
      const received = msg.envelope.date?.toISOString() || new Date().toISOString();

      const result = db.prepare('INSERT INTO email_inbox (message_id, from_email, from_name, subject, body, received_at) VALUES (?,?,?,?,?,?)').run(msgId, fromEmail, fromName, subject, body, received);

      if (cfg.auto_ticket_enabled) {
        const ticketNum = nextNumber('TK');
        const tkResult = db.prepare(`INSERT INTO tickets (ticket_number, title, description, priority, category, requester_name, requester_email, requester_type, created_by) VALUES (?,?,?,?,?,?,?,?,1)`)
          .run(ticketNum, subject.substring(0, 200), body.substring(0, 8000), 'medium', 'E-Mail', fromName || fromEmail, fromEmail, 'external');
        db.prepare('UPDATE email_inbox SET ticket_id = ?, processed = 1 WHERE id = ?').run(tkResult.lastInsertRowid, result.lastInsertRowid);
        console.log(`📧 Ticket ${ticketNum} aus E-Mail erstellt: ${subject}`);
      }
    }
    await client.logout();
  } catch (err) {
    console.error('IMAP Fehler:', err.message);
  }
}

// ===== MICROSOFT GRAPH API =====
async function getGraphToken(cfg) {
  const url = `https://login.microsoftonline.com/${cfg.ms_tenant_id}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.ms_client_id,
    client_secret: cfg.ms_client_secret,
    scope: 'https://graph.microsoft.com/.default'
  });
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token-Fehler');
  return data.access_token;
}

async function pollGraph() {
  const cfg = getEmailConfig();
  if (!cfg.auto_ticket_enabled || !cfg.ms_tenant_id || !cfg.ms_client_id || !cfg.ms_mailbox) return;
  try {
    const token = await getGraphToken(cfg);
    const mailbox = encodeURIComponent(cfg.ms_mailbox);
    const url = `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/inbox/messages?$filter=isRead eq false&$top=50&$select=id,subject,from,body,receivedDateTime,internetMessageId`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Graph Fehler'); }
    const data = await res.json();
    for (const msg of (data.value || [])) {
      const msgId = msg.internetMessageId || msg.id;
      const exists = db.prepare('SELECT id FROM email_inbox WHERE message_id = ?').get(msgId);
      if (exists) continue;
      const fromEmail = msg.from?.emailAddress?.address || '';
      const fromName = msg.from?.emailAddress?.name || fromEmail;
      const subject = msg.subject || '(Kein Betreff)';
      const body = msg.body?.content || '';
      const received = msg.receivedDateTime || new Date().toISOString();
      const result = db.prepare('INSERT INTO email_inbox (message_id, from_email, from_name, subject, body, received_at) VALUES (?,?,?,?,?,?)').run(msgId, fromEmail, fromName, subject, body, received);
      // Mark as read
      await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${msg.id}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true })
      });
      if (cfg.auto_ticket_enabled) {
        const ticketNum = nextNumber('TK');
        const tkResult = db.prepare(`INSERT INTO tickets (ticket_number, title, description, priority, category, requester_name, requester_email, requester_type, created_by) VALUES (?,?,?,?,?,?,?,?,1)`)
          .run(ticketNum, subject.substring(0, 200), body.replace(/<[^>]*>/g, '').substring(0, 2000), 'medium', 'E-Mail', fromName || fromEmail, fromEmail, 'external');
        db.prepare('UPDATE email_inbox SET ticket_id = ?, processed = 1 WHERE id = ?').run(tkResult.lastInsertRowid, result.lastInsertRowid);
        console.log(`📧 [Graph] Ticket ${ticketNum} aus E-Mail: ${subject}`);
      }
    }
  } catch (err) { console.error('Graph Fehler:', err.message); }
}

async function pollMail() {
  const cfg = getEmailConfig();
  if (cfg && cfg.connection_type === 'graph') return pollGraph();
  return pollImap();
}

// Dynamisches Poll-Intervall (konfigurierbar)
let _pollTimer = null;
function startPollTimer() {
  if (_pollTimer) clearInterval(_pollTimer);
  const cfg = getEmailConfig();
  const minutes = cfg ? (parseInt(cfg.poll_interval) || 5) : 5;
  _pollTimer = setInterval(pollMail, minutes * 60 * 1000);
  console.log(`[IMAP] Polling alle ${minutes} Minuten`);
}
startPollTimer();
setTimeout(pollMail, 5000); // Beim Start

// ===== AUTH ROUTES =====
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.full_name }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, username: user.username, name: user.full_name, role: user.role, email: user.email } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, email, full_name, role, department, phone FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// ===== DASHBOARD =====
app.get('/api/dashboard', auth, (req, res) => {
  const openTickets = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status IN ('open','inProgress','pending')").get().c;
  const resolvedToday = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'resolved' AND DATE(resolved_at) = DATE('now')").get().c;
  const activeIncidents = db.prepare("SELECT COUNT(*) as c FROM incidents WHERE status IN ('open','inProgress')").get().c;
  const totalAssets = db.prepare("SELECT COUNT(*) as c FROM assets WHERE status = 'active'").get().c;
  const pendingChanges = db.prepare("SELECT COUNT(*) as c FROM changes WHERE status = 'pendingApproval'").get().c;
  const unreadEmails = db.prepare("SELECT COUNT(*) as c FROM email_inbox WHERE is_read = 0").get().c;
  const ticketsByStatus = db.prepare("SELECT status, COUNT(*) as count FROM tickets GROUP BY status").all();
  const ticketsByPriority = db.prepare("SELECT priority, COUNT(*) as count FROM tickets GROUP BY priority").all();
  const recentTickets = db.prepare("SELECT t.*, u.full_name as assignee_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id ORDER BY t.created_at DESC LIMIT 8").all();
  const trend = db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as created FROM tickets WHERE created_at >= DATE('now', '-14 days') GROUP BY DATE(created_at) ORDER BY date`).all();
  res.json({ openTickets, resolvedToday, activeIncidents, totalAssets, pendingChanges, unreadEmails, ticketsByStatus, ticketsByPriority, recentTickets, trend });
});

// ===== TICKETS =====
app.get('/api/tickets', auth, (req, res) => {
  const { page, limit, offset } = paginate(req);
  const { status, priority, category, search, requester_type } = req.query;
  let where = ['1=1'], params = [];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  if (priority && priority !== 'all') { where.push('priority = ?'); params.push(priority); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (requester_type && requester_type !== 'all') { where.push('requester_type = ?'); params.push(requester_type); }
  if (search) { where.push("(title LIKE ? OR ticket_number LIKE ? OR requester_name LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const wc = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as c FROM tickets WHERE ${wc}`).get(...params).c;
  const tickets = db.prepare(`SELECT t.*, u.full_name as assignee_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE ${wc} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data: tickets, total, page, limit, pages: Math.ceil(total / limit) });
});

app.get('/api/tickets/:id', auth, (req, res) => {
  const ticket = db.prepare('SELECT t.*, u.full_name as assignee_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ? OR t.ticket_number = ?').get(req.params.id, req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Nicht gefunden' });
  const comments = db.prepare('SELECT c.*, u.full_name as user_name FROM ticket_comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.ticket_id = ? ORDER BY c.created_at ASC').all(ticket.id);
  const history = db.prepare('SELECT h.*, u.full_name as user_name FROM ticket_history h LEFT JOIN users u ON h.user_id = u.id WHERE h.ticket_id = ? ORDER BY h.created_at DESC').all(ticket.id);
  const emails = db.prepare('SELECT * FROM email_log WHERE ticket_id = ? ORDER BY sent_at DESC').all(ticket.id);
  res.json({ ...ticket, comments, history, emails });
});

app.post('/api/tickets', auth, (req, res) => {
  const { title, description, priority, category, requester_name, requester_email, requester_type, assigned_to, type, due_date } = req.body;
  const ticket_number = nextNumber('TK');
  const result = db.prepare(`INSERT INTO tickets (ticket_number, title, description, priority, category, requester_name, requester_email, requester_type, assigned_to, type, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ticket_number, title, description, priority || 'medium', category, requester_name, requester_email, requester_type || 'internal', assigned_to, type || 'serviceRequest', due_date, req.user.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid);
  // Benachrichtigung
  if (requester_email) {
    sendMail(requester_email, `Ticket erstellt: ${ticket_number}`,
      `<p>Ihr Ticket <strong>${ticket_number}</strong> wurde erstellt.</p><p><strong>Betreff:</strong> ${title}</p><p>Wir melden uns baldmöglichst.</p>`, ticket.id);
  }
  res.status(201).json(ticket);
});

app.put('/api/tickets/:id', auth, (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Nicht gefunden' });
  const fields = ['title', 'description', 'status', 'priority', 'category', 'assigned_to', 'due_date'];
  const updates = [], params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined && String(req.body[f]) !== String(ticket[f] || '')) {
      db.prepare('INSERT INTO ticket_history (ticket_id, user_id, field_changed, old_value, new_value) VALUES (?,?,?,?,?)').run(ticket.id, req.user.id, f, String(ticket[f] || ''), String(req.body[f]));
      updates.push(`${f} = ?`); params.push(req.body[f]);
    }
  });
  if (req.body.status === 'resolved' && ticket.status !== 'resolved') updates.push('resolved_at = CURRENT_TIMESTAMP');
  if (req.body.status === 'closed' && ticket.status !== 'closed') updates.push('closed_at = CURRENT_TIMESTAMP');
  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).run(...params, ticket.id);
    // Status-Benachrichtigung
    if (req.body.status && req.body.status !== ticket.status && ticket.requester_email) {
      const statusLabels = { resolved: 'gelöst', closed: 'geschlossen', inProgress: 'in Bearbeitung' };
      const lbl = statusLabels[req.body.status];
      if (lbl) sendMail(ticket.requester_email, `Ticket ${ticket.ticket_number} ${lbl}`,
        `<p>Ihr Ticket <strong>${ticket.ticket_number}</strong> wurde als <strong>${lbl}</strong> markiert.</p>`, ticket.id);
    }
  }
  res.json(db.prepare('SELECT t.*, u.full_name as assignee_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?').get(ticket.id));
});

app.delete('/api/tickets/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/tickets/:id/comments', auth, (req, res) => {
  const { content, is_internal } = req.body;
  const result = db.prepare('INSERT INTO ticket_comments (ticket_id, user_id, content, is_internal) VALUES (?,?,?,?)').run(req.params.id, req.user.id, content, is_internal ? 1 : 0);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND first_response_at IS NULL').get(req.params.id);
  if (ticket) db.prepare('UPDATE tickets SET first_response_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  const comment = db.prepare('SELECT c.*, u.full_name as user_name FROM ticket_comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?').get(result.lastInsertRowid);
  res.status(201).json(comment);
});

// E-Mail-Antwort aus Ticket senden
app.post('/api/tickets/:id/send-email', auth, async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Nicht gefunden' });
  const { to, subject, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to und body erforderlich' });
  try {
    await sendMail(to, subject || `Re: ${ticket.title} [${ticket.ticket_number}]`, `<div>${body}</div>`, ticket.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== INCIDENTS =====
app.get('/api/incidents', auth, (req, res) => {
  const { page, limit, offset } = paginate(req);
  const { status, priority } = req.query;
  let where = ['1=1'], params = [];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  if (priority && priority !== 'all') { where.push('priority = ?'); params.push(priority); }
  const wc = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as c FROM incidents WHERE ${wc}`).get(...params).c;
  const data = db.prepare(`SELECT i.*, u.full_name as assignee_name FROM incidents i LEFT JOIN users u ON i.assigned_to = u.id WHERE ${wc} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

app.post('/api/incidents', auth, (req, res) => {
  const { title, description, priority, impact, urgency, affected_services, assigned_to, workaround } = req.body;
  const incident_number = nextNumber('INC');
  const result = db.prepare('INSERT INTO incidents (incident_number, title, description, priority, impact, urgency, affected_services, assigned_to, workaround, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(incident_number, title, description, priority || 'medium', impact || 'medium', urgency || 'medium', affected_services, assigned_to, workaround, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM incidents WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/incidents/:id', auth, (req, res) => {
  const fields = ['title', 'description', 'status', 'priority', 'impact', 'urgency', 'affected_services', 'root_cause', 'workaround', 'resolution', 'assigned_to'];
  const updates = [], params = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); } });
  if (req.body.status === 'resolved') updates.push('resolved_at = CURRENT_TIMESTAMP');
  updates.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  res.json(db.prepare('SELECT i.*, u.full_name as assignee_name FROM incidents i LEFT JOIN users u ON i.assigned_to = u.id WHERE i.id = ?').get(req.params.id));
});

// ===== ASSETS =====
app.get('/api/assets', auth, (req, res) => {
  const { page, limit, offset } = paginate(req);
  const { type, status, search } = req.query;
  let where = ['1=1'], params = [];
  if (type && type !== 'all') { where.push('type = ?'); params.push(type); }
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  if (search) { where.push("(name LIKE ? OR asset_tag LIKE ? OR serial_number LIKE ? OR assigned_to_name LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  const wc = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as c FROM assets WHERE ${wc}`).get(...params).c;
  const data = db.prepare(`SELECT * FROM assets WHERE ${wc} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

app.post('/api/assets', auth, (req, res) => {
  const { name, type, manufacturer, model, serial_number, status, location, assigned_to_name, department, purchase_date, warranty_end, purchase_cost, ip_address, mac_address, os, notes } = req.body;
  const asset_tag = nextNumber('AST');
  const result = db.prepare('INSERT INTO assets (asset_tag, name, type, manufacturer, model, serial_number, status, location, assigned_to_name, department, purchase_date, warranty_end, purchase_cost, ip_address, mac_address, os, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(asset_tag, name, type, manufacturer, model, serial_number, status || 'active', location, assigned_to_name, department, purchase_date, warranty_end, purchase_cost, ip_address, mac_address, os, notes);
  res.status(201).json(db.prepare('SELECT * FROM assets WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/assets/:id', auth, (req, res) => {
  const fields = ['name', 'type', 'manufacturer', 'model', 'serial_number', 'status', 'location', 'assigned_to_name', 'department', 'purchase_date', 'warranty_end', 'purchase_cost', 'ip_address', 'mac_address', 'os', 'notes'];
  const updates = [], params = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); } });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE assets SET ${updates.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  res.json(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id));
});

// ===== CHANGES =====
app.get('/api/changes', auth, (req, res) => {
  const { page, limit, offset } = paginate(req);
  const { status, type } = req.query;
  let where = ['1=1'], params = [];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  if (type && type !== 'all') { where.push('type = ?'); params.push(type); }
  const wc = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as c FROM changes WHERE ${wc}`).get(...params).c;
  const data = db.prepare(`SELECT c.*, u.full_name as req_name, a.full_name as assignee_name FROM changes c LEFT JOIN users u ON c.requester_id = u.id LEFT JOIN users a ON c.assigned_to = a.id WHERE ${wc} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

app.post('/api/changes', auth, (req, res) => {
  const { title, description, type, risk, rollback_plan, implementation_date, assigned_to, category, reason } = req.body;
  const change_number = nextNumber('CHG');
  const result = db.prepare('INSERT INTO changes (change_number, title, description, type, risk, status, rollback_plan, implementation_date, assigned_to, category, reason, requester_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(change_number, title, description, type || 'normal', risk || 'medium', 'pendingApproval', rollback_plan, implementation_date, assigned_to, category, reason, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM changes WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/changes/:id', auth, (req, res) => {
  const fields = ['title', 'description', 'type', 'risk', 'status', 'rollback_plan', 'implementation_date', 'assigned_to', 'category', 'reason'];
  const updates = [], params = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); } });
  if (req.body.status === 'approved') { updates.push('approved_by = ?', 'approved_at = CURRENT_TIMESTAMP'); params.push(req.user.id); }
  updates.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE changes SET ${updates.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  res.json(db.prepare('SELECT * FROM changes WHERE id = ?').get(req.params.id));
});

// ===== KNOWLEDGE BASE =====
app.get('/api/kb', (req, res) => {
  const { search, category } = req.query;
  let where = ["status = 'published'"], params = [];
  if (search) { where.push("(title LIKE ? OR content LIKE ? OR tags LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (category) { where.push('category = ?'); params.push(category); }
  const data = db.prepare(`SELECT id, title, category, tags, views, helpful_count, not_helpful_count, created_at FROM kb_articles WHERE ${where.join(' AND ')} ORDER BY views DESC`).all(...params);
  res.json(data);
});

app.get('/api/kb/:id', (req, res) => {
  const article = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Nicht gefunden' });
  db.prepare('UPDATE kb_articles SET views = views + 1 WHERE id = ?').run(req.params.id);
  res.json(article);
});

// ===== REPORTING =====
app.get('/api/reports/overview', auth, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const totalTickets = db.prepare(`SELECT COUNT(*) as c FROM tickets WHERE created_at >= DATE('now', '-${days} days')`).get().c;
  const resolved = db.prepare(`SELECT COUNT(*) as c FROM tickets WHERE status IN ('resolved','closed') AND created_at >= DATE('now', '-${days} days')`).get().c;
  const avgResolution = db.prepare(`SELECT AVG((JULIANDAY(resolved_at) - JULIANDAY(created_at)) * 24) as h FROM tickets WHERE resolved_at IS NOT NULL AND created_at >= DATE('now', '-${days} days')`).get().h;
  const slaBreached = db.prepare(`SELECT COUNT(*) as c FROM tickets WHERE sla_breached = 1 AND created_at >= DATE('now', '-${days} days')`).get().c;
  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM tickets WHERE created_at >= DATE('now', '-${days} days') GROUP BY status`).all();
  const byPriority = db.prepare(`SELECT priority, COUNT(*) as count FROM tickets WHERE created_at >= DATE('now', '-${days} days') GROUP BY priority`).all();
  const byCategory = db.prepare(`SELECT category, COUNT(*) as count FROM tickets WHERE created_at >= DATE('now', '-${days} days') GROUP BY category ORDER BY count DESC LIMIT 10`).all();
  const trend = db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as created FROM tickets WHERE created_at >= DATE('now', '-${days} days') GROUP BY DATE(created_at) ORDER BY date`).all();
  const slaRate = totalTickets > 0 ? ((totalTickets - slaBreached) / totalTickets * 100).toFixed(1) : 100;
  res.json({ totalTickets, resolved, avgResolution: avgResolution ? avgResolution.toFixed(1) : '0', slaRate, byStatus, byPriority, byCategory, trend });
});

// ===== USERS =====
app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id, username, email, full_name, role, department, phone, is_active, created_at FROM users ORDER BY full_name').all());
});
app.get('/api/users/agents', auth, (req, res) => {
  res.json(db.prepare("SELECT id, full_name, role, department FROM users WHERE role IN ('agent','admin') AND is_active = 1 ORDER BY full_name").all());
});

// ===== EMAIL CONFIG =====
app.get('/api/email/config', auth, adminOnly, (req, res) => {
  const cfg = getEmailConfig();
  if (cfg) { cfg.smtp_pass = cfg.smtp_pass ? '••••••••' : ''; cfg.imap_pass = cfg.imap_pass ? '••••••••' : ''; cfg.ms_client_secret = cfg.ms_client_secret ? '••••••••' : ''; }
  res.json(cfg || {});
});

app.put('/api/email/config', auth, adminOnly, (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, imap_host, imap_port, imap_user, imap_pass, from_name, from_email, notifications_enabled, auto_ticket_enabled, poll_interval, connection_type, ms_tenant_id, ms_client_id, ms_client_secret, ms_mailbox } = req.body;
  const current = getEmailConfig();
  // Add column if missing (migration)
  try { db.exec('ALTER TABLE email_config ADD COLUMN poll_interval INTEGER DEFAULT 5'); } catch(e) {}
  try { db.exec("ALTER TABLE email_config ADD COLUMN connection_type TEXT DEFAULT 'imap'"); } catch(e) {}
  try { db.exec("ALTER TABLE email_config ADD COLUMN ms_tenant_id TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE email_config ADD COLUMN ms_client_id TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE email_config ADD COLUMN ms_client_secret TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE email_config ADD COLUMN ms_mailbox TEXT DEFAULT ''"); } catch(e) {}
  db.prepare(`UPDATE email_config SET
    smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=?, smtp_secure=?,
    imap_host=?, imap_port=?, imap_user=?, imap_pass=?,
    from_name=?, from_email=?, notifications_enabled=?, auto_ticket_enabled=?,
    poll_interval=?, connection_type=?,
    ms_tenant_id=?, ms_client_id=?, ms_client_secret=?, ms_mailbox=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=1`)
    .run(smtp_host || '', smtp_port || 587, smtp_user || '',
      smtp_pass && smtp_pass !== '••••••••' ? smtp_pass : (current.smtp_pass || ''), smtp_secure ? 1 : 0,
      imap_host || '', imap_port || 993, imap_user || '',
      imap_pass && imap_pass !== '••••••••' ? imap_pass : (current.imap_pass || ''),
      from_name || 'ServiceDesk Pro', from_email || '', notifications_enabled ? 1 : 0, auto_ticket_enabled ? 1 : 0,
      parseInt(poll_interval) || 5, connection_type || 'imap',
      ms_tenant_id || '', ms_client_id || '',
      ms_client_secret && ms_client_secret !== '••••••••' ? ms_client_secret : (current.ms_client_secret || ''),
      ms_mailbox || '');
  startPollTimer(); // Intervall neu starten mit neuen Einstellungen
  res.json({ success: true });
});

app.post('/api/email/test-smtp', auth, adminOnly, async (req, res) => {
  try {
    const transport = await createTransport();
    if (!transport) return res.status(400).json({ error: 'SMTP nicht konfiguriert' });
    await transport.verify();
    res.json({ success: true, message: 'SMTP Verbindung erfolgreich' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/email/test-imap', auth, adminOnly, async (req, res) => {
  const cfg = getEmailConfig();
  if (!cfg.imap_host || !cfg.imap_user) return res.status(400).json({ error: 'IMAP nicht konfiguriert' });
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: cfg.imap_host, port: cfg.imap_port || 993, secure: true, auth: { user: cfg.imap_user, pass: cfg.imap_pass }, logger: false });
  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true, unseen: true });
    await client.logout();
    res.json({ success: true, message: `IMAP verbunden – ${status.messages} E-Mails, ${status.unseen} ungelesen` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/email/test-graph', auth, adminOnly, async (req, res) => {
  const cfg = getEmailConfig();
  if (!cfg.ms_tenant_id || !cfg.ms_client_id || !cfg.ms_mailbox) return res.status(400).json({ error: 'Microsoft 365 nicht vollständig konfiguriert' });
  try {
    const token = await getGraphToken(cfg);
    const mailbox = encodeURIComponent(cfg.ms_mailbox);
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/inbox`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Graph Fehler');
    res.json({ success: true, message: `Microsoft 365 verbunden – Posteingang: ${data.totalItemCount || 0} E-Mails, ${data.unreadItemCount || 0} ungelesen` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/email/poll', auth, adminOnly, async (req, res) => {
  try { await pollMail(); res.json({ success: true, message: 'Postfach abgerufen' }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ===== EMAIL INBOX =====
app.get('/api/email/inbox', auth, (req, res) => {
  const { page, limit, offset } = paginate(req);
  const total = db.prepare('SELECT COUNT(*) as c FROM email_inbox').get().c;
  const data = db.prepare('SELECT * FROM email_inbox ORDER BY received_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

app.put('/api/email/inbox/:id/read', auth, (req, res) => {
  db.prepare('UPDATE email_inbox SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/email/log', auth, (req, res) => {
  const data = db.prepare('SELECT l.*, t.ticket_number FROM email_log l LEFT JOIN tickets t ON l.ticket_id = t.id ORDER BY l.sent_at DESC LIMIT 50').all();
  res.json(data);
});

// ===== EXPORT =====
app.get('/api/export/:type', auth, (req, res) => {
  const { type } = req.params;
  let data, filename;
  switch (type) {
    case 'tickets': data = db.prepare('SELECT ticket_number, title, status, priority, category, requester_name, requester_type, created_at FROM tickets ORDER BY created_at DESC').all(); filename = 'tickets.csv'; break;
    case 'incidents': data = db.prepare('SELECT incident_number, title, status, priority, impact, urgency, created_at FROM incidents ORDER BY created_at DESC').all(); filename = 'incidents.csv'; break;
    case 'assets': data = db.prepare('SELECT asset_tag, name, type, serial_number, status, location, assigned_to_name, warranty_end FROM assets ORDER BY asset_tag').all(); filename = 'assets.csv'; break;
    default: return res.status(400).json({ error: 'Unbekannter Typ' });
  }
  if (!data.length) return res.status(404).json({ error: 'Keine Daten' });
  const headers = Object.keys(data[0]);
  const csv = [headers.join(';'), ...data.map(row => headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(';'))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + csv);
});


// ===== BENUTZERPROFIL =====
app.get("/api/profile", auth, (req, res) => {
  const user = db.prepare("SELECT id, username, email, full_name, role, department, phone, lang FROM users WHERE id = ?").get(req.user.id);
  res.json(user);
});

app.put("/api/profile", auth, (req, res) => {
  const { full_name, email, department, phone, lang } = req.body;
  if (!full_name || !email) return res.status(400).json({ error: "Name und E-Mail erforderlich" });
  db.prepare("UPDATE users SET full_name=?, email=?, department=?, phone=?, lang=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(full_name, email, department || "", phone || "", lang || "de", req.user.id);
  res.json(db.prepare("SELECT id, username, email, full_name, role, department, phone, lang FROM users WHERE id = ?").get(req.user.id));
});

app.put("/api/profile/password", auth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: "Beide Passwörter erforderlich" });
  if (new_password.length < 8) return res.status(400).json({ error: "Mindestens 8 Zeichen" });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: "Aktuelles Passwort falsch" });
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hash, req.user.id);
  res.json({ success: true });
});


// ===== BENUTZERPROFIL =====
app.get("/api/profile", auth, (req, res) => {
  const user = db.prepare("SELECT id, username, email, full_name, role, department, phone, lang FROM users WHERE id = ?").get(req.user.id);
  res.json(user);
});

app.put("/api/profile", auth, (req, res) => {
  const { full_name, email, department, phone, lang } = req.body;
  if (!full_name || !email) return res.status(400).json({ error: "Name und E-Mail erforderlich" });
  db.prepare("UPDATE users SET full_name=?, email=?, department=?, phone=?, lang=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(full_name, email, department || "", phone || "", lang || "de", req.user.id);
  res.json(db.prepare("SELECT id, username, email, full_name, role, department, phone, lang FROM users WHERE id = ?").get(req.user.id));
});

app.put("/api/profile/password", auth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: "Beide Passwörter erforderlich" });
  if (new_password.length < 8) return res.status(400).json({ error: "Mindestens 8 Zeichen" });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: "Aktuelles Passwort falsch" });
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hash, req.user.id);
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║     🎫 ServiceDesk Pro v2.0             ║
║     Läuft auf Port ${PORT}                 ║
╚══════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
