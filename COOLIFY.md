# Deploying Strata Vote to Coolify

This guide will walk you through deploying the Strata Vote application to Coolify, a self-hosted PaaS platform.

## Prerequisites

- Coolify instance up and running
- GitHub repository: https://github.com/dcook604/stratavote
- Domain name (optional but recommended for HTTPS)

## Quick Start (5 Minutes)

### Step 1: Create New Application in Coolify

1. Log in to your Coolify dashboard
2. Click **"+ New Resource"** → **"Application"**
3. Select **"Public Repository"**
4. Enter repository URL: `https://github.com/dcook604/stratavote.git`
5. Click **"Continue"**

### Step 2: Configure Build Settings

**Build Pack:** Dockerfile (Auto-detected)
- Coolify will automatically detect the `Dockerfile` in the repository
- No additional build configuration needed

**Port:** `3300`
- The application listens on port 3300
- Coolify will automatically expose this port

### Step 3: Set Environment Variables

Click on **"Environment Variables"** and add the following:

#### Required Variables

```
NODE_ENV=production
ADMIN_PASSWORD=<generate-strong-password-20+-chars>
SESSION_SECRET=<generate-with-openssl-rand-base64-32>
```

#### Optional Variables

```
BASE_URL=https://vote.yourdomain.com
PORT=3300
LOG_LEVEL=info
IP_HASH_SALT=<random-hex-string>
```

**Generate Secrets:**
```bash
# Generate SESSION_SECRET
openssl rand -base64 32

# Generate IP_HASH_SALT
openssl rand -hex 16
```

### Step 4: Configure Persistent Storage ⚠️ CRITICAL

**This step is REQUIRED to prevent data loss!**

1. Go to **"Storages"** tab
2. Click **"+ Add Storage"** for each volume below:

| Destination Path (Container) | Description | Required |
|------------------------------|-------------|----------|
| `/app/data` | **SQLite database storage** | ✅ YES |
| `/app/logs` | Application logs | Recommended |
| `/app/backups` | Database backups | Recommended |

**For each storage:**
- Leave **"Source Path"** empty (Coolify auto-generates)
- Set **"Destination Path"** exactly as shown above
- Click **"Save"**

**Note:** Without persistent storage, ALL DATA WILL BE LOST on container restart!

📖 **Detailed guide:** See `PERSISTENT_STORAGE.md` in repository

### Step 5: Configure Domain & HTTPS

1. Go to **"Domains"** tab
2. Click **"+ Add Domain"**
3. Enter your domain: `vote.yourdomain.com`
4. Enable **"HTTPS"** toggle
5. Coolify will automatically provision Let's Encrypt SSL certificate

**If you don't have a domain:**
- Coolify will assign a temporary domain like `stratavote.coolify.yourdomain.com`
- You can use this for testing

### Step 6: Configure Health Checks

1. Go to **"Health Checks"** tab
2. Enable health checks
3. Configure:
   - **Path:** `/health`
   - **Port:** `3300`
   - **Interval:** `30s`
   - **Timeout:** `3s`
   - **Retries:** `3`

The application provides two health check endpoints:
- `/health` - Detailed health status with database check
- `/healthz` - Simple OK response for load balancers

### Step 7: Deploy

1. Click **"Deploy"** button
2. Monitor build logs in real-time
3. Wait for deployment to complete (usually 1-2 minutes)
4. Access your application at the configured domain

## Post-Deployment

### Verify Deployment

1. **Check Health:**
   ```bash
   curl https://vote.yourdomain.com/healthz
   # Should return: OK

   curl https://vote.yourdomain.com/health
   # Should return JSON with status: "healthy"
   ```

2. **Access Admin Panel:**
   - Navigate to: `https://vote.yourdomain.com/admin/login`
   - Login with your `ADMIN_PASSWORD`

3. **Run Smoke Test** (from your local machine):
   ```bash
   # Update smoke-test.sh to use your domain
   sed -i 's|http://localhost:3300|https://vote.yourdomain.com|g' smoke-test.sh

   # Update password in script to match ADMIN_PASSWORD
   sed -i 's|dev_admin_password_at_least_20_characters|YOUR_PASSWORD|g' smoke-test.sh

   # Run test
   bash smoke-test.sh
   ```

### Set Up Automated Backups

Coolify doesn't automatically run scripts inside containers, so set up backups manually:

1. **SSH into your Coolify server**

2. **Create backup script:**
   ```bash
   sudo nano /usr/local/bin/backup-stratavote.sh
   ```

3. **Add content:**
   ```bash
   #!/bin/bash
   CONTAINER_ID=$(docker ps | grep stratavote | awk '{print $1}')
   if [ -n "$CONTAINER_ID" ]; then
     docker exec $CONTAINER_ID /app/scripts/backup.sh
     echo "Backup completed: $(date)"
   else
     echo "Container not running"
   fi
   ```

4. **Make executable:**
   ```bash
   sudo chmod +x /usr/local/bin/backup-stratavote.sh
   ```

5. **Add to crontab:**
   ```bash
   sudo crontab -e
   # Add: Run daily at 2 AM
   0 2 * * * /usr/local/bin/backup-stratavote.sh >> /var/log/stratavote-backup.log 2>&1
   ```

### Monitor Logs

