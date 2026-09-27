#!/usr/bin/env bash
# ============================================================================
#  AgriSecur — installation sur un serveur Oracle Cloud "Always Free"
#  (Ubuntu 22.04 ou 24.04, processeur ARM Ampere ou AMD)
#
#  Usage, une fois connecté au serveur en SSH :
#     curl -fsSL https://raw.githubusercontent.com/hgouamba-svg/agrisecur/main/deploy/oracle/install.sh -o install.sh
#     sudo DOMAIN="www.agrisecur.com agrisecur.com" bash install.sh
#
#  Sans DOMAIN, le site est servi en HTTP simple sur l'adresse IP du serveur
#  (pratique pour tester avant de changer le DNS). Relancer le script avec
#  DOMAIN plus tard active le HTTPS automatique.
#
#  Le script peut être relancé sans risque : il ne touche jamais à la base
#  ni au fichier de configuration s'ils existent déjà.
# ============================================================================
set -euo pipefail

REPO="https://github.com/hgouamba-svg/agrisecur.git"
BRANCHE="main"
APP_DIR="/opt/agrisecur"
DATA_DIR="/var/lib/agrisecur"
ENV_FILE="/etc/agrisecur.env"
PORT_APP=3000
DOMAIN="${DOMAIN:-}"

etape() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script avec sudo."; exit 1; }

etape "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl sqlite3 openssl ca-certificates gnupg \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

etape "Node.js 22"
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

etape "Utilisateur et dossiers"
id agrisecur >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin agrisecur
mkdir -p "$DATA_DIR/backups"
chown -R agrisecur:agrisecur "$DATA_DIR"

etape "Code AgriSecur"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCHE"
  git -C "$APP_DIR" reset --hard "origin/$BRANCHE"
else
  git clone --depth 1 --branch "$BRANCHE" "$REPO" "$APP_DIR"
fi
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
# Le code reste à root (lecture seule pour le service) : la base est dans $DATA_DIR.

etape "Configuration ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$PORT_APP
DB_PATH=$DATA_DIR/agrisecur.db
# Caddy (sur la même machine) ajoute l'IP du visiteur à X-Forwarded-For.
TRUST_PROXY=1
# Reprenez la clé admin de Railway pour garder le même accès au back-office.
ADMIN_KEY=$(openssl rand -hex 24)
SMTP_HOST=ssl0.ovh.net
SMTP_PORT=587
SMTP_USER=support@agrisecur.com
SMTP_PASS=
WHISP_API_KEY=
EOF
  chmod 600 "$ENV_FILE"
  NOUVEAU_ENV=1
else
  NOUVEAU_ENV=0
fi

etape "Service AgriSecur (démarrage automatique)"
cat > /etc/systemd/system/agrisecur.service <<EOF
[Unit]
Description=AgriSecur
After=network-online.target
Wants=network-online.target

[Service]
User=agrisecur
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable agrisecur
systemctl restart agrisecur

etape "Mise à jour automatique depuis GitHub (toutes les 5 minutes)"
cat > /usr/local/bin/agrisecur-update <<EOF
#!/usr/bin/env bash
# Déploie la dernière version de GitHub si elle a changé.
set -euo pipefail
cd $APP_DIR
git fetch --depth 1 -q origin $BRANCHE
if [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/$BRANCHE)" ]; then
  git reset -q --hard origin/$BRANCHE
  npm install --omit=dev --no-audit --no-fund --silent
  systemctl restart agrisecur
  echo "\$(date -Is) mis à jour vers \$(git rev-parse --short HEAD)"
fi
EOF
chmod +x /usr/local/bin/agrisecur-update

etape "Sauvegarde quotidienne de la base (14 jours conservés)"
cat > /usr/local/bin/agrisecur-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail
DB=$DATA_DIR/agrisecur.db
[ -f "\$DB" ] || exit 0
sqlite3 "\$DB" ".backup '$DATA_DIR/backups/agrisecur-\$(date +%F).db'"
find $DATA_DIR/backups -name 'agrisecur-*.db' -mtime +14 -delete
EOF
chmod +x /usr/local/bin/agrisecur-backup

cat > /etc/cron.d/agrisecur <<EOF
*/5 * * * * root /usr/local/bin/agrisecur-update >> /var/log/agrisecur-update.log 2>&1
15 3 * * *  root /usr/local/bin/agrisecur-backup >> /var/log/agrisecur-backup.log 2>&1
EOF

etape "Pare-feu du serveur : ports 80 et 443"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save

etape "Caddy (HTTPS automatique)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
if [ -n "$DOMAIN" ]; then
  SITES=$(echo "$DOMAIN" | tr ' ,' '\n\n' | sed '/^$/d' | paste -sd, - | sed 's/,/, /g')
else
  SITES=":80"
fi
cat > /etc/caddy/Caddyfile <<EOF
$SITES {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT_APP
}
EOF
systemctl reload caddy || systemctl restart caddy

etape "Vérification"
sleep 3
if curl -fsS "http://127.0.0.1:$PORT_APP/api/health" >/dev/null; then
  echo "AgriSecur répond correctement."
else
  echo "AgriSecur ne répond pas encore. Si NOUVEAU_ENV=1 ci-dessous, complétez la configuration puis :"
  echo "  sudo systemctl restart agrisecur && sudo journalctl -u agrisecur -n 30"
fi

IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "votre-ip")
cat <<EOF

--------------------------------------------------------------------------
 Installation terminée.
 Site : $( [ -n "$DOMAIN" ] && echo "https://${DOMAIN%% *}" || echo "http://$IP" )

 À faire :
EOF
if [ "$NOUVEAU_ENV" = "1" ]; then
cat <<EOF
  1. Compléter la configuration (mot de passe SMTP, clé WHISP, clé admin) :
       sudo nano $ENV_FILE
       sudo systemctl restart agrisecur
EOF
fi
cat <<EOF
  - Importer une sauvegarde de la base :
       sudo systemctl stop agrisecur
       sudo cp agrisecur-AAAA-MM-JJ.db $DATA_DIR/agrisecur.db
       sudo chown agrisecur:agrisecur $DATA_DIR/agrisecur.db
       sudo systemctl start agrisecur
  - Journaux : sudo journalctl -u agrisecur -f
--------------------------------------------------------------------------
EOF
