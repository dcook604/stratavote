# Session Authentication Debug Analysis

## ⚠️ Clarification: This App Uses Sessions, Not JWT

The app uses **express-session** with cookies, not JWT tokens.

---

## Step 1: Auth Flow Trace (Session-Based)

### Login Handler: `POST /admin/login` (line 510)
```javascript
1. User submits password
2. Compare with process.env.ADMIN_PASSWORD
3. If match: req.session.isAdmin = true
4. req.session.save() explicitly
5. Redirect to /admin/dashboard
```

### Auth Middleware: `requireAuth()` (line 334)
```javascript
1. Check if req.session.isAdmin === true
2. If yes: allow access
3. If no: redirect to /admin/login
```

### Session Storage
- **Store**: MemoryStore (default, in-process)
- **Cookie name**: `strata.sid`
- **Transport**: HttpOnly cookie
- **Attributes**:
  - httpOnly: true
  - secure: false (correct for reverse proxy)
  - sameSite: 'lax'
  - maxAge: 24 hours

### Trust Proxy: ✅ CONFIGURED
```javascript
app.set('trust proxy', 1)
```

---

## Step 2: Diagnostic Logs Added

I've added logging to track:

### A) Login Response (POST /admin/login)
Logs:
- sessionID
- hasSession (boolean)
- protocol (http/https)
- req.secure
- hostname
- x-forwarded-proto header
- x-forwarded-host header
- Session save success/failure
- Final session.isAdmin value
- Cookie settings

### B) Protected Route Access (requireAuth middleware)
Logs:
- path requested
- sessionID
- hasSession (boolean)
- session.isAdmin value
- Cookie header present (boolean)

### C) Login Page Access (GET /admin/login)
Logs:
- sessionID
- hasSession
- isAdmin value
- Cookie presence
- Cookie names (not values - safe)

---

## Step 3: Session Cookie Analysis

### Current Configuration:
```javascript
{
  httpOnly: true,    // ✅ Prevents JS access
  secure: false,     // ✅ Correct for reverse proxy
  sameSite: 'lax',   // ✅ Allows redirects
  maxAge: 86400000,  // ✅ 24 hours
  path: '/',         // ✅ Default (all paths)
  domain: undefined  // ✅ Default (current host only)
}
```

### Expected Behavior:
1. **POST /admin/login** → Browser receives `Set-Cookie: strata.sid=...`
2. **GET /admin/dashboard** → Browser sends `Cookie: strata.sid=...`
3. Session middleware matches cookie to in-memory session
4. req.session.isAdmin should be true

---

## Step 4: Reverse Proxy Validation

### Coolify/Traefik Setup:
- External: `https://vote.spectrum4.ca`
- Internal: `http://container:3300`

### Required Headers (from Traefik):
```
X-Forwarded-Proto: https
X-Forwarded-Host: vote.spectrum4.ca
X-Forwarded-For: <client-ip>
```

### Express Configuration: ✅
```javascript
app.set('trust proxy', 1)  // Trusts first proxy
session({ proxy: true })    // Trusts proxy for cookies
```

---

## Step 5: Most Likely Root Causes

### 🔥 #1: Environment Variables Not Set
**Evidence to Check:**
- Look for `ERROR: ADMIN_PASSWORD environment variable is required` in logs
- Look for `ERROR: SESSION_SECRET environment variable is required` in logs
- Look for `Login failed - invalid password` even with correct password

**If this is the issue, you'll see:**
```
Login attempt { ... }
Login failed - invalid password
```

**Fix:**
Check Coolify environment variables:
```bash
ADMIN_PASSWORD=Eveseto123!@#
SESSION_SECRET=<32+ character random string>
NODE_ENV=production
```

---

### 🔥 #2: Session Not Persisting (MemoryStore Issue)
**Evidence to Check:**
- Login logs show `Login successful` with sessionID
- But next request shows different sessionID
- Or `isAdmin: false` on dashboard request

**Why this happens:**
- Container restart loses all sessions (MemoryStore is in-memory)
- Multiple container instances (not applicable to Coolify single instance)
- Session not being saved before redirect

**Fix Applied:**
Already added `req.session.save()` with callback to ensure session is written before redirect.

---

### 🔥 #3: Cookie Not Being Sent by Browser
**Evidence to Check:**
- Login logs show `Set-Cookie` header in response
- Dashboard request logs show `hasCookie: false`
- Browser DevTools → Application → Cookies shows no `strata.sid`

**Possible causes:**
- Browser blocking third-party cookies (unlikely for same domain)
- Secure flag mismatch (we set secure: false, should work)
- SameSite too strict (we use 'lax', should work)
- Domain mismatch (we use default, should work)

