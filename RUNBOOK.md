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
4. `set -a; . /etc/portal/db.env; set +a` then `cd /opt/chav/server && npm ci && npm run migrate`
   (`DATABASE_URL` lives only in that file — systemd reads it via
   `EnvironmentFile`, so a plain shell does not have it and the migration
   exits with `DATABASE_URL is not set`.)
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

### Opening a customer's portal as support

Two ways in, both from **Customers**:

- **Open portal** — the customer's portal with no account behind it. For
  checking the setup before they have any users, and for configuring them when
  nobody on their side can yet.
- **Users → View as** — the portal as a particular person sees it, for
  answering "what am I looking at" questions.

Both can change things, and both are recorded against **you**: `actor_kind`
staff, your email, in that customer's own activity list. It never reads as the
customer having made the change, which is the only thing that made this worth
worrying about. They can see that you were in their account, which is
deliberate.

Both end by themselves after 30 minutes, and the link that opens them is
single-use and expires in 60 seconds.

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

### What each customer's portal offers

Customers want different things, so a portal is assembled per customer in
**Customers → Portal setup**. Anything switched off is refused by the server,
not merely hidden, so a customer cannot reach it by other means.

A new customer starts able to read their forwarding and see their history, and
nothing else. Turning on anything that writes is a deliberate act.

### The dispatch schedule

The schedule is the feature most customers will actually want: they name the
people and numbers calls can go to, paint who covers each hour of the week,
and an engine applies the current hour to SkySwitch.

It rewrites one answer rule on the `*` time frame as the hour turns, rather
than creating a time frame per hour. Everything outside that rule is the
customer's own business and is never touched.

- Hours are in the **customer's** timezone (`tenants.timezone`), not the
  server's. A schedule following the server clock would send calls to the
  wrong person for most of the day.
- An unpainted hour means "leave the phone system alone", so a customer can
  schedule part of the week without the engine touching the rest.
- The engine checks every minute and writes only when the destination has
  actually changed. An hourly timer drifts and misses an hour entirely if the
  process restarts across the boundary.
- One customer's SkySwitch being unreachable never stops another customer's
  schedule running. The failure is recorded on their portal and retried.
- Every application is audited as `system`, so a customer can tell an
  automatic change from one a person made.

```sql
-- what the engine last applied, and why it might not have
SELECT t.name, s.applied_target, s.applied_at, s.last_error
  FROM tenant_schedule_state s JOIN tenants t ON t.id = s.tenant_id;
```

### The shared portal and per-customer addresses

`SHARED_PORTAL_HOSTNAME` in `/etc/portal/portal.env` is one address any
customer can sign in to. There the account decides which customer it is: an
email belongs to exactly one user and therefore one customer, so the lookup is
unambiguous, and the session that results carries only that customer.

A customer may also have **their own address** (Customers → Edit → Portal web
address). Leave it blank and they use the shared portal. On their own address
the stricter rule still applies — a sign-in is scoped to that customer, so
another customer's credentials do nothing there.

Neither the shared portal nor the staff console can be claimed as a customer
address; the console refuses it and says what to do instead.

### Which SkySwitch credentials a customer uses

A SkySwitch token carries a scope, and the scope decides what it can reach:

| Scope | Reaches |
|---|---|
| Basic User | that subscriber only |
| Office Manager | that subscriber's domain |
| Reseller | every domain under the reseller |

The **client ID and secret are the reseller's**: one application registration
from SkySwitch, shared by every call this server makes, set once in System
along with the portal address. They are never entered per customer.

What varies per customer is **which Subscriber signs in**, and a Subscriber's
scope is what decides how far the token reaches. Each customer states this in
**Customers → API access**:

- **Shared** — sign in as the one subscriber configured in System. Simplest.
  If that subscriber is Reseller-scoped its token could reach any customer, so
  only this application keeps them apart.
- **Local** — sign in as this customer's own subscriber. An Office Manager
  scoped to their domain is enough, and then SkySwitch enforces the boundary
  as well: a bug in our domain scoping cannot cross it.

Local for every customer is the tighter arrangement and the one to prefer.

The choice is stated, not inferred. A customer set to **local** with fields
still missing cannot reach SkySwitch at all, and says so — it will not quietly
use the reseller credentials instead, which is exactly what choosing local was
meant to avoid.

