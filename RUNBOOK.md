# Portal runbook

Operational reference for the DC Current customer portal. Written to be usable
by whoever is holding the pager, with no prior context.

- **Host:** one DigitalOcean droplet, Ubuntu 24.04
- **App dir:** `/opt/chav`  ·  **Service:** `portal.service`  ·  **Runs as:** `portal`
- **Secrets:** `/etc/portal/portal.env`, `/etc/portal/db.env` (root-owned, mode 640)
- **Database:** local Postgres, `portal` database, **loopback only**

---

## First-time setup

```bash
ssh root@<droplet-ip>
git clone https://github.com/dccurrentny/chav /opt/chav
bash /opt/chav/infra/provision.sh
```

Then, in order:

1. `sudo nano /etc/portal/portal.env` — fill in the five `NS_*` SkySwitch values.
2. Point an A record for your portal hostname at the droplet IP.
3. Set that hostname in `/etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`.
4. `cd /opt/chav/server && npm ci && npm run migrate`
5. `sudo systemctl start portal`
6. Confirm: `curl -s https://<host>/readyz` → `{"ok":true,"db":"up"}`

Caddy obtains the TLS certificate on first request to the hostname. If it does
not, DNS has not propagated yet — check with `dig +short <host>` before
touching anything else.

---

## Everyday operations

| Task | Command |
|---|---|
| Service status | `systemctl status portal` |
| Follow logs | `journalctl -u portal -f` |
| Errors only, last hour | `journalctl -u portal --since -1h -p err` |
| Restart | `sudo systemctl restart portal` |
| Caddy logs | `tail -f /var/log/caddy/portal.log` |
| Is it healthy? | `curl -s localhost:3000/readyz` |

### Add a customer

Every customer gets their own hostname. One app serves all of them; the
hostname decides which customer a request belongs to.

```bash
cd /opt/chav/server
node scripts/seed-tenant.js \
  --name "Acme Electric" \
  --ns-domain acme.yourdomain.com \
  --hostname acme.portal.dccurrentny.com \
  --admin owner@acme.com \
  --color '#2F6FED' --support-email help@dccurrentny.com
```

Then point an A record for that hostname at the droplet. **No Caddy change is
needed** — on-demand TLS obtains the certificate on the first request, gated by
`/internal/tls-check` so only hostnames belonging to an active tenant qualify.

Prints a generated password **once**. Send it over a channel you trust, then
delete your copy. It is not recoverable — to reissue, run again with a
different `--admin` and disable the old user.

### The staff console

Day-to-day customer management happens at `https://<ADMIN_HOSTNAME>` — add and
edit customers, manage their users, reset passwords, suspend accounts, and read
activity across every customer. The `psql` and CLI recipes below remain as the
fallback for when the console itself is the thing that is broken.

Create the first operator (once, at setup — after that, add them in the console):

```bash
cd /opt/chav/server
node scripts/create-operator.js --email you@dccurrentny.com --name "Your Name" --owner
```

`ADMIN_HOSTNAME` in `/etc/portal/portal.env` decides where the console answers.
Changing it means re-running `provision.sh`, which re-renders the Caddyfile.
Leave it blank and no console is served at all.

### Viewing a customer's portal

In the console, open a customer's **Users** and press **View as**. A read-only
copy of their portal opens in a new tab, under a banner naming the operator and
counting down.

Three things hold, and are worth knowing before you rely on it:

- **It cannot change anything.** Writes are refused server-side, not merely
  hidden in the UI. If you need to change a customer's routing, do it from the
  console or talk them through it — never from a support view, because the
  audit trail would then have to choose between naming them or naming you.
- **It ends by itself after 30 minutes**, and the link that opens it is
  single-use and expires in 60 seconds.
- **The customer can see it.** `impersonation.begin` appears in their own
  activity list with the operator's email. That is deliberate: someone who
  looks at an account should leave a mark the account holder can find.

**Operators can see and change every customer.** Keep the list short, and
disable leavers the same day — disabling kills their live sessions at once.

### Point a customer's portal at their line

A customer's portal shows the answer rules for one extension, set per customer
in the console (**Customers → Edit → Main extension**). Until it is set their
portal says the setup is not finished rather than showing anyone else's line —
there is deliberately no default.

### Rebrand a customer

```sql
UPDATE tenants
   SET brand_name = 'Acme Electric Co',
       brand_color = '#1D4ED8',
       logo_url = 'https://…/logo.png',
       support_email = 'help@dccurrentny.com'
 WHERE hostname = 'acme.portal.dccurrentny.com';
```

Takes effect within 30 seconds — hostnames are cached that long in-process.

### Move a customer to a new hostname

```sql
UPDATE tenants SET hostname = 'phones.acme.com'
 WHERE ns_domain = 'acme.yourdomain.com';
```

Point the new DNS record at the droplet. Their existing sessions will not work
on the new hostname — cookies are host-only — so they sign in once more.

### Disable a user or tenant immediately

```sql
-- kills their live sessions on the next request, not just future logins
UPDATE users   SET status = 'disabled'  WHERE email = 'someone@example.com';
UPDATE tenants SET status = 'suspended' WHERE ns_domain = 'acme.yourdomain.com';
```

---

## Incidents

### A customer's portal shows "Portal not found"

Their hostname is not on an active tenant. Check what the database has:

```sql
SELECT name, hostname, status FROM tenants WHERE hostname = '<what they typed>';
```

A typo in `hostname`, a suspended tenant, and a hostname that was never set all
produce this same page — deliberately, so probing cannot enumerate customers.

