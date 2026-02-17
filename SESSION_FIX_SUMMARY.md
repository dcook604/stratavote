# Session Cookie Overwrite Fix

## Problem
GET `/admin/login` was overwriting the session cookie (`strata.sid`) even when a valid session already existed, causing logged-in users to be logged out when visiting the login page.

## Root Cause
The CSRF middleware (`csurf`) was configured to store CSRF tokens in the session (`csrf({ cookie: false })`). This meant that every request to GET `/admin/login` would modify the session to store a CSRF secret, triggering `express-session` to send a new `Set-Cookie` header that overwrote the existing session cookie in the browser.

## Solution Implemented

### 1. ✅ Express-session configuration (already correct)
- `saveUninitialized: false` - Don't save empty sessions (line 316)
- `resave: false` - Don't resave unmodified sessions (line 315)

### 2. ✅ GET /admin/login route (already correct)
- Does NOT call `req.session.regenerate()`
- Does NOT call `req.session.destroy()`
- Does NOT reassign `req.session`

### 3. ✅ **CSRF tokens now use cookies instead of sessions** (NEW FIX)
Changed from session-based CSRF to **cookie-based CSRF**:
- **Before**: `csrf({ cookie: false })` - stored CSRF tokens in session
- **After**: `csrf({ cookie: true })` - stores CSRF tokens in separate `_csrf` cookie
- Added `cookie-parser` middleware (required for cookie-based CSRF)

This prevents CSRF middleware from modifying the session, which eliminates the unwanted `Set-Cookie` header.

### 4. ✅ Enhanced logging (already present)
GET `/admin/login` logs whether `Set-Cookie` header was sent for `strata.sid` cookie (lines 691-708).

## Files Modified
- `server.js`:
  - Line 8: Added `const cookieParser = require('cookie-parser');`
  - Line 409: Added `app.use(cookieParser());`
  - Line 471: Changed `csrf({ cookie: false })` to `csrf({ cookie: true })`
  - Lines 691-708: Enhanced logging to detect session cookie overwrite

## Testing
1. Start the server
2. Log in as admin at `/admin/login`
3. Navigate away (e.g., to `/admin/dashboard`)
4. Visit `/admin/login` again
5. **Expected**: You should be redirected to dashboard (still logged in)
6. **Check logs**: Should see "✅ GET /admin/login did NOT send Set-Cookie for strata.sid"

## Verification Commands
```bash
# Test with curl (check Set-Cookie headers)
curl -v http://localhost:3300/admin/login

# After login, use the session cookie and verify it's not overwritten
curl -v -b "strata.sid=<your-cookie>" http://localhost:3300/admin/login
```

The second request should NOT include a new `Set-Cookie: strata.sid=...` header in the response.