The server checks before every call that the token's scope covers the domain
being asked about, and refuses otherwise — a request is never sent under
credentials belonging to a different customer.

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

### An operator has lost their phone

They sign in with a **recovery code** instead of the six-digit one — the link is
on the code screen. Each works once; ten are issued at enrolment.

Out of recovery codes too, another **owner** resets them:
Operators → the person → *Reset two-factor*. That clears their authenticator and
signs out every session they have. They set it up again on their next sign-in.

If there is no other owner, and nobody can get in, that is the one case needing
the database directly:

```bash
set -a; . /etc/portal/db.env; set +a
psql "$DATABASE_URL" -c "UPDATE staff SET totp_secret_enc = NULL, \
  totp_confirmed_at = NULL, totp_last_step = NULL WHERE email = 'you@dccurrentny.com'"
```

They are then back to password-only and must enrol again at the next sign-in —
the console refuses everything else until they do.

### Two-factor codes suddenly rejected for everyone

**`SESSION_SECRET` was rotated.** Authenticator secrets are encrypted with a key
derived from it, so rotating it makes every one of them undecryptable — the same
trade-off as the stored SkySwitch credentials, and worth knowing before you
rotate rather than after.

Symptom: the code is right and the server says it is not, and the log has
`could not decrypt a staff TOTP secret`. Fix: clear the secrets as above; every
operator re-enrols. Recovery codes are hashed, not encrypted, so **those still
work** and are the way back in.

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

**This pipeline is not live yet**, and as written it would break the droplet:
it does `git reset --hard origin/main`, and `main` does not contain the portal.
That has to be fixed — by merging the portal to `main`, which is the right
answer — before the workflow is ever enabled. It also needs three things that
do not exist:
a `deploy` user on the droplet with sudo rights for `systemctl restart portal`,
the `DEPLOY_HOST` and `DEPLOY_SSH_KEY` repository secrets, and `deploy.yml`
merged to `main`. Its migrate step also has the `DATABASE_URL` gap described
below and needs the same fix once the deploy user exists — which sudo policy
that user gets is the open question, so it is deliberately not guessed at here.
Until all of that is done, every deploy is the manual one below.

Manual deploy, if CI is unavailable:

**The droplet does not track `main`.** `main` holds an `index.html` left over
from what this repository used to be; the portal has only ever lived on its
feature branch, and `/opt/chav` is checked out to that. Resetting to `main`
empties the checkout and takes the service down with it. Set BRANCH to whatever
`git -C /opt/chav rev-parse --abbrev-ref HEAD` reports before running this, and
fix it properly by merging the portal to `main`.

```bash
BRANCH=claude/web-page-artifact-4qqy2g

cd /opt/chav && git fetch origin "$BRANCH" && git reset --hard "origin/$BRANCH"
cd server && npm ci --omit=dev

# migrate.js reads DATABASE_URL from the environment and nothing else. It is
# only in /etc/portal/db.env, which systemd hands to the service but which a
# shell does not have — without this line the migration exits immediately.
set -a; . /etc/portal/db.env; set +a
npm run migrate

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
8. **The staff console requires a second factor.** `ADMIN_REQUIRE_2FA` defaults
   to on, and `requireSecondFactor` gates every management endpoint — an
   operator without one can reach the enrolment screen and nothing else. It
   fails closed: if the check itself errors, the answer is no. Turning it off is
   a decision to make deliberately and put back, not a way round a bad phone —
   use an owner reset for that.
9. **The console answers on `ADMIN_HOSTNAME` and nowhere else.** The API 404s
   admin endpoints on any other host and Caddy serves the admin bundle only
   from that block. Both checks matter — keep both.
10. **The hostname decides the tenant, and login is scoped to it.** A user is
   looked up by email *and* tenant, so one customer's credentials do nothing on
   another's portal. `requireAuth` additionally refuses a session whose tenant
   does not match the hostname — defence in depth behind host-only cookies.
11. **`/internal/tls-check` must stay unreachable from outside.** Caddy calls it
   on loopback; the public site block returns 404 for `/internal/*`. Exposing it
   would let anyone enumerate customer hostnames.
