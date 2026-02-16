# Deployment Diagnostic - Voter Link Error

## Issue
Voter link returns "Internal Server Error":
https://vote.spectrum4.ca/vote/1?token=YNfXFIpy11uy-KYKogoytsJS2Jljjawk

## Status Check
- ✅ App is running (healthz returns 200)
- ✅ Admin login page loads
- ❌ Voter link returns 500 error

## Most Likely Causes

### 1. Motion 1 Doesn't Exist (Most Likely)
The database is empty or Motion ID 1 was never created.

**Why:** Fresh database from deployment issues.

**Fix:** Create Motion 1 in admin panel first.

### 2. Database Is Corrupted
Database file exists but is malformed.

### 3. Token Doesn't Exist
The token in the link was never created.

## How to Diagnose

### Step 1: Check if Database Has Data

SSH to Coolify server:
```bash
# Find container
docker ps | grep spectrum

# Check database file exists
docker exec <container-id> ls -la /app/data.sqlite

# Check database contents (if sqlite3 installed)
docker exec <container-id> sqlite3 /app/data.sqlite "SELECT COUNT(*) FROM motions;"
```

### Step 2: Check Application Logs

```bash
# View logs
docker logs <container-id> --tail 50

# Look for error when accessing voter link
docker logs <container-id> -f
# Then visit the voter link in browser
```

### Step 3: Access Admin Panel

1. Go to: https://vote.spectrum4.ca/admin/login
2. Login with ADMIN_PASSWORD
3. Check if any motions exist
4. Check dashboard - does it show Motion 1?

## Quick Fix - Test with Real Data

### Option 1: Create a Test Motion

1. Login to admin panel
2. Click "New Motion"
3. Create a test motion:
   - Title: "Test Motion"
   - Description: "Testing voter links"
   - Opens: Now
   - Closes: Tomorrow
   - Status: Draft

4. View motion details
5. Click "Manage Tokens"
6. Generate a test token:
   ```
   Test User,test@example.com,Unit 101
   ```

7. Copy the voting link
8. Change motion status to "Open"
9. Try the new voting link

### Option 2: Import Existing Data

If you have a backup from before:

```bash
# Copy backup to container
docker cp backup.sqlite <container-id>:/app/data.sqlite

# Fix permissions
docker exec <container-id> chown nodejs:nodejs /app/data.sqlite

# Restart
docker restart <container-id>
```

## Why This Happened

The deployment failures meant the database was never properly initialized with data. The schema (tables) exist, but no motions or tokens were ever created.

The token `YNfXFIpy11uy-KYKogoytsJS2Jljjawk` was probably created before the deployment issues, so it doesn't exist in the current database.

## Immediate Action

**Before creating new tokens:**

1. ✅ Make sure persistent storage is configured (see previous instructions)
2. ✅ Create at least one motion
3. ✅ Generate tokens for that motion
4. ✅ Set motion status to "Open"
5. ✅ THEN test voter links

## Expected Behavior

When everything is working:

1. **Motion exists** in database
2. **Token exists** and is linked to that motion
3. **Motion status** is "Open"
4. **Voter link** shows voting form
5. **After voting** shows success message

## Error vs. Working

**Error (current):**
```html
<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body><pre>Internal Server Error</pre></body>
</html>
```

**Working:**
```html
<!DOCTYPE html>
<html>
<head><title>Cast Your Vote - Spectrum 4</title></head>
<body>
  <h1>Spectrum 4 Council Vote</h1>
  <h2>Test Motion</h2>
  <form>...</form>
</body>
</html>
```

## Debug Code Addition (Optional)

To get better error messages, we could add error logging to the vote route:

```javascript
app.get('/vote/:motionId', (req, res) => {
  try {
    const { motionId } = req.params;
    const { token } = req.query;

    logger.info('Vote page accessed', { motionId, hasToken: !!token });

    // ... rest of code ...

  } catch (err) {
    logger.error('Vote page error:', err);
    res.status(500).render('vote', {
      error: 'An unexpected error occurred. Please contact support.',
      motion: null,
      token: null
    });
  }
});
```

But this requires a code change and redeploy.

## Next Steps

1. **Confirm app is deployed** with persistent storage
2. **Login to admin panel**
3. **Check if Motion 1 exists**
4. **If not, create new motion** and generate fresh tokens
5. **Test with new tokens**

The old token `YNfXFIpy11uy-KYKogoytsJS2Jljjawk` is probably invalid because it references a motion that doesn't exist in the current database.
