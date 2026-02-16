# Required Coolify Environment Variables

## CRITICAL: These MUST be set for login to work

### 1. NODE_ENV (REQUIRED)
```bash
NODE_ENV=production
```
**Why:** Enables secure cookies for HTTPS. Without this, `cookieSecure` will be `false` and browsers will reject cookies on HTTPS connections.

**Check:** After deployment, logs should show:
```
Environment configuration { isProduction: true }
Session middleware configured { cookieSecure: true }
```

---

### 2. SESSION_SECRET (REQUIRED)
```bash
SESSION_SECRET=<generate-random-32+-character-string>
```

**Generate with:**
```bash
openssl rand -base64 48
```

**Why:** Used to sign session cookies. Must be:
- At least 32 characters
- Random and secret
- Stable across deployments (don't regenerate)

**Example:**
```
SESSION_SECRET=kJ8fH3mN9pQ2rT5vW8xZ1aB4cD7eF0gH2iJ5kL8mN1oP4qR7sT0uV3wX6yZ9
```

---

### 3. ADMIN_PASSWORD (REQUIRED)
```bash
ADMIN_PASSWORD=your_secure_password_here
```

**Why:** Admin login password.

**Your current password:**
```
ADMIN_PASSWORD=Eveseto123!@#
```

---

### 4. BASE_URL (OPTIONAL but recommended)
```bash
BASE_URL=https://vote.spectrum4.ca
```

**Why:** Used for generating absolute URLs in emails and redirects.

---

## How to Set in Coolify

1. Go to your application in Coolify
2. Click **"Environment Variables"** tab
3. Add each variable:
   - Key: `NODE_ENV`
   - Value: `production`
   - Click "Add"
4. Repeat for `SESSION_SECRET` and others
5. **Redeploy** the application

---

## Verification Checklist

After deployment, check logs for:

```
✅ Environment configuration {
  nodeEnv: "production",
  isProduction: true,      ← MUST BE TRUE
  baseUrl: "https://vote.spectrum4.ca",
  trustProxy: true
}

✅ Session middleware configured {
  store: "SQLiteStore",
  cookieSecure: true,      ← MUST BE TRUE
  cookieSameSite: "lax",
  trustProxy: true
}
```

Then attempt login and look for:

```
✅ Login successful - session saved {
  sessionID: "ABC123",
  sessionKeys: ["cookie", "isAdmin"],  ← isAdmin MUST BE PRESENT
  isAdmin: true,
  cookieSecure: true,                  ← MUST BE TRUE
}

✅ Auth check {
  sessionID: "ABC123",                 ← MUST MATCH LOGIN SESSION
  sessionKeys: ["cookie", "isAdmin"],
  isAdmin: true,
  isAdminType: "boolean"
}

✅ Auth PASSED - allowing access
```

---

## Common Issues

### Issue: `isProduction: false` in logs
**Cause:** NODE_ENV not set or not set to "production"
**Fix:** Set `NODE_ENV=production` exactly (case-sensitive)

### Issue: `cookieSecure: false` in logs
**Cause:** Same as above
**Fix:** Set NODE_ENV=production

### Issue: sessionKeys doesn't include "isAdmin"
**Cause:** Session not being saved to SQLite store
**Fix:** Check logs for "Session save error" - may be permissions issue on /app/persistent

### Issue: sessionID changes after login
**Cause:** Browser rejecting cookie due to secure:false on HTTPS
**Fix:** Set NODE_ENV=production

---

## Complete Environment Variable List

```bash
# REQUIRED
NODE_ENV=production
SESSION_SECRET=<48-char-random-string>
ADMIN_PASSWORD=Eveseto123!@#

# OPTIONAL
BASE_URL=https://vote.spectrum4.ca
PORT=3300

# OPTIONAL - Email (if you want to send voter links via email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@email.com
SMTP_PASS=your_smtp_password
SMTP_FROM=noreply@yourdomain.com
```

---

## After Setting Variables

1. **Save** all environment variables in Coolify
2. **Redeploy** the application
3. **Clear browser cookies** for vote.spectrum4.ca
4. **Try logging in**
5. **Check logs** for the verification checklist above

**If cookieSecure is true and sessionKeys includes isAdmin, it WILL work!** 🎯
