#!/bin/sh
# Respaldo diario de la base (programar con cron en el VPS y copiar el
# archivo fuera del servidor, p. ej. a un bucket S3/R2).
#   0 3 * * * /srv/clivora/deploy/backup.sh
set -e
STAMP=$(date +%Y%m%d-%H%M)
DEST=${BACKUP_DIR:-/srv/clivora/backups}
mkdir -p "$DEST"
docker compose -f "$(dirname "$0")/docker-compose.yml" exec -T db \
  pg_dump -U clivora -Fc clivora > "$DEST/clivora-$STAMP.dump"
find "$DEST" -name 'clivora-*.dump' -mtime +14 -delete
