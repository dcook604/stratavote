# Coolify Deployment Guide

This guide explains how to properly deploy Spectrum 4 Voting System on Coolify **without** needing manual permission fixes.

## The Problem We're Solving

Docker volumes mounted by Coolify may have incorrect ownership, causing permission errors when the Node.js application (running as UID 1001) tries to write to them.

**You should NEVER need to manually `chown` as root.** This guide shows the proper way to configure Coolify.

## Proper Setup (Choose One Method)

### Method 1: Configure Volume Permissions in Coolify (Recommended)

When creating your application in Coolify:

1. **Go to your application → Storage → Add Volume**
   - Name: `persistent-data`
   - Source: (auto-generated path)
   - Destination: `/app/persistent`

2. **Set the correct ownership:**

   ```bash
   # SSH to your Coolify server
   ssh your-server

   # Find your application's volume path
   sudo ls -la /var/lib/coolify/applications/

   # Identify your app by name, copy the app ID
   # The path will look like: /var/lib/coolify/applications/<app-id>/volumes/persistent

   # Set ownership to UID 1001 (nodejs user in container)
   sudo chown -R 1001:1001 /var/lib/coolify/applications/<app-id>/volumes/persistent

   # Verify
   sudo ls -la /var/lib/coolify/applications/<app-id>/volumes/
   ```

3. **Deploy your application**
   - The entrypoint script will verify permissions
   - If permissions are correct, the app will start successfully
   - If not, you'll see a clear error message in logs

### Method 2: Use Docker User Namespace Remapping

Configure Docker to automatically remap UIDs on the host. This is more complex but eliminates permission issues system-wide.

See: https://docs.docker.com/engine/security/userns-remap/

### Method 3: Use a Named Volume (Simplest)

Instead of binding to a host path, use a Docker-managed named volume:

1. In Coolify, create a **Named Volume** instead of a bind mount
2. Docker will handle permissions automatically
3. Your data will be stored in Docker's volume directory

**In Coolify:**
- Storage → Add Volume
- Use a simple name like `persistent-data`
- Don't specify a host path
- Set mount point: `/app/persistent`

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

### Error: "Cannot write to /app/persistent"

**Cause:** Volume is owned by wrong user (probably root)

**Fix:**
```bash
# SSH to Coolify server
sudo chown -R 1001:1001 /var/lib/coolify/applications/<app-id>/volumes/persistent

# Restart container in Coolify
```

### Error: "SQLITE_CANTOPEN"

**Cause:** Database directory is not writable

**Fix:** Same as above - fix volume ownership

### Data Not Persisting

**Cause:** Volume is not mounted correctly

**Fix:**
1. Check Storage tab in Coolify
2. Verify volume is mounted to `/app/persistent`
3. Check volume exists: `sudo ls -la /var/lib/coolify/applications/<app-id>/volumes/`

## Why This Works

1. **Dockerfile** creates directories at build time (ownership: nodejs:nodejs, UID 1001)
2. **Coolify mounts volume** over `/app/persistent` (may override ownership)
3. **Entrypoint script** runs as UID 1001 at container start:
   - Checks if directories are writable
   - Provides clear error messages if not
   - Exits with error instead of failing silently
4. **You fix permissions once** on the host volume directory
5. **All future deployments work** without manual intervention

## One-Time Setup Script

After creating your app in Coolify, run this once:

```bash
#!/bin/bash

# Replace with your actual app ID from Coolify
APP_ID="your-app-id-here"

VOLUME_PATH="/var/lib/coolify/applications/$APP_ID/volumes/persistent"

echo "Setting up persistent storage for app: $APP_ID"

# Create the directory if it doesn't exist
sudo mkdir -p "$VOLUME_PATH"

# Set ownership to UID 1001 (nodejs user)
sudo chown -R 1001:1001 "$VOLUME_PATH"

# Set permissions (rwxr-xr-x)
sudo chmod -R 755 "$VOLUME_PATH"

# Verify
echo ""
echo "Permissions set:"
sudo ls -la "$VOLUME_PATH"
echo ""
echo "✅ Done! Now deploy your application in Coolify."
```

Save this as `setup-coolify-volume.sh`, make it executable, and run it:

```bash
chmod +x setup-coolify-volume.sh
./setup-coolify-volume.sh
```

## Best Practices

1. **Set up volumes BEFORE first deployment** to avoid empty database issues
2. **Use named volumes** when possible (Docker handles permissions)
3. **Never run containers as root** - the nodejs user (UID 1001) is safer
4. **Monitor logs** after deployment to catch permission issues early
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
