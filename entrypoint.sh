#!/bin/sh
set -e

# This entrypoint runs as the nodejs user (UID 1001)
# It handles directory setup at runtime, not build time

echo "🚀 Starting Spectrum 4 Voting System..."

# Function to safely create directory and set permissions
setup_dir() {
  local dir=$1

  if [ ! -d "$dir" ]; then
    echo "📁 Creating directory: $dir"
    mkdir -p "$dir" 2>/dev/null || {
      echo "⚠️  Cannot create $dir - may already exist or mounted volume"
    }
  fi

  # Check if we can write to the directory
  if [ -w "$dir" ]; then
    echo "✅ Directory writable: $dir"
  else
    echo "❌ ERROR: Cannot write to $dir"
    echo "This directory needs to be writable by UID 1001 (nodejs user)"
    echo ""
    echo "To fix this in Coolify:"
    echo "1. SSH to your server"
    echo "2. Find the volume path:"
    echo "   sudo ls -la /var/lib/coolify/applications/*/volumes/"
    echo "3. Fix permissions:"
    echo "   sudo chown -R 1001:1001 /var/lib/coolify/applications/YOUR_APP_ID/volumes/persistent"
    echo ""
    exit 1
  fi
}

# Setup directories
setup_dir "/app/persistent"
setup_dir "/app/logs"
setup_dir "/app/backups"

# Check database path
if [ -d "/app/persistent" ]; then
  DB_PATH="/app/persistent/data.sqlite"
  echo "📊 Using persistent storage: $DB_PATH"
else
  DB_PATH="/app/data.sqlite"
  echo "📊 Using ephemeral storage: $DB_PATH"
  echo "⚠️  WARNING: Data will not persist across deployments!"
fi

# Verify we can create/write to database location
DB_DIR=$(dirname "$DB_PATH")
if [ ! -w "$DB_DIR" ]; then
  echo "❌ ERROR: Cannot write to database directory: $DB_DIR"
  exit 1
fi

echo "✅ All directories ready"
echo "🎯 Starting Node.js application..."
echo ""

# Execute the main command (node server.js)
exec "$@"
