#!/bin/bash
# =============================================
# ServiceDesk Pro - Installationsscript
# Für Raspberry Pi (Raspberry Pi OS)
# SICHER: Fasst bestehende Nginx/Dienste NICHT an
# =============================================

set -e

INSTALL_DIR="/opt/servicedesk"
SERVICE_NAME="servicedesk"
SD_PORT=3030
PI_USER="${SUDO_USER:-pi}"

echo "╔══════════════════════════════════════════╗"
echo "║  🎫 ServiceDesk Pro - Installation       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Root-Check
if [ "$EUID" -ne 0 ]; then
  echo "❌ Bitte als root ausführen: sudo bash install.sh"
  exit 1
fi

# Prüfe ob Port schon belegt ist
if ss -tlnp | grep -q ":${SD_PORT} "; then
  echo "⚠️  Port ${SD_PORT} ist bereits belegt!"
  echo "   Belegung: $(ss -tlnp | grep :${SD_PORT})"
  echo ""
  read -p "Anderen Port verwenden? (z.B. 3040): " CUSTOM_PORT
  if [ -n "$CUSTOM_PORT" ]; then
    SD_PORT=$CUSTOM_PORT
  else
    echo "Abgebrochen."
    exit 1
  fi
fi

echo "→ Verwende Port: ${SD_PORT}"
echo ""

# 1. Build-Tools sicherstellen (für native npm-Pakete)
echo "📦 [1/6] Prüfe Build-Abhängigkeiten..."
apt-get update -qq 2>/dev/null || true
apt-get install -y -qq build-essential python3 2>/dev/null || true

# 2. Node.js prüfen
echo "📦 [2/6] Prüfe Node.js..."
if ! command -v node &> /dev/null; then
  echo "  → Installiere Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  → Node.js $(node -v) gefunden"

# 3. Anwendung kopieren
echo "📁 [3/6] Installiere Anwendung nach ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
cp -r . "${INSTALL_DIR}/"
chown -R "${PI_USER}:${PI_USER}" "${INSTALL_DIR}"

# 4. NPM-Pakete installieren
echo "📦 [4/6] Installiere Node-Pakete (kann auf dem Pi etwas dauern)..."
cd "${INSTALL_DIR}"
sudo -u "${PI_USER}" npm install --production 2>&1 | tail -3

# 5. Datenbank initialisieren
echo "🗄️  [5/6] Initialisiere Datenbank..."
sudo -u "${PI_USER}" node src/setup-db.js

# 6. Systemd-Service erstellen
echo "⚙️  [6/6] Erstelle Systemd-Service..."
cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=ServiceDesk Pro - Ticketsystem
After=network.target

[Service]
Type=simple
User=${PI_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=${SD_PORT}
Environment=JWT_SECRET=$(openssl rand -hex 32)

# Performance & Sicherheit
LimitNOFILE=65535
ProtectSystem=full
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl start ${SERVICE_NAME}

# Warten bis Service hochgefahren ist
sleep 2

# Status prüfen
if systemctl is-active --quiet ${SERVICE_NAME}; then
  STATUS="✅ Läuft"
else
  STATUS="❌ Fehler - siehe: sudo journalctl -u servicedesk -n 20"
fi

# Fertig!
PI_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ${STATUS}  Installation abgeschlossen!       "
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║  🌐 Zugriff: http://${PI_IP}:${SD_PORT}     "
echo "║                                              ║"
echo "║  👤 Admin:   admin / admin123                ║"
echo "║  👤 Agent:   mmueller / agent123             ║"
echo "║                                              ║"
echo "║  📁 App:     ${INSTALL_DIR}                  "
echo "║  📊 DB:      ${INSTALL_DIR}/db/servicedesk.db"
echo "║  🔧 Port:    ${SD_PORT}                      "
echo "║                                              ║"
echo "║  Befehle:                                    ║"
echo "║  sudo systemctl status servicedesk           ║"
echo "║  sudo systemctl restart servicedesk          ║"
echo "║  sudo journalctl -u servicedesk -f           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "⚠️  Bitte ändere die Standard-Passwörter!"
echo ""
echo "ℹ️  Nginx wurde NICHT verändert."
echo "   Deine bestehenden Dienste laufen unberührt weiter."
echo "   ServiceDesk läuft eigenständig auf Port ${SD_PORT}."
