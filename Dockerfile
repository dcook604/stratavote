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

# Install sqlite3 for backups and curl for healthcheck
RUN apk add --no-cache sqlite curl

# Create app user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application files
COPY --chown=nodejs:nodejs . .

# Copy and set up entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create necessary directories with proper permissions
# Note: If these are volume mount points, the mounted volumes will override these settings
# The entrypoint.sh script handles runtime permission checks
RUN mkdir -p logs backups persistent && \
    chown -R nodejs:nodejs /app && \
    chmod -R 755 /app && \
    (chmod +x scripts/backup.sh 2>/dev/null || true)

# Switch to non-root user
USER nodejs

# Expose port (Coolify will map this)
EXPOSE 3300

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3300/healthz || exit 1

# Use entrypoint script to handle runtime setup
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
