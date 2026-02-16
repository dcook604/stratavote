# Multi-stage build for production-ready Strata Vote application
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Production stage
FROM node:18-alpine

# Install sqlite3 for backups
RUN apk add --no-cache sqlite

# Create app user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application files
COPY --chown=nodejs:nodejs . .

# Debug: List files to verify copy
RUN ls -la /app/ && echo "=== Checking for server.js ===" && ls -la /app/server.js || echo "server.js NOT FOUND!"

# Create necessary directories with proper permissions
RUN mkdir -p logs backups && \
    chown -R nodejs:nodejs logs backups && \
    (chmod +x scripts/backup.sh 2>/dev/null || true)

# Switch to non-root user
USER nodejs

# Expose port (Coolify will map this)
EXPOSE 3300

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3300/healthz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "server.js"]