In Coolify dashboard:
1. Go to your application
2. Click **"Logs"** tab
3. View real-time application logs

Or via CLI:
```bash
# SSH to Coolify server
docker logs -f <container-name>

# View application logs
docker exec <container-name> tail -f /app/logs/combined.log

# View error logs only
docker exec <container-name> tail -f /app/logs/error.log
```

## Updating the Application

When you push updates to GitHub:

1. Coolify can auto-deploy on git push (enable in Settings → "Auto Deploy")
2. Or manually click **"Deploy"** in Coolify dashboard
3. Coolify will:
   - Pull latest code from GitHub
   - Rebuild Docker image
   - Rolling restart with zero downtime
   - Database and volumes persist across deployments

## Troubleshooting

### Application Won't Start

**Check environment variables:**
```bash
docker exec <container-name> env | grep -E "ADMIN_PASSWORD|SESSION_SECRET|NODE_ENV"
```

**View startup logs:**
```bash
docker logs <container-name> --tail 50
```

### Database Issues

**Check database file permissions:**
```bash
docker exec <container-name> ls -la /app/data.sqlite
```

**Verify WAL mode:**
```bash
docker exec <container-name> sqlite3 /app/data.sqlite "PRAGMA journal_mode;"
# Should output: wal
```

### Health Check Failing

**Test health endpoint manually:**
```bash
docker exec <container-name> wget -qO- http://localhost:3300/health
```

**Check if app is listening:**
```bash
docker exec <container-name> netstat -tlnp | grep 3300
```

### Session/Login Issues

**Verify SESSION_SECRET is set:**
```bash
docker exec <container-name> node -e "console.log(process.env.SESSION_SECRET?.length || 0)"
# Should be > 32
```

**Check secure cookie settings:**
- Ensure `NODE_ENV=production` is set
- Ensure domain is using HTTPS
- Clear browser cookies and try again

### Rate Limiting Issues

If legitimate users are being rate limited:

1. Check logs for the client IP
2. Rate limits:
   - Login: 5 attempts per 15 minutes
   - Voting: 10 attempts per minute
3. Restart container to reset rate limit counters (temporary fix)
4. Consider adjusting rate limits in `server.js` if needed

## Advanced Configuration

### Custom Domain with Subdomain

If using a subdomain like `vote.yourdomain.com`:

1. Add DNS A record pointing to Coolify server IP
2. Wait for DNS propagation (5-60 minutes)
3. Add domain in Coolify
4. Enable HTTPS - Coolify handles Let's Encrypt automatically

### Multiple Instances (High Availability)

Coolify supports horizontal scaling:

1. Go to **"Advanced"** → **"Replicas"**
2. Set number of instances (e.g., 2)
3. Coolify will:
   - Run multiple containers
   - Load balance between them
   - Share the same persistent volumes

**Note:** Session storage is in-memory, so sticky sessions are required for multiple instances.

### Custom Backup Schedule

Edit the backup script to customize retention:

```bash
# In /app/scripts/backup.sh, change:
find "$BACKUP_DIR" -name "data_*.sqlite" -mtime +7 -delete
# To keep backups for 30 days:
find "$BACKUP_DIR" -name "data_*.sqlite" -mtime +30 -delete
```

### Resource Limits

In Coolify → **"Resources"** tab:

Recommended limits:
- **Memory:** 512 MB (minimum), 1 GB (recommended)
- **CPU:** 0.5 cores (minimum), 1 core (recommended)
- **Disk:** 5 GB (minimum for logs and backups)

### Environment-Specific Configurations

Create multiple applications in Coolify for different environments:

- **Development:** `vote-dev.yourdomain.com`
  - Different GitHub branch: `develop`
  - Lower resource limits
  - More verbose logging (`LOG_LEVEL=debug`)

- **Staging:** `vote-staging.yourdomain.com`
  - Same config as production
  - Test updates before production deploy

- **Production:** `vote.yourdomain.com`
  - Production environment variables
  - Auto-deploy disabled (manual approval)

## Security Checklist

- [ ] Strong `ADMIN_PASSWORD` set (20+ characters)
- [ ] Random `SESSION_SECRET` generated (32+ characters)
- [ ] `NODE_ENV=production` set
- [ ] HTTPS enabled with valid certificate
- [ ] Database backups running daily
- [ ] Health checks enabled
- [ ] Firewall configured (only ports 80/443 open)
- [ ] Coolify access secured (strong password, 2FA)
- [ ] Regular security updates (`docker pull` and redeploy)

## Support

- **Application Issues:** https://github.com/dcook604/stratavote/issues
- **Coolify Issues:** https://github.com/coollabsio/coolify/discussions
- **Documentation:** See README.md in repository

## Quick Reference

| Feature | Value/Path |
|---------|------------|
| Repository | https://github.com/dcook604/stratavote.git |
| Build Type | Dockerfile |
| Port | 3300 |
| Health Check | /health or /healthz |
| Admin Login | /admin/login |
| Database Path | /app/data.sqlite |
| Logs Path | /app/logs/ |
| Backups Path | /app/backups/ |

---

**Deployment Time:** ~5 minutes
**First-Time Setup:** ~15 minutes
**Zero Downtime Updates:** ✅ Yes
**Auto Scaling:** ✅ Supported
**HTTPS:** ✅ Automatic with Let's Encrypt
