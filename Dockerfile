# Multi-stage build for production-ready Strata Vote application
FROM node:18-alpine AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Production stage
FROM node:18-alpine

# Install runtime dependencies
# su-exec: drop privileges from root to nodejs user (like gosu but for Alpine)
# sqlite: for database operations and backups
# curl: for healthcheck
RUN apk add --no-cache su-exec sqlite curl

# Create app user for security (will drop to this user after fixing permissions)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application files
COPY --chown=nodejs:nodejs . .

# Copy docker entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create necessary directories with proper permissions
# Note: Mounted volumes will override these, but the entrypoint will fix them at runtime
RUN mkdir -p logs backups persistent && \
    chown -R nodejs:nodejs /app && \
    chmod -R 755 /app && \
    (chmod +x scripts/backup.sh 2>/dev/null || true)

# DO NOT switch to nodejs user here
# The entrypoint script needs to run as root to fix volume permissions
# It will then drop to nodejs user before starting the application

# Expose port (Coolify will map this)
EXPOSE 3300

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3300/healthz || exit 1

# Use entrypoint script to fix permissions at runtime, then drop to nodejs user
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
