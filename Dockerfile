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

# Create necessary directories with proper permissions
# IMPORTANT: Must create and set permissions BEFORE switching to nodejs user
RUN mkdir -p /app/data /app/logs /app/backups && \
    chown -R nodejs:nodejs /app && \
    chmod -R 775 /app && \
    chmod -R 775 /app/data /app/logs /app/backups && \
    (chmod +x scripts/backup.sh 2>/dev/null || true)

# Switch to non-root user
USER nodejs

# Declare volumes for persistent storage AFTER user switch
# These directories will be mounted from host at runtime
VOLUME ["/app/data", "/app/logs", "/app/backups"]

# Expose port (Coolify will map this)
EXPOSE 3300

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3300/healthz || exit 1

# Start application
CMD ["node", "server.js"]
