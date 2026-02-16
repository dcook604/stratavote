#!/bin/bash
# Database backup script
# Usage: ./scripts/backup.sh

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
DB_FILE="${DB_FILE:-./data.sqlite}"

mkdir -p "$BACKUP_DIR"

# SQLite backup command
sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/data_$TIMESTAMP.sqlite'"

# Keep only last 7 days of backups
find "$BACKUP_DIR" -name "data_*.sqlite" -mtime +7 -delete

echo "Backup created: $BACKUP_DIR/data_$TIMESTAMP.sqlite"
