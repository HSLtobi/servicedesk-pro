const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'db', 'servicedesk.db');
const db = new Database(DB_PATH);

// Performance-Optimierungen für SQLite auf dem Pi
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -8000'); // 8MB Cache

console.log('📦 Erstelle Datenbank-Schema...');

db.exec(`
  -- ===== BENUTZER =====
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'agent' CHECK(role IN ('admin','agent','user')),
    department TEXT,
    phone TEXT,
    is_active INTEGER DEFAULT 1,
    lang TEXT DEFAULT 'de',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== TICKETS =====
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','inProgress','pending','resolved','closed')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
    category TEXT,
    type TEXT DEFAULT 'serviceRequest' CHECK(type IN ('serviceRequest','incident','problem')),
    source TEXT DEFAULT 'portal' CHECK(source IN ('portal','email','phone','api')),
    requester_name TEXT NOT NULL,
    requester_email TEXT,
    requester_type TEXT DEFAULT 'internal' CHECK(requester_type IN ('internal','external')),
    assigned_to INTEGER REFERENCES users(id),
    assigned_team TEXT,
    due_date DATETIME,
    resolved_at DATETIME,
    closed_at DATETIME,
    first_response_at DATETIME,
    sla_breached INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
  CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);

  -- ===== TICKET-KOMMENTARE =====
  CREATE TABLE IF NOT EXISTS ticket_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    content TEXT NOT NULL,
    is_internal INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== TICKET-HISTORIE =====
  CREATE TABLE IF NOT EXISTS ticket_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    field_changed TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== INCIDENTS =====
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_number TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','inProgress','pending','resolved','closed')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
    impact TEXT DEFAULT 'medium' CHECK(impact IN ('critical','high','medium','low')),
    urgency TEXT DEFAULT 'medium' CHECK(urgency IN ('critical','high','medium','low')),
    affected_services TEXT,
    root_cause TEXT,
    workaround TEXT,
    resolution TEXT,
    assigned_to INTEGER REFERENCES users(id),
    escalation_level INTEGER DEFAULT 0,
    related_ticket_id INTEGER REFERENCES tickets(id),
    resolved_at DATETIME,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_incidents_priority ON incidents(priority);

  -- ===== ASSETS =====
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_tag TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('desktop','laptop','server','mobile','network','software','printer','other')),
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','maintenance','retired','disposed')),
    location TEXT,
    assigned_to INTEGER REFERENCES users(id),
    assigned_to_name TEXT,
    department TEXT,
    purchase_date DATE,
    purchase_cost REAL,
    warranty_end DATE,
    ip_address TEXT,
    mac_address TEXT,
    os TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
  CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
  CREATE INDEX IF NOT EXISTS idx_assets_assigned ON assets(assigned_to);

  -- ===== CHANGES =====
  CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_number TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'normal' CHECK(type IN ('normal','standard','emergency')),
    risk TEXT DEFAULT 'medium' CHECK(risk IN ('low','medium','high','critical')),
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pendingApproval','approved','rejected','scheduled','inProgress','implemented','failed','cancelled')),
    category TEXT,
    reason TEXT,
    rollback_plan TEXT,
    implementation_date DATETIME,
    implementation_end DATETIME,
    actual_start DATETIME,
    actual_end DATETIME,
    requester_id INTEGER REFERENCES users(id),
    assigned_to INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    approved_at DATETIME,
    related_incident_id INTEGER REFERENCES incidents(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_changes_status ON changes(status);

  -- ===== KNOWLEDGE BASE =====
  CREATE TABLE IF NOT EXISTS kb_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    tags TEXT,
    status TEXT DEFAULT 'published' CHECK(status IN ('draft','published','archived')),
    views INTEGER DEFAULT 0,
    helpful_count INTEGER DEFAULT 0,
    not_helpful_count INTEGER DEFAULT 0,
    author_id INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ===== SLA-KONFIGURATION =====
  CREATE TABLE IF NOT EXISTS sla_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    priority TEXT NOT NULL,
    first_response_hours REAL NOT NULL,
    resolution_hours REAL NOT NULL,
    is_active INTEGER DEFAULT 1
  );

  -- ===== EINSTELLUNGEN =====
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ===== DEMO-DATEN EINFÜGEN =====
console.log('👤 Erstelle Benutzer...');

const hash = bcrypt.hashSync('admin123', 10);
const agentHash = bcrypt.hashSync('agent123', 10);

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (username, email, password_hash, full_name, role, department, phone)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

insertUser.run('admin', 'admin@servicedesk.local', hash, 'Tobias Böttcher', 'admin', 'IT', '+49 170 1234567');
insertUser.run('mmueller', 'max.mueller@firma.de', agentHash, 'Max Müller', 'agent', 'IT-Support', '+49 170 2345678');
insertUser.run('lweber', 'lisa.weber@firma.de', agentHash, 'Lisa Weber', 'agent', 'IT-Netzwerk', '+49 170 3456789');
insertUser.run('jfischer', 'jan.fischer@firma.de', agentHash, 'Jan Fischer', 'agent', 'IT-Systeme', '+49 170 4567890');
insertUser.run('sklein', 'sarah.klein@firma.de', agentHash, 'Sarah Klein', 'agent', 'IT-Support', '+49 170 5678901');

console.log('🎫 Erstelle Tickets...');

const insertTicket = db.prepare(`
  INSERT OR IGNORE INTO tickets (ticket_number, title, description, status, priority, category, requester_name, requester_email, requester_type, assigned_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertTicket.run('TK-001', 'Drucker im 3. OG funktioniert nicht', 'Der Drucker HP LaserJet im 3. OG druckt nicht mehr. Papierstau wurde bereits überprüft.', 'open', 'high', 'Hardware', 'Anna Schmidt', 'a.schmidt@firma.de', 'internal', 2, '2026-03-25 09:15:00');
insertTicket.run('TK-002', 'VPN-Verbindung bricht ab', 'VPN-Verbindung bricht alle 15 Minuten ab. Betrifft mehrere Mitarbeiter im Homeoffice.', 'inProgress', 'critical', 'Netzwerk', 'Tom Becker', 't.becker@firma.de', 'internal', 3, '2026-03-24 14:30:00');
insertTicket.run('TK-003', 'Neues Notebook für Abteilungsleiter', 'Neues Notebook wird für den neuen Abteilungsleiter Marketing benötigt. Mindestens 16GB RAM.', 'pending', 'medium', 'Beschaffung', 'Dr. Karin Hoffmann', 'k.hoffmann@firma.de', 'internal', 2, '2026-03-23 11:00:00');
insertTicket.run('TK-004', 'E-Mail Konto einrichten', 'E-Mail-Konto für neuen Mitarbeiter in der Buchhaltung einrichten. Start: 01.04.2026', 'resolved', 'low', 'Software', 'Peter Koch', 'p.koch@firma.de', 'internal', 3, '2026-03-22 08:45:00');
insertTicket.run('TK-005', 'Website lädt langsam', 'Kunde meldet langsame Ladezeiten auf der Hauptseite seit heute Morgen. Response > 5s.', 'open', 'high', 'Performance', 'TechCorp GmbH', 'support@techcorp.de', 'external', 4, '2026-03-25 10:20:00');
insertTicket.run('TK-006', 'Passwort zurücksetzen', 'Mitarbeiterin hat ihr Passwort vergessen und benötigt ein Reset.', 'closed', 'low', 'Zugang', 'Sarah Wagner', 's.wagner@firma.de', 'internal', 2, '2026-03-21 07:30:00');
insertTicket.run('TK-007', 'API-Integration fehlerhaft', 'REST-API liefert seit Update 500er Fehler bei POST /orders Endpunkt.', 'inProgress', 'critical', 'Entwicklung', 'DataFlow AG', 'dev@dataflow.de', 'external', 4, '2026-03-24 16:00:00');
insertTicket.run('TK-008', 'Konferenzraum-Technik defekt', 'Beamer und Soundsystem im Konferenzraum A funktionieren nicht. Meeting morgen 9 Uhr!', 'open', 'medium', 'Hardware', 'Michael Braun', 'm.braun@firma.de', 'internal', 3, '2026-03-26 08:00:00');

console.log('🔥 Erstelle Incidents...');

const insertInc = db.prepare(`
  INSERT OR IGNORE INTO incidents (incident_number, title, description, status, priority, impact, urgency, affected_services, root_cause, workaround, assigned_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertInc.run('INC-001', 'Serverausfall Rechenzentrum Nord', 'Komplettausfall aller Server im RZ Nord. Ursache wird untersucht.', 'open', 'critical', 'high', 'high', 'E-Mail, Intranet, ERP', '', 'Umleitung auf Backup-Server', 4, '2026-03-26 06:30:00');
insertInc.run('INC-002', 'Netzwerkstörung Gebäude B', 'Intermittierende Netzwerkausfälle in Gebäude B, 2. und 3. OG.', 'inProgress', 'high', 'medium', 'high', 'Internet, VoIP', 'Defekter Switch Port 24', 'Temporärer Switch installiert', 3, '2026-03-25 11:15:00');
insertInc.run('INC-003', 'Datenbank-Performance kritisch', 'ERP-Datenbank antwortet mit >10s Latenz auf Standard-Queries.', 'resolved', 'high', 'high', 'medium', 'ERP, CRM', 'Fehlender Index auf Haupttabelle', '', 4, '2026-03-24 13:45:00');
insertInc.run('INC-004', 'Phishing-Attacke erkannt', 'Gezielte Phishing-Mails an Finanzabteilung. 3 Mitarbeiter haben Link geklickt.', 'inProgress', 'critical', 'high', 'critical', 'E-Mail', '', 'Betroffene Mails geblockt, Passwort-Reset eingeleitet', 2, '2026-03-26 07:00:00');

console.log('💻 Erstelle Assets...');

const insertAsset = db.prepare(`
  INSERT OR IGNORE INTO assets (asset_tag, name, type, manufacturer, model, serial_number, status, location, assigned_to_name, department, purchase_date, warranty_end, purchase_cost)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertAsset.run('AST-001', 'Dell OptiPlex 7090', 'desktop', 'Dell', 'OptiPlex 7090', 'DELL-7090-A1234', 'active', 'Büro 301', 'Anna Schmidt', 'Marketing', '2024-06-15', '2027-06-15', 899.00);
insertAsset.run('AST-002', 'MacBook Pro 16"', 'laptop', 'Apple', 'MacBook Pro 16 M3', 'APPLE-MBP-B5678', 'active', 'Homeoffice', 'Tom Becker', 'Entwicklung', '2025-01-10', '2028-01-10', 2899.00);
insertAsset.run('AST-003', 'HP ProLiant DL380', 'server', 'HP', 'ProLiant DL380 Gen10', 'HP-DL380-C9012', 'active', 'RZ Nord', 'IT-Infrastruktur', 'IT', '2023-03-20', '2026-03-20', 5499.00);
insertAsset.run('AST-004', 'Cisco Catalyst 9300', 'network', 'Cisco', 'Catalyst 9300-48P', 'CISCO-9300-D3456', 'maintenance', 'Serverraum B', 'IT-Netzwerk', 'IT', '2024-08-01', '2027-08-01', 3200.00);
insertAsset.run('AST-005', 'iPhone 15 Pro', 'mobile', 'Apple', 'iPhone 15 Pro', 'APPLE-IP15-E7890', 'active', 'Mobil', 'Dr. Karin Hoffmann', 'Geschäftsführung', '2025-09-20', '2027-09-20', 1199.00);
insertAsset.run('AST-006', 'Microsoft 365 E3 Lizenz', 'software', 'Microsoft', '365 E3', 'MS365-LIC-F1234', 'active', '-', 'Alle Mitarbeiter', 'IT', '2025-01-01', '2026-12-31', 3600.00);
insertAsset.run('AST-007', 'Lenovo ThinkPad T14', 'laptop', 'Lenovo', 'ThinkPad T14 Gen4', 'LEN-T14-G5678', 'inactive', 'Lager', '-', 'IT', '2023-11-15', '2026-11-15', 1099.00);
insertAsset.run('AST-008', 'Dell PowerEdge R750', 'server', 'Dell', 'PowerEdge R750', 'DELL-R750-H9012', 'retired', 'RZ Süd', 'IT-Infrastruktur', 'IT', '2021-05-10', '2024-05-10', 6800.00);

console.log('🔄 Erstelle Changes...');

const insertChg = db.prepare(`
  INSERT OR IGNORE INTO changes (change_number, title, description, type, risk, status, rollback_plan, implementation_date, requester_id, assigned_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertChg.run('CHG-001', 'Exchange Server Migration', 'Migration von Exchange 2019 auf Exchange Online für alle 250 Mailboxen.', 'normal', 'high', 'approved', 'Rollback auf lokalen Exchange Server innerhalb 4h', '2026-04-01 22:00:00', 4, 4, '2026-03-15 10:00:00');
insertChg.run('CHG-002', 'Firewall-Regelwerk Update', 'Aktualisierung der Firewall-Regeln für neuen Standort München.', 'standard', 'medium', 'implemented', 'Wiederherstellung der vorherigen Konfiguration', '2026-03-20 18:00:00', 3, 3, '2026-03-10 14:00:00');
insertChg.run('CHG-003', 'ERP-System Patch 4.2.1', 'Sicherheitspatch und Bugfixes für ERP-System. 12 CVEs gefixt.', 'normal', 'medium', 'pendingApproval', 'Snapshot-Wiederherstellung der VM', '2026-04-05 20:00:00', 2, 4, '2026-03-18 09:00:00');
insertChg.run('CHG-004', 'Notfall-Patch Datenbank', 'Kritischer Sicherheitspatch für SQL-Server wegen CVE-2026-1234.', 'emergency', 'high', 'implemented', 'Datenbank-Backup Restore', '2026-03-24 21:00:00', 4, 4, '2026-03-24 15:00:00');
insertChg.run('CHG-005', 'WLAN Upgrade Gebäude A', 'Upgrade aller 24 WLAN Access Points auf WiFi 6E Standard.', 'normal', 'low', 'pendingApproval', 'Alte Access Points wieder installieren', '2026-04-10 07:00:00', 3, 3, '2026-03-20 11:00:00');

console.log('📚 Erstelle Knowledge Base Artikel...');

const insertKB = db.prepare(`
  INSERT OR IGNORE INTO kb_articles (title, content, category, tags, views, helpful_count, author_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

insertKB.run('VPN einrichten - Schritt für Schritt', 'So richten Sie die VPN-Verbindung ein:\n1. OpenVPN Client installieren\n2. Konfigurationsdatei herunterladen\n3. Profil importieren\n4. Mit Firmen-Credentials anmelden', 'Netzwerk', 'vpn,remote,homeoffice', 1542, 137, 3);
insertKB.run('Passwort zurücksetzen', 'So setzen Sie Ihr Passwort zurück:\n1. Self-Service Portal öffnen\n2. "Passwort vergessen" klicken\n3. E-Mail-Adresse eingeben\n4. Link in der E-Mail folgen\n5. Neues Passwort vergeben (min. 12 Zeichen)', 'Zugang', 'passwort,login,reset', 3210, 305, 2);
insertKB.run('Drucker einrichten unter Windows 11', 'Anleitung zur Druckereinrichtung:\n1. Einstellungen > Bluetooth & Geräte > Drucker\n2. Drucker hinzufügen\n3. Netzwerkdrucker suchen\n4. Treiber wird automatisch installiert', 'Hardware', 'drucker,printer,windows', 892, 69, 2);
insertKB.run('Microsoft Teams - Häufige Probleme', 'Lösungen für typische Teams-Probleme:\n- Kein Audio: Geräteeinstellungen prüfen\n- Bildschirmfreigabe geht nicht: Teams neu starten\n- Nachrichten werden nicht synchronisiert: Cache leeren', 'Software', 'teams,meeting,video', 2105, 172, 5);
insertKB.run('E-Mail Signatur konfigurieren', 'So richten Sie Ihre E-Mail-Signatur ein:\n1. Outlook > Datei > Optionen\n2. E-Mail > Signaturen\n3. Vorlage von Intranet kopieren\n4. Persönliche Daten anpassen', 'Software', 'email,signatur,outlook', 1876, 170, 5);
insertKB.run('Homeoffice Checkliste', 'Checkliste für das Arbeiten im Homeoffice:\n- VPN-Verbindung getestet\n- Headset funktioniert\n- Bildschirm angeschlossen\n- Ergonomischer Arbeitsplatz\n- Teams/Outlook gestartet', 'Allgemein', 'homeoffice,remote,checkliste', 2530, 237, 1);

console.log('📊 Erstelle SLA-Policies...');

const insertSLA = db.prepare(`INSERT OR IGNORE INTO sla_policies (name, priority, first_response_hours, resolution_hours) VALUES (?, ?, ?, ?)`);
insertSLA.run('Kritisch', 'critical', 0.25, 4);
insertSLA.run('Hoch', 'high', 1, 8);
insertSLA.run('Mittel', 'medium', 4, 24);
insertSLA.run('Niedrig', 'low', 8, 72);

console.log('⚙️ Erstelle Einstellungen...');

const insertSetting = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
insertSetting.run('company_name', 'LogicPile');
insertSetting.run('ticket_prefix', 'TK');
insertSetting.run('incident_prefix', 'INC');
insertSetting.run('asset_prefix', 'AST');
insertSetting.run('change_prefix', 'CHG');
insertSetting.run('default_language', 'de');
insertSetting.run('timezone', 'Europe/Berlin');

db.close();
console.log('\n✅ Datenbank erfolgreich erstellt: ' + DB_PATH);
console.log('🔑 Admin-Login: admin / admin123');
console.log('🔑 Agent-Login: mmueller / agent123');
