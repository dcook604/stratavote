#!/bin/sh
set -e

echo "🚀 Starting Spectrum 4 Voting System..."

# This script runs as ROOT initially to fix permissions
# Then drops to nodejs user to run the application

# Function to ensure directory exists and has correct permissions
setup_directory() {
  local dir=$1
  echo "📁 Setting up directory: $dir"

  # Create directory if it doesn't exist
  mkdir -p "$dir"

  # Set ownership to nodejs user (UID 1001, GID 1001)
  chown -R nodejs:nodejs "$dir"

  # Set permissions (rwxr-xr-x)
  chmod -R u=rwX,g=rX,o= "$dir"

  echo "✅ $dir ready"
}

# Setup all required directories with correct permissions
setup_directory "/app/persistent"
setup_directory "/app/logs"
setup_directory "/app/backups"

# Determine database path
if [ -d "/app/persistent" ]; then
  echo "📊 Using persistent storage: /app/persistent/data.sqlite"
else
  echo "📊 Using ephemeral storage: /app/data.sqlite"
  echo "⚠️  WARNING: Data will not persist across deployments!"
fi

echo "✅ All directories configured"
echo "🎯 Starting application as nodejs user..."
echo ""

# Drop to nodejs user and execute the main command
exec su-exec nodejs "$@"