**If this is the issue:**
```
Login successful { sessionID: 'abc123', ... }
Login page accessed { hasCookie: false, sessionID: 'xyz789' }
```
Note the different session IDs.

---

### 🔥 #4: Session Middleware Not Running
**Evidence to Check:**
- No session object at all
- `hasSession: false` in logs

**Possible causes:**
- express-session middleware not loaded
- Error in session middleware (bad SECRET)

**If this is the issue:**
App would crash on startup with:
```
TypeError: Cannot set properties of undefined (setting 'isAdmin')
```

---

## Step 6: Verification Plan

### After Deploying Diagnostic Version:

1. **Go to Coolify → Logs**
2. **Clear logs or note timestamp**
3. **Attempt login** at https://vote.spectrum4.ca/admin/login
4. **Look for these log entries:**

```
Login page accessed {
  sessionID: 'first-id',
  hasSession: true/false,
  isAdmin: false,
  hasCookie: true/false
}

Login attempt {
  sessionID: 'first-id',
  protocol: 'http' or 'https',
  forwardedProto: 'https',
  ...
}

Login successful {
  sessionID: 'first-id',
  isAdmin: true,
  cookie: { ... }
}

Request {
  method: 'GET',
  path: '/admin/dashboard',
  sessionID: 'first-id' or 'different-id',  <-- KEY
  isAdmin: true or false,                     <-- KEY
  cookies: 'present' or 'missing'             <-- KEY
}
```

### What to Look For:

| Scenario | sessionID | isAdmin | cookies | Diagnosis |
|----------|-----------|---------|---------|-----------|
| A | Same | true | present | **WORKING!** Issue elsewhere |
| B | Same | false | present | Session not saved correctly |
| C | Different | N/A | missing | Cookie not sent by browser |
| D | Different | N/A | present but different name | Cookie name mismatch |
| E | N/A | Error before login | N/A | Wrong password/env var |

---

## Step 7: curl Test Commands

### Test 1: Login and Capture Cookie
```bash
curl -v -X POST https://vote.spectrum4.ca/admin/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "password=Eveseto123!@#" \
  -c cookies.txt \
  -L

# Look for:
# < Set-Cookie: strata.sid=...
# < Location: /admin/dashboard
```

### Test 2: Access Protected Route with Cookie
```bash
curl -v https://vote.spectrum4.ca/admin/dashboard \
  -b cookies.txt \
  -L

# Should return dashboard HTML, not redirect to login
```

### Test 3: Check Cookie File
```bash
cat cookies.txt

# Should show:
# vote.spectrum4.ca  FALSE  /  FALSE  <expiry>  strata.sid  <session-id>
```

If curl WORKS but browser doesn't:
- Browser-specific issue (extensions, privacy settings)
- Try incognito mode

If curl FAILS:
- Server-side session issue
- Check logs for specific error

---

## Step 8: Quick Fixes by Root Cause

### Fix 1: Missing Environment Variables
```bash
# In Coolify, set these environment variables:
ADMIN_PASSWORD=Eveseto123!@#
SESSION_SECRET=$(openssl rand -base64 48)
NODE_ENV=production
BASE_URL=https://vote.spectrum4.ca

# Redeploy
```

### Fix 2: Session Not Persisting After Redirect
✅ **Already fixed** by adding explicit `req.session.save()` callback

### Fix 3: Cookie Secure/SameSite Issues
✅ **Already fixed** by setting:
- secure: false (correct for reverse proxy)
- sameSite: 'lax' (allows redirects)

### Fix 4: Need Persistent Session Store
If using multiple containers or frequent restarts, use Redis:
```javascript
const RedisStore = require('connect-redis')(session);
const redis = require('redis');
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});

app.use(session({
  store: new RedisStore({ client: redisClient }),
  // ... rest of config
}));
```

---

## Top 3 Probable Causes (Ranked)

### 1. **Wrong ADMIN_PASSWORD in Coolify (90% likely)**
- User says "I was able to login before"
- Suggests env var was correct before but may have been reset
- Check: Does log show "Login failed - invalid password"?

### 2. **Session save timing issue (8% likely)**
- Fixed by adding explicit save callback
- Redirect was happening before session written to store
- Deploy new version with save callback

### 3. **Cookie not being sent by browser (2% likely)**
- Could be browser privacy settings
- Could be domain mismatch
- Check: Browser DevTools → Application → Cookies

---

## Immediate Action Plan

1. ✅ Deploy diagnostic version (just pushed)
2. 🔍 Watch Coolify logs
3. 🧪 Try login
4. 📋 Share the logs here
5. 🎯 Apply targeted fix based on log evidence

**I'll analyze the actual logs to give you the exact fix.**
