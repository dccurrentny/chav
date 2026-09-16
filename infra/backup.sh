#!/usr/bin/env bash
# Nightly pg_dump. DigitalOcean's droplet backups are WEEKLY snapshots, which
# would lose up to six days of audit_log — the one table you cannot rebuild.
#
# Optional off-box copy to DO Spaces: set these in /etc/portal/backup.env
#   SPACES_BUCKET=s3://my-bucket/portal
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL
set -euo pipefail

BACKUP_DIR="/var/backups/portal"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/portal-${STAMP}.sql.gz"

# shellcheck source=/dev/null
[[ -f /etc/portal/db.env ]] && source /etc/portal/db.env

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL not set; cannot back up" >&2
  exit 1
fi

install -d -m 700 "$BACKUP_DIR"

pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "$FILE"
chmod 600 "$FILE"

# A dump that cannot be decompressed is not a backup. Verify before pruning.
if ! gzip -t "$FILE"; then
  echo "backup verification FAILED for $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

SIZE="$(du -h "$FILE" | cut -f1)"
echo "backup ok: $FILE ($SIZE)"

if [[ -n "${SPACES_BUCKET:-}" ]] && command -v aws >/dev/null; then
  aws s3 cp "$FILE" "${SPACES_BUCKET}/" --endpoint-url "${AWS_ENDPOINT_URL:?}" --only-show-errors \
    && echo "copied off-box to ${SPACES_BUCKET}" \
    || echo "WARNING: off-box copy failed; local copy retained" >&2
fi

# Prune only after a verified new dump exists.
find "$BACKUP_DIR" -name 'portal-*.sql.gz' -mtime "+${RETAIN_DAYS}" -delete
