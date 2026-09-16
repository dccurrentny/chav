#!/usr/bin/env bash
# Takes a fresh Ubuntu 24.04 droplet to a running portal.
#
#   ssh root@<droplet-ip>
#   git clone https://github.com/dccurrentny/chav /opt/chav
#   bash /opt/chav/infra/provision.sh
#
# Idempotent: re-running is safe and is the supported way to pick up changes
# to this script. It does NOT deploy application code — CI does that.
set -euo pipefail

APP_USER="portal"
APP_DIR="/opt/chav"
DB_NAME="portal"
DB_USER="portal"
NODE_MAJOR="22"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw postgresql postgresql-contrib \
  unattended-upgrades debian-goodies apt-listchanges

log "Unattended security upgrades"
# Security patches apply themselves; everything else stays under your control.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades

log "Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node -v

log "Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

log "Application user"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

# Must exist before the Postgres step writes db.env into it.
install -d -m 750 -o root -g "$APP_USER" /etc/portal

log "Postgres"
# Bind to loopback only. A Postgres reachable from the internet gets found.
PG_CONF="$(find /etc/postgresql -name postgresql.conf 2>/dev/null | head -1)"
if [[ -z "$PG_CONF" ]]; then
  echo "could not find postgresql.conf — is postgresql installed?" >&2
  exit 1
fi
sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" "$PG_CONF"
systemctl restart postgresql

sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || {
  DB_PASS="$(openssl rand -base64 24 | tr -d '/+=')"
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
  # Create with the final mode first: never let the password touch disk
  # world-readable, even for the moment before a chmod.
  install -m 640 -o root -g "$APP_USER" /dev/null /etc/portal/db.env
  echo "DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}" > /etc/portal/db.env
  echo "Database created. Connection string written to /etc/portal/db.env"
}

log "Config directory"
if [[ ! -f /etc/portal/portal.env ]]; then
  cp "${APP_DIR}/infra/portal.env.example" /etc/portal/portal.env
  # SESSION_SECRET is generated here so no secret is ever committed.
  SECRET="$(openssl rand -hex 32)"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" /etc/portal/portal.env
  chmod 640 /etc/portal/portal.env
  chown root:"$APP_USER" /etc/portal/portal.env
  echo "!! Edit /etc/portal/portal.env and fill in the NS_* SkySwitch credentials."
fi

log "Application directory"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "systemd unit"
cp "${APP_DIR}/infra/systemd/portal.service" /etc/systemd/system/portal.service
systemctl daemon-reload
systemctl enable portal

log "Caddy site"
cp "${APP_DIR}/infra/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

log "Firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

log "Nightly backup timer"
cp "${APP_DIR}/infra/backup.sh" /usr/local/bin/portal-backup
chmod 700 /usr/local/bin/portal-backup
cp "${APP_DIR}/infra/systemd/portal-backup.service" /etc/systemd/system/
cp "${APP_DIR}/infra/systemd/portal-backup.timer"   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now portal-backup.timer

cat <<'DONE'

Provisioning complete.

Remaining steps:

  1. Fill in the SkySwitch credentials:
       sudo nano /etc/portal/portal.env     (the five NS_* values)

  2. Install dependencies and apply the schema:
       cd /opt/chav/server && npm ci && npm run migrate

  3. Start it:
       sudo systemctl start portal
       curl -s localhost:3000/readyz        expect {"ok":true,"db":"up"}

  4. Add your first customer:
       cd /opt/chav/server
       node scripts/seed-tenant.js \
         --name "Acme Electric" \
         --ns-domain acme.yourdomain.com \
         --hostname acme.portal.dccurrentny.com \
         --admin owner@acme.com \
         --color '#2F6FED'

  5. Point an A record for that hostname at this droplet's IP.

No Caddy edit is needed. One site block serves every customer, and the
certificate is obtained on the first request to a hostname that belongs
to an active tenant.

Verify once DNS resolves:  curl -s https://<hostname>/readyz
DONE
