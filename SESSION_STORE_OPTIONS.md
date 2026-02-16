# Persistent Session Store Options

## Problem
MemoryStore sessions are lost on every deployment/restart.

## Solutions

### Option 1: Redis (Recommended for Production)
Best for: Multiple instances, high traffic, frequent deployments

**Setup:**
```bash
# Add to package.json
npm install connect-redis redis
```

```javascript
// In server.js
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.connect().catch(console.error);

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'strata.sid',
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));
```

**In Coolify:**
- Add Redis service
- Set `REDIS_URL=redis://redis:6379`
- Link services

---

### Option 2: SQLite Session Store
Best for: Single instance, existing SQLite setup

**Setup:**
```bash
npm install connect-sqlite3
```

```javascript
const SQLiteStore = require('connect-sqlite3')(session);

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: './persistent'  // Use persistent volume
  }),
  // ... rest of config
}));
```

---

### Option 3: PostgreSQL/MySQL
Best for: Already have a database server

```bash
npm install connect-pg-simple
# or
npm install express-mysql-session
```

---

## Quick Decision Matrix

| Scenario | Use This |
|----------|----------|
| Single instance, low traffic | SQLite store |
| Production, scaling planned | Redis |
| Already have Postgres/MySQL | Database store |
| Testing/development | MemoryStore (current) |

## For Now

**MemoryStore is fine** if users:
- Clear cookies after deployments
- Login after each deployment
- Don't mind occasional session loss

**Upgrade to Redis** when:
- Multiple containers
- Can't ask users to re-login
- High availability required
