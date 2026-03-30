# ServiceDesk Pro - Installation auf Raspberry Pi

## Schnellstart (1 Befehl)

Den gesamten `servicedesk-pi` Ordner auf den Pi kopieren und dann:

```bash
cd servicedesk-pi
sudo bash install.sh
```

Fertig! Das System ist dann erreichbar unter `http://<pi-ip-adresse>`

---

## Manuell installieren

### 1. Ordner auf den Pi kopieren

```bash
# Vom PC aus (IP deines Pi anpassen):
scp -r servicedesk-pi/ pi@192.168.1.100:~/
```

### 2. Auf dem Pi

```bash
cd ~/servicedesk-pi
npm install --production
node src/setup-db.js
node src/server.js
```

Das System läuft dann auf Port 3000: `http://<pi-ip>:3000`

---

## Login-Daten

| Benutzer | Passwort | Rolle |
|----------|----------|-------|
| admin | admin123 | Administrator |
| mmueller | agent123 | Agent |
| lweber | agent123 | Agent |
| jfischer | agent123 | Agent |

**Passwörter nach dem ersten Login ändern!**

---

## Verwaltung

```bash
# Status prüfen
sudo systemctl status servicedesk

# Neustart
sudo systemctl restart servicedesk

# Logs anzeigen
sudo journalctl -u servicedesk -f

# Stoppen
sudo systemctl stop servicedesk
```

---

## Externer Zugriff

### Option A: Tailscale (empfohlen)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Danach erreichbar über die Tailscale-IP.

### Option B: Port im Router freigeben
Port 80 (HTTP) auf die IP des Pi weiterleiten.
Für HTTPS zusätzlich Certbot installieren:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d deine-domain.de
```

---

## API-Endpunkte

| Methode | Pfad | Beschreibung |
|---------|------|-------------|
| POST | /api/auth/login | Anmelden |
| GET | /api/dashboard | Dashboard-Daten |
| GET/POST | /api/tickets | Tickets auflisten/erstellen |
| GET/PUT | /api/tickets/:id | Ticket lesen/bearbeiten |
| GET/POST | /api/incidents | Incidents |
| GET/POST | /api/assets | Assets |
| GET/POST | /api/changes | Changes |
| GET | /api/kb | Knowledge Base (öffentlich) |
| GET | /api/reports/overview | Reporting |
| GET | /api/export/:type | CSV-Export |

Alle API-Aufrufe (außer KB) brauchen einen Bearer Token im Header:
```
Authorization: Bearer <token>
```

---

## Datenbank-Backup

```bash
# Backup erstellen
cp /opt/servicedesk/db/servicedesk.db ~/backup-$(date +%Y%m%d).db

# Automatisches tägliches Backup (Crontab)
crontab -e
# Zeile hinzufügen:
0 3 * * * cp /opt/servicedesk/db/servicedesk.db /home/pi/backups/servicedesk-$(date +\%Y\%m\%d).db
```
