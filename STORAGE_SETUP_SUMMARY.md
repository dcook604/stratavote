# Persistent Storage Setup - Summary

## ✅ Changes Made

### 1. Dockerfile Updated
- ✅ Added `VOLUME` declarations for `/app/data`, `/app/logs`, `/app/backups`
- ✅ Created `data` directory during build
- ✅ Proper permissions set for nodejs user

### 2. Database Path Changed
- **Before:** `/app/data.sqlite` (root of app directory)
- **After:** `/app/data/data.sqlite` (dedicated data directory)
- ✅ Auto-creates data directory if missing

### 3. Configuration Files Updated
- ✅ `.dockerignore` - Excludes data directory from image
- ✅ `scripts/backup.sh` - Uses new database path
- ✅ `COOLIFY.md` - Updated storage instructions
- ✅ `PERSISTENT_STORAGE.md` - Complete setup guide created

## 🚨 IMPORTANT: Action Required

**The Dockerfile changes alone are NOT enough!**

You must configure persistent storage in Coolify **before deploying** to prevent data loss.

## 📋 Deployment Checklist

### For New Deployments:

- [ ] 1. Commit and push changes to GitHub
- [ ] 2. Go to Coolify dashboard → Your app → **"Storages"** tab
- [ ] 3. Add storage: Destination = `/app/data` (REQUIRED)
- [ ] 4. Add storage: Destination = `/app/logs` (Recommended)
- [ ] 5. Add storage: Destination = `/app/backups` (Recommended)
- [ ] 6. Click **"Deploy"**
- [ ] 7. Verify data persists after restart

### For Existing Deployments with Data:

**⚠️ You have existing data that needs to be migrated!**

#### Migration Steps:

1. **Backup current database:**
   ```bash
   # SSH to Coolify server
   docker exec <container-name> cp /app/data.sqlite /app/backups/pre-migration-backup.sqlite

   # Download backup to local
   docker cp <container-name>:/app/backups/pre-migration-backup.sqlite ./backup.sqlite
   ```

2. **Add persistent storage in Coolify:**
   - Go to Storages tab
   - Add `/app/data` volume
   - Add `/app/logs` volume
   - Add `/app/backups` volume

3. **Push code changes:**
   ```bash
   git add .
   git commit -m "Add persistent storage support"
   git push origin main
   ```

4. **Deploy updated application:**
   - Click "Deploy" in Coolify
   - Wait for deployment to complete

5. **Restore data to new location:**
   ```bash
   # Upload backup to container
   docker cp ./backup.sqlite <new-container-name>:/app/data/data.sqlite

   # Fix permissions
   docker exec <new-container-name> chown nodejs:nodejs /app/data/data.sqlite

   # Restart container
   docker restart <new-container-name>
   ```

6. **Verify migration:**
   - Login to admin panel
   - Check that all motions and council members exist
   - Generate a test token to verify database works

## 📖 Documentation

- **Quick Start:** See `COOLIFY.md` - Step 4
- **Detailed Guide:** See `PERSISTENT_STORAGE.md`
- **Docker Compose:** Example included in `PERSISTENT_STORAGE.md`

## 🔍 How to Verify Storage is Working

After deployment:

```bash
# 1. Create test data in UI
# (e.g., add a council member)

# 2. Restart container
docker restart <container-name>

# 3. Check if data persists
# Login and verify council member still exists

# 4. Check volume mounts
docker inspect <container-name> | grep -A 10 "Mounts"
# Should show mounts for /app/data, /app/logs, /app/backups
```

## 📂 Directory Structure

```
/app/
├── data/              ← Persistent volume (database)
│   ├── data.sqlite
│   ├── data.sqlite-shm
│   └── data.sqlite-wal
├── logs/              ← Persistent volume (logs)
│   ├── combined.log
│   └── error.log
├── backups/           ← Persistent volume (backups)
│   └── data_2026-02-16_123456.sqlite
├── server.js
├── db.js
└── ...
```

## ⚠️ Common Mistakes to Avoid

1. **❌ Deploying without configuring storage in Coolify**
   - Result: Data lost on restart
   - Fix: Configure storage BEFORE first deploy

2. **❌ Using wrong paths in Coolify**
   - Wrong: `/app` or `/app/database`
   - Correct: `/app/data`, `/app/logs`, `/app/backups`

3. **❌ Not migrating existing data**
   - Result: Fresh start with no existing data
   - Fix: Follow migration steps above

4. **❌ Forgetting to redeploy after adding storage**
   - Result: Storage not mounted
   - Fix: Click "Deploy" after adding storage

## 🆘 Troubleshooting

### Data disappeared after restart
- **Cause:** Volumes not configured in Coolify
- **Fix:** Add storage in Coolify UI and redeploy

### Can't write to database
- **Cause:** Permission issues
- **Fix:**
  ```bash
  docker exec <container-name> chown -R nodejs:nodejs /app/data
  ```

### Database file not found
- **Cause:** Old database still at `/app/data.sqlite`
- **Fix:** Migrate data to `/app/data/data.sqlite`

## 📞 Support

- **Coolify Issues:** https://coolify.io/docs
- **App Issues:** https://github.com/dcook604/stratavote/issues

## Summary

✅ **Dockerfile** declares volumes
❌ **Coolify** must mount actual storage (YOU DO THIS)
✅ **Database** moved to `/app/data/` directory
✅ **Documentation** complete

**Next Step:** Configure storage in Coolify UI!
