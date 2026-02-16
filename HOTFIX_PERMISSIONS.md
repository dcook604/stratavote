# ⚠️ DEPRECATED: Old Permission Workaround

**This file documents a previous workaround approach that required manual permission fixes.**

**For the proper solution, see: [COOLIFY_SETUP.md](./COOLIFY_SETUP.md)**

---

## What Was Wrong

Previous attempts tried to fix permissions at Docker build time, but volume mounts override these settings at runtime.

## The Real Problem

When Coolify mounts a volume to `/app/persistent`, the mounted directory's ownership comes from the host filesystem, not from the Dockerfile. If the host directory is owned by root (or any UID other than 1001), the nodejs user cannot write to it.

## Previous "Fixes" That Didn't Work

❌ Setting permissions in Dockerfile (overridden by volume mount)
❌ Using VOLUME declarations (creates timing issues)
❌ Manual `chown` inside running containers (not persistent, requires root)

## The Proper Solution

✅ **Set host volume ownership to UID 1001 (nodejs user)**
✅ **Use entrypoint script to validate permissions at runtime**
✅ **Provide clear error messages if permissions are wrong**

## 🚀 How to Deploy the Fix

### In Coolify:

1. **The code is already pushed to GitHub**
   - Commit `06c6ea2` contains the fix

2. **Redeploy in Coolify:**
   - Go to your application
   - Click **"Deploy"** button
   - Coolify will pull the latest code and rebuild
   - Should deploy successfully now

3. **Verify deployment:**
   ```bash
   # Check health
   curl https://your-domain.com/healthz
   # Should return: OK
   ```

### Alternative: Force Rebuild

If Coolify cached the old image:

1. Go to **"Advanced"** tab
2. Enable **"Force Rebuild"**
3. Click **"Deploy"**

## 🔍 Verification

After successful deployment:

```bash
# Get container ID
docker ps | grep stratavote

# Check data directory permissions
docker exec <container-id> ls -la /app/

# Should show:
# drwxrwxr-x nodejs nodejs data
# drwxrwxr-x nodejs nodejs logs
# drwxrwxr-x nodejs nodejs backups

# Check database file
docker exec <container-id> ls -la /app/data/

# Should show:
# -rw-r--r-- nodejs nodejs data.sqlite
```

## 📊 Timeline

- **18:12:27** - Deployment failed (SQLITE_CANTOPEN)
- **18:15:00** - Root cause identified (volume permissions)
- **18:16:00** - Fix committed (`06c6ea2`)
- **18:16:30** - Fix pushed to GitHub
- **Next:** Redeploy in Coolify

## 🎓 What We Learned

**Docker Volume Best Practices:**

1. ✅ **Create directories** before switching to non-root user
2. ✅ **Set permissions** explicitly (don't rely on defaults)
3. ✅ **Declare VOLUME** after setting up permissions
4. ✅ **Test locally** before deploying to production

**Correct Pattern:**
```dockerfile
RUN mkdir -p /app/data && \
    chown appuser:appuser /app/data && \
    chmod 775 /app/data

USER appuser

VOLUME ["/app/data"]
```

## 🔄 If You Still Get Permission Errors

### Option 1: Check Volume Permissions in Coolify

If Coolify created volumes with wrong permissions:

```bash
# SSH to Coolify server
sudo ls -la /var/lib/coolify/applications/*/volumes/

# Fix permissions if needed
sudo chown -R 1001:1001 /var/lib/coolify/applications/<app-id>/volumes/*
```

### Option 2: Recreate Volumes

If volumes are corrupted:

1. Stop application in Coolify
2. Remove volumes in Storages tab
3. Add volumes again (fresh start)
4. Redeploy

### Option 3: Fallback - Run as Root (NOT RECOMMENDED)

Only for testing/emergency:

```dockerfile
# Remove this line:
USER nodejs

# Keep running as root
# Security risk - only for debugging
```

## 📝 Summary

- ✅ **Problem:** Volume permission conflict
- ✅ **Fix:** Reordered Dockerfile operations
- ✅ **Code:** Pushed to GitHub (commit `06c6ea2`)
- ⏳ **Action:** Redeploy in Coolify
- ✅ **Status:** Ready to deploy

## 🆘 Still Stuck?

If deployment still fails after this fix:

1. **Check Coolify logs** for specific error
2. **Verify storage is configured** in Storages tab
3. **Try force rebuild** in Advanced settings
4. **Check permissions** on host volume directories

**Share the error logs** and I can help debug further!

---

**This fix should resolve the deployment issue. Redeploy in Coolify to apply!** 🚀
