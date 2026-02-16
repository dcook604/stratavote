# Coolify Deployment Guide

This guide explains how to deploy Spectrum 4 Voting System on Coolify.

## How Permission Handling Works

The application automatically handles volume permissions at startup:

1. Container starts as **root**
2. Entrypoint script fixes ownership of mounted volumes (sets to nodejs:nodejs)
3. Script drops privileges to **nodejs user** (UID 1001)
4. Application runs as non-root user

**You don't need to manually fix permissions.** The container handles it automatically.

## Simple Setup in Coolify

### Step 1: Add Persistent Storage

1. **Go to your application → Storage → Add Volume**
   - Name: `persistent-data`
   - Source: Leave empty (Docker-managed) or specify a path
   - Destination: `/app/persistent`
   - That's it! The container will fix permissions automatically.

### Step 2: Set Environment Variables

See the Environment Variables section below.

### Step 3: Deploy

Click "Deploy" in Coolify. The application will:
- Start as root
- Fix volume permissions
- Drop to nodejs user
- Start the application

No manual intervention needed!

## Environment Variables

Required environment variables in Coolify:

```bash
# Required
ADMIN_PASSWORD=your_secure_admin_password
SESSION_SECRET=your_32_char_session_secret
BASE_URL=https://vote.yourdomain.com

# Optional
PORT=3300
NODE_ENV=production

# Email (optional - for sending voter links)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@email.com
SMTP_PASS=your_smtp_password
SMTP_FROM=noreply@yourdomain.com
```

Generate secrets:
```bash
# Session secret (32+ characters)
openssl rand -base64 32

# Admin password
openssl rand -base64 24
```

## Verification

After deployment, check the logs:

```bash
# In Coolify, view application logs
# You should see:

🚀 Starting Spectrum 4 Voting System...
📁 Creating directory: /app/persistent
✅ Directory writable: /app/persistent
📁 Creating directory: /app/logs
✅ Directory writable: /app/logs
📁 Creating directory: /app/backups
✅ Directory writable: /app/backups
📊 Using persistent storage: /app/persistent/data.sqlite
✅ All directories ready
🎯 Starting Node.js application...

Server started on port 3300
```

If you see ❌ errors, the volume permissions are wrong.

## Troubleshooting

### Data Not Persisting

**Cause:** Volume is not mounted correctly

**Fix:**
1. Check Storage tab in Coolify
2. Verify volume is mounted to `/app/persistent`
3. Check volume exists: `sudo ls -la /var/lib/coolify/applications/<app-id>/volumes/`

## Why This Works

1. **Dockerfile** builds the image without assuming volume permissions
2. **Container starts as root** (standard Docker practice for init scripts)
3. **Entrypoint script runs as root**:
   - Creates directories if needed
   - Fixes ownership to nodejs:nodejs
   - Sets proper permissions
4. **Script drops to nodejs user** using `su-exec`
5. **Application runs as non-root** (secure)

This is how most production containers handle volume permissions. No manual fixes needed!

## No Setup Script Needed!

The container handles all permission setup automatically. Just deploy!

## Best Practices

1. **Set up volumes BEFORE first deployment** to avoid empty database issues
2. **Use Docker-managed volumes** (don't specify host paths) for simplicity
3. **The container starts as root** but drops to nodejs user - this is safe and standard
4. **Monitor logs** after deployment to see the permission setup in action
5. **Backup your database** regularly:
   ```bash
   # From Coolify server
   sudo cp /var/lib/coolify/applications/<app-id>/volumes/persistent/data.sqlite ~/backup-$(date +%Y%m%d).sqlite
   ```

## Docker Compose Example (Alternative to Coolify UI)

If you prefer Docker Compose:

```yaml
services:
  vote:
    build: .
    ports:
      - "3300:3300"
    environment:
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - SESSION_SECRET=${SESSION_SECRET}
      - BASE_URL=${BASE_URL}
    volumes:
      - vote-data:/app/persistent:rw
    restart: unless-stopped
    user: "1001:1001"  # Run as nodejs user

volumes:
  vote-data:
    driver: local
```

Deploy with:
```bash
docker-compose up -d
```

## Support

If you still encounter permission issues after following this guide:

1. Check Docker logs for specific error messages
2. Verify UID 1001 exists and has write permissions on host
3. Ensure no SELinux/AppArmor restrictions are blocking access
4. Try using a named volume instead of a bind mount

## Summary

✅ **DO:**
- Use Coolify's volume management
- Set host directory ownership to 1001:1001 once
- Use named volumes for simplicity
- Check logs after deployment

❌ **DON'T:**
- Manually `chown` files inside running containers
- Run containers as root
- Ignore permission errors in logs
- Forget to mount /app/persistent volume
