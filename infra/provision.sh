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
DEPLOY_USER="deploy"
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
apt-get install -y -qq curl ca-certificates gnupg git ufw gettext-base postgresql postgresql-contrib \
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

log "Deploy user"
# CI signs in as this account to deploy. It is deliberately NOT the service
# account: the service should not be able to rewrite its own code, and an
# unattended SSH key should not reach the service's environment.
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  # No password is ever set, so the account is reachable by key only.
  passwd -l "$DEPLOY_USER" >/dev/null
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
AUTH_KEYS="/home/${DEPLOY_USER}/.ssh/authorized_keys"
[[ -f "$AUTH_KEYS" ]] || install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$AUTH_KEYS"

# Pass DEPLOY_PUBKEY=... to install the CI key without editing files by hand.
# Appended only if absent, so re-running does not accumulate duplicates.
if [[ -n "${DEPLOY_PUBKEY:-}" ]]; then
  grep -qxF "$DEPLOY_PUBKEY" "$AUTH_KEYS" 2>/dev/null || echo "$DEPLOY_PUBKEY" >> "$AUTH_KEYS"
  echo "Deploy key installed for ${DEPLOY_USER}."
else
  echo "!! No DEPLOY_PUBKEY given. Add the CI public key to"
  echo "   $AUTH_KEYS before enabling the deploy workflow."
fi

log "Migration wrapper"
# DATABASE_URL lives only in /etc/portal/db.env, which the deploy user cannot
# read. Rather than widen that file's permissions, migrations run through one
# fixed root-owned command.
install -m 755 -o root -g root "${APP_DIR}/infra/portal-migrate" /usr/local/bin/portal-migrate

log "Deploy privileges"
# Exactly three commands, each matched in full — sudo compares the whole
# command line, so `systemctl restart portal` does not also permit
# `systemctl restart anything-else`. Validated before installing: a malformed
# sudoers file can lock everyone out of sudo on the box.
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/bin/portal-migrate, \
/usr/bin/systemctl restart portal, \
/usr/bin/systemctl is-active portal
EOF
if visudo -cf "$SUDOERS_TMP" >/dev/null; then
  install -m 440 -o root -g root "$SUDOERS_TMP" "/etc/sudoers.d/${DEPLOY_USER}"
else
  rm -f "$SUDOERS_TMP"
  echo "refusing to install a sudoers file that does not parse" >&2
  exit 1
fi
rm -f "$SUDOERS_TMP"

log "Application directory"
# Owned by the deploy user, readable by the service through the shared group.
#
# It cannot be root-owned: git refuses to operate on a repository owned by
# someone else, so the CI deploy's `git fetch` would fail with "dubious
# ownership". It must not be owned by the SERVICE account either — the portal
# should not be able to rewrite its own code. The deploy user owns it, the
# service reads it, and each has only what it needs.
#
# It stays world-readable. Caddy serves public/ and public-admin/ straight out
# of here as the `caddy` user, so locking the tree to one group takes both
# sites down. Nothing secret lives in the repo — secrets are in /etc/portal,
# which is 750 root:portal.
install -d -o "$DEPLOY_USER" -g "$APP_USER" -m 755 "$APP_DIR"
# Recursive, so a checkout left root-owned or service-owned by an earlier
# version of this script is repaired on the next run.
chown -R "$DEPLOY_USER":"$APP_USER" "$APP_DIR"
# Directories need +x to be traversed; files only need read. -X makes exactly
# that distinction.
chmod -R a+rX "$APP_DIR"

# Root administers this box and will run git in here by hand. Git refuses to
# operate on a repository owned by someone else — the "dubious ownership" error
# this setup has already hit once — so declare it safe for root, once.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || \
  git config --global --add safe.directory "$APP_DIR"

log "systemd unit"
cp "${APP_DIR}/infra/systemd/portal.service" /etc/systemd/system/portal.service
systemctl daemon-reload
systemctl enable portal

log "Caddy site"
# Caddy refuses to start if it cannot open its log files. `install -d` only
# applies ownership when it CREATES the directory, so an existing root-owned
# /var/log/caddy stayed unwritable and Caddy died with "permission denied".
# Set it every run instead.
install -d /var/log/caddy
if id caddy >/dev/null 2>&1; then
  chown -R caddy:caddy /var/log/caddy
  chmod 750 /var/log/caddy
fi
# The Caddyfile is rendered from the template so ADMIN_HOSTNAME is configured
# in exactly one place: /etc/portal/portal.env.
# shellcheck source=/dev/null
ADMIN_HOSTNAME="$(. /etc/portal/portal.env 2>/dev/null; printf '%s' "${ADMIN_HOSTNAME:-}")"
if [[ -z "$ADMIN_HOSTNAME" ]]; then
  echo "!! ADMIN_HOSTNAME is not set in /etc/portal/portal.env."
  echo "   The staff console will not be served until you set it and re-run this script."
  # A block with no hostname would be a syntax error, so drop it entirely.
  awk '/^\$\{ADMIN_HOSTNAME\} \{/{skip=1} skip&&/^\}/{skip=0;next} !skip' \
    "${APP_DIR}/infra/Caddyfile.template" > /etc/caddy/Caddyfile
else
  # envsubst takes the literal name as its filter list, so the single quotes
  # are correct here — substituting only this one variable keeps Caddy's own
  # {$...} and {path} placeholders untouched.
  # shellcheck disable=SC2016
  ADMIN_HOSTNAME="$ADMIN_HOSTNAME" envsubst '${ADMIN_HOSTNAME}' \
    < "${APP_DIR}/infra/Caddyfile.template" > /etc/caddy/Caddyfile
  echo "staff console will answer on https://${ADMIN_HOSTNAME}"
fi
if ! caddy validate --config /etc/caddy/Caddyfile 2>&1; then
  echo
  echo "!! The Caddy config above did not validate, so Caddy will not start."
  echo "   Fix /etc/caddy/Caddyfile, then: sudo systemctl restart caddy"
  echo "   Everything else on this box is provisioned; re-running this script is safe."
else
  systemctl reload caddy || systemctl restart caddy
fi

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

  6. Create your first staff operator for the admin console:
       node scripts/create-operator.js --email you@dccurrentny.com --name "Your Name" --owner
     Then sign in at https://<ADMIN_HOSTNAME> and manage everything from there.

No Caddy edit is needed. One site block serves every customer, and the
certificate is obtained on the first request to a hostname that belongs
to an active tenant.

Verify once DNS resolves:  curl -s https://<hostname>/readyz
DONE