### A customer's certificate will not issue

Caddy only requests one for a hostname that passes the gate. Test it directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "localhost:3000/internal/tls-check?domain=acme.portal.dccurrentny.com"
```

`200` means Caddy is allowed to issue. `404` means the hostname is not on an
active tenant — fix that first. If it returns 200 and the certificate still
fails, DNS is not pointing here yet: `dig +short <hostname>`.

### Portal returns 502 / Caddy says upstream unavailable

The Node process is down.

```bash
systemctl status portal
journalctl -u portal -n 100 --no-pager
sudo systemctl restart portal
```

If it crash-loops, systemd gives up after 5 starts in 300s — that is deliberate,
so it stops hammering SkySwitch. Read the logs before restarting again. A boot
failure naming an environment variable means `/etc/portal/portal.env` is
incomplete; the process refuses to start on a bad config by design.

### Customers see "SkySwitch did not respond"

That message is accurate: the upstream is unreachable or slow, and **no change
was saved**. Confirm from the box:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$NS_BASE_URL/ns-api/"
```

Nothing to fix locally. Check SkySwitch status, then let customers retry.
Every failed attempt is already in `audit_log` with `result = 'error'`.

### Customers see "something went wrong on our side"

That is a **portal** fault, not SkySwitch. The response carries a `reference`
string; find it:

```bash
journalctl -u portal --since -2h | grep <reference>
```

### Logins failing for everyone

Usually `SESSION_SECRET` changed (rotating it signs everyone out — expected) or
Postgres is down:

```bash
systemctl status postgresql
curl -s localhost:3000/readyz
```

### Disk full

Most likely backups or logs.

```bash
du -sh /var/backups/portal /var/log/caddy /var/log/journal
journalctl --vacuum-size=200M
```

Deletes still succeed when writes fail, so clean up before anything else.

---

## Backups

Nightly `pg_dump` at 03:20 UTC via `portal-backup.timer`, verified with `gzip -t`
before old dumps are pruned, kept 14 days in `/var/backups/portal`.

```bash
systemctl list-timers portal-backup      # when it last ran / runs next
sudo /usr/local/bin/portal-backup        # run one now
```

**DigitalOcean droplet backups are weekly snapshots.** They would lose up to six
days of `audit_log`, which is the one table you cannot reconstruct. That is why
this nightly dump exists. For off-box copies, set `SPACES_BUCKET` and the AWS
credentials in `/etc/portal/backup.env`.

### Restore

```bash
sudo systemctl stop portal
sudo -u postgres dropdb portal && sudo -u postgres createdb portal -O portal
gunzip -c /var/backups/portal/portal-<stamp>.sql.gz | psql "$DATABASE_URL"
sudo systemctl start portal
```

> A backup you have never restored is a hypothesis. Restore one into a scratch
> database once, so the first real attempt is not during an incident.

---

## Rotating SkySwitch credentials

```bash
sudo nano /etc/portal/portal.env     # update NS_PASSWORD / NS_CLIENT_SECRET
sudo systemctl restart portal        # the token cache is in-process; restart clears it
curl -s localhost:3000/readyz
```

Then exercise one real read through the UI to confirm the new credentials work.

---

## Deploys

Merging to `main` triggers `.github/workflows/deploy.yml`, which runs tests,
pushes to the droplet over SSH, migrates, restarts, and **rolls back
automatically** if `/readyz` does not come up within 30 seconds.

Manual deploy, if CI is unavailable:

```bash
cd /opt/chav && git fetch origin main && git reset --hard origin/main
cd server && npm ci --omit=dev && npm run migrate
sudo systemctl restart portal && curl -s localhost:3000/readyz
```

Take a DigitalOcean snapshot before anything unusual. It is a single box; a bad
migration has no other copy to fall back on.

---

## Security invariants

Changing any of these needs a deliberate review, not a quick edit:

1. **The NetSapiens `domain` always comes from the session's tenant.** It is
   injected in `server/src/netsapiens/routes.js` and every operation schema is
   `.strict()`, so a client-supplied `domain` is rejected rather than ignored.
   This is the whole tenant boundary. A test enforces it.
2. **`server/src/netsapiens/allowlist.js` is default-deny.** An operation that
   is not listed cannot be invoked. Adding one grants every customer access to it.
3. **Postgres listens on loopback only.** Verify with `ss -tlnp | grep 5432`.
4. **The firewall allows 22, 80, 443 and nothing else.** `ufw status verbose`.
5. **Secrets live only in `/etc/portal/*.env`**, never in the repo, the systemd
   unit, or a log line. `server/src/logger.js` redacts tokens and passwords.
6. **Writes require the `admin` role and a CSRF header.** Reads do not.
7. **Staff are not users.** Operators live in their own table with their own
   sessions and their own cookie. Never give a `users` row cross-tenant power:
   the tenant boundary depends on every user having exactly one tenant.
8. **The console answers on `ADMIN_HOSTNAME` and nowhere else.** The API 404s
   admin endpoints on any other host and Caddy serves the admin bundle only
   from that block. Both checks matter — keep both.
9. **The hostname decides the tenant, and login is scoped to it.** A user is
   looked up by email *and* tenant, so one customer's credentials do nothing on
   another's portal. `requireAuth` additionally refuses a session whose tenant
   does not match the hostname — defence in depth behind host-only cookies.
10. **`/internal/tls-check` must stay unreachable from outside.** Caddy calls it
   on loopback; the public site block returns 404 for `/internal/*`. Exposing it
   would let anyone enumerate customer hostnames.
