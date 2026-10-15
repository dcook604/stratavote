require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const multer = require('multer');
const { parse: parseCSV } = require('csv-parse/sync');
const logger = require('./logger');
const {
  db,
  motionQueries,
  tokenQueries,
  ballotQueries,
  councilQueries,
  adminQueries,
  submitVote,
  getMotionStats,
  generateUUID,
  generateMotionRef,
  verifyAdminPassword,
  updateAdminPassword,
  getSetting,
  setSetting,
  ensureResultsEmailNotification,
  getPendingNotifications,
  markNotificationSent,
  markNotificationFailed,
  enqueueTokenEmail
} = require('./db');
const { isEmailConfigured, sendVotingLink, testEmailConfig, sendGenericEmail } = require('./email');
const { sendResultsEmailForMotion } = require('./services/resultsEmailService');
const { sweepAndEnqueueCompletedMotions, processPendingResultsEmails, processPendingTokenEmails } = require('./services/notificationWorker');
const { startEmailTriggerPoller, pollOnce: emailTriggerPollOnce } = require('./services/emailTriggerPoller');
const {
  parseMotionDateTime,
  toDatetimeLocalValue,
  getTimezone,
  isTimezoneValid,
  describeTimezone
} = require('./lib/datetime');

// Log unexpected errors instead of letting Node crash the process silently.
// Without these, a stray unhandled rejection or an EventEmitter 'error' with
// no listener (e.g. from a background IMAP/WhatsApp call) takes the whole
// server down with no trace of why, which shows up as unexplained restarts.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack
  });
});

// After an uncaught exception the process state is undefined: log, then exit
// so the container supervisor restarts it cleanly.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 500).unref();
});

// Validate required environment variables
if (!process.env.ADMIN_PASSWORD) {
  logger.error('ERROR: ADMIN_PASSWORD environment variable is required');
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  logger.error('ERROR: SESSION_SECRET environment variable is required');
  process.exit(1);
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  logger.error('ERROR: SESSION_SECRET must be at least 32 characters');
  logger.error('Generate one with: openssl rand -base64 32');
  process.exit(1);
}

if (process.env.SESSION_SECRET === 'super_secret_session_key_change_in_production') {
  logger.error('ERROR: You must change the default SESSION_SECRET');
  logger.error('Generate one with: openssl rand -base64 32');
  process.exit(1);
}

// ADMIN_PASSWORD is only used to seed the admin_settings row on first boot; after
// that the stored hash wins and changing this variable has no effect (change it
// from Admin Settings instead). Warn rather than exit, so an existing deployment
// with a short password keeps booting rather than locking the operator out.
const MIN_ADMIN_PASSWORD_LENGTH = 12;
if (process.env.ADMIN_PASSWORD.length < MIN_ADMIN_PASSWORD_LENGTH) {
  logger.warn('ADMIN_PASSWORD is shorter than the recommended minimum', {
    length: process.env.ADMIN_PASSWORD.length,
    recommendedMinimum: MIN_ADMIN_PASSWORD_LENGTH
  });
}

// Resolve and report the motion-time timezone once at boot. A typo here would
// otherwise silently fall back to the server's zone and shift every voting
// window, which is exactly the failure this configuration exists to prevent.
{
  const tz = describeTimezone();
  if (tz.mode === 'fixed-offset') {
    logger.warn('APP_TIMEZONE_OFFSET_MINUTES is set; using a fixed UTC offset', {
      offsetMinutes: tz.offsetMinutes,
      note: 'Fixed offsets drift by an hour across daylight saving. Prefer APP_TIMEZONE (IANA name).'
    });
  } else if (!isTimezoneValid(tz.timeZone)) {
    logger.error('APP_TIMEZONE is not a recognised IANA timezone; motion times will use the server zone', {
      appTimezone: tz.timeZone,
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  } else {
    logger.info('Motion times interpreted in timezone', { appTimezone: tz.timeZone });
  }
}

const app = express();
const PORT = process.env.PORT || 3300;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Helper to get the base URL from request (respects proxy)
// Always use the configured BASE_URL; never build links from request headers
// (X-Forwarded-Host / Host can be spoofed -> host-header poisoning in emails).
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
function getBaseUrl() {
  return BASE_URL;
}

// Trust proxy headers when behind a reverse proxy (Coolify/Traefik/nginx)
app.set('trust proxy', 1);

logger.info('Environment configuration', {
  nodeEnv: process.env.NODE_ENV,
  isProduction: IS_PRODUCTION,
  baseUrl: BASE_URL,
  trustProxy: true
});

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

const voteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: 'Too many vote attempts. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Input validation schemas
const schemas = {
  motion: Joi.object({
    title: Joi.string().min(5).max(200).required(),
    description: Joi.string().min(10).max(5000).required(),
    options: Joi.string().max(500).allow(''),
    open_at: Joi.string().isoDate().required(),
    close_at: Joi.string().isoDate().required(),
    required_majority: Joi.string().valid('Simple', 'TwoThirds').required()
  }),

  token: Joi.object({
    recipients: Joi.string().max(10000).allow('').optional(),
    selected_council_members: Joi.alternatives().try(
      Joi.string(),
      Joi.array().items(Joi.string())
    ).optional()
  }),

  vote: Joi.object({
    token: Joi.string().length(32).required(),
    choice: Joi.string().min(1).max(100).required()
  }),

  login: Joi.object({
    password: Joi.string().min(1).max(200).required()
  }),

  export: Joi.object({
    start_date: Joi.string().isoDate().required(),
    end_date: Joi.string().isoDate().required(),
    format: Joi.string().valid('csv', 'pdf').required()
  }),

  councilMember: Joi.object({
    name: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().max(200).required(),
    unit_number: Joi.string().max(50).allow('').optional(),
    whatsapp: Joi.string().max(30).allow('').optional()
  })
};

// Multer: memory storage for CSV uploads (500 KB max, CSV only)
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Validation middleware
function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { stripUnknown: true });
    if (error) {
      return res.status(400).send(`Validation error: ${error.details[0].message}`);
    }
    next();
  };
}

// Escape a value for a CSV text field and neutralise spreadsheet formula
// injection: Excel and Google Sheets execute a cell beginning with =, +, - or @,
// so a motion title or council member named "=cmd|'/c calc'!A0" becomes live
// code when the admin opens the export. Prefixing with an apostrophe forces the
// cell to be treated as text.
function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '';
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

// Export helper functions
function generateCSVExport(res, exportData, start_date, end_date) {
  const now = new Date().toISOString();
  const startFormatted = start_date.substring(0, 10);
  const endFormatted = end_date.substring(0, 10);

  let csv = 'VOTE RESULTS EXPORT\n';
  csv += `Generated: ${now}\n`;
  csv += `Date Range: ${start_date} to ${end_date}\n\n`;
  csv += 'Motion ID,Motion Ref,Motion Title,Status,Outcome,Opens At,Closes At,Required Majority,Eligible Voters,Votes Cast,Turnout %,Choice,Vote Count,Vote %\n';

  for (const { motion, stats, results } of exportData) {
    const turnout = stats.eligible > 0
      ? (stats.voted / stats.eligible * 100).toFixed(2)
      : '0.00';

    if (results.length === 0) {
      // Motion with no votes
      csv += [
        csvField(motion.id),
        csvField(motion.motion_ref),
        csvField(motion.title),
        csvField(motion.status),
        csvField(motion.outcome || ''),
        csvField(motion.open_at),
        csvField(motion.close_at),
        csvField(motion.required_majority),
        stats.eligible,
        stats.voted,
        turnout,
        '',
        '',
        ''
      ].join(',') + '\n';
    } else {
      // One row per vote choice
      results.forEach(result => {
        const percentage = stats.voted > 0
          ? (result.count / stats.voted * 100).toFixed(2)
          : '0.00';

        csv += [
          csvField(motion.id),
          csvField(motion.motion_ref),
          csvField(motion.title),
          csvField(motion.status),
          csvField(motion.outcome || ''),
          csvField(motion.open_at),
          csvField(motion.close_at),
          csvField(motion.required_majority),
          stats.eligible,
          stats.voted,
          turnout,
          csvField(result.choice),
          result.count,
          percentage
        ].join(',') + '\n';
      });
    }
  }

  const filename = `vote-results-${startFormatted}-to-${endFormatted}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

function generatePDFExport(res, exportData, start_date, end_date) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ margin: 50 });

  const startFormatted = start_date.substring(0, 10);
  const endFormatted = end_date.substring(0, 10);
  const filename = `vote-results-${startFormatted}-to-${endFormatted}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Pipe PDF to response
  doc.pipe(res);

  // Title
  doc.fontSize(20).text('Vote Results Export', { align: 'center' });
  doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
  doc.text(`Date Range: ${start_date} to ${end_date}`, { align: 'center' });
  doc.moveDown(2);

  // For each motion
  exportData.forEach((data, index) => {
    const { motion, stats, results } = data;

    // Motion header
    doc.fontSize(14).text(`Motion ${index + 1}: ${motion.title}`, { underline: true });
    doc.moveDown(0.5);

    // Motion details
    doc.fontSize(10);
    doc.text(`Status: ${motion.status}`, { continued: true });
    doc.text(`    Outcome: ${motion.outcome || 'Not set'}`);
    doc.text(`Opens: ${new Date(motion.open_at).toLocaleString()}`);
    doc.text(`Closes: ${new Date(motion.close_at).toLocaleString()}`);
    doc.text(`Required Majority: ${motion.required_majority === 'Simple' ? 'Simple (>50%)' : 'Two-Thirds (≥66.67%)'}`);
    doc.moveDown(0.5);

    // Statistics
    const turnout = stats.eligible > 0
      ? (stats.voted / stats.eligible * 100).toFixed(1)
      : '0';
    doc.text(`Eligible Voters: ${stats.eligible}    Votes Cast: ${stats.voted}    Turnout: ${turnout}%`);
    doc.moveDown(0.5);

    // Results table
    if (results.length > 0) {
      doc.text('Vote Breakdown:', { underline: true });
      doc.moveDown(0.3);

      results.forEach(result => {
        const percentage = stats.voted > 0
          ? (result.count / stats.voted * 100).toFixed(1)
          : '0';
        doc.text(`  ${result.choice}: ${result.count} votes (${percentage}%)`);
      });
    } else {
      doc.text('No votes cast');
    }

    doc.moveDown(2);

    // Page break if not last motion and near bottom of page
    if (index < exportData.length - 1 && doc.y > 650) {
      doc.addPage();
    }
  });

  // Finalize PDF
  doc.end();
}

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// NOTE: express.static is deliberately mounted *after* helmet() further down.
// Serving it here would mean /styles.css, /vote.js and friends go out without
// the security headers.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Cookie parser MUST come before session middleware
app.use(cookieParser());

// Determine session storage directory
const persistentDir = path.join(__dirname, 'persistent');
const sessionDir = fs.existsSync(persistentDir) ? persistentDir : __dirname;

// Ensure directory exists and is writable
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o755 });
  logger.info('Created session directory', { directory: sessionDir });
}

logger.info('Session store configuration', {
  directory: sessionDir,
  isPersistent: fs.existsSync(persistentDir),
  dbPath: path.join(sessionDir, 'sessions.db')
});

// Create a dedicated better-sqlite3 instance for the session store
const sessionsDbPath = path.join(sessionDir, 'sessions.db');
const sessionsDb = new Database(sessionsDbPath);
sessionsDb.pragma('journal_mode = WAL');

// Create sessions table with the schema expected by better-sqlite3-session-store
// First check if table exists and has the correct schema
let hasExpireColumn = false;
try {
  const tableInfo = sessionsDb.prepare("PRAGMA table_info(sessions)").all();
  hasExpireColumn = tableInfo.some(col => col.name === 'expire');
} catch (e) {
  // Table doesn't exist yet
}

if (!hasExpireColumn) {
  // Drop old table if it exists and create new one with correct schema
  sessionsDb.exec("DROP TABLE IF EXISTS sessions");
  sessionsDb.exec(`
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL
    )
  `);
  logger.info('Created new sessions table with correct schema');
} else {
  logger.info('Sessions table already has correct schema');
}

logger.info('Sessions DB opened and initialized', { path: sessionsDbPath });

const sqliteStore = new SqliteStore({
  client: sessionsDb,
  expired: {
    clear: true,
    intervalMs: 15 * 60 * 1000 // Clear expired sessions every 15 minutes
  }
});

// Background worker: close motions when time ends and send results/token emails via outbox
setInterval(async () => {
  try {
    sweepAndEnqueueCompletedMotions();
    await processPendingResultsEmails({ baseUrl: BASE_URL, limit: 25 });
    await processPendingTokenEmails({ baseUrl: BASE_URL, limit: 50 });
  } catch (err) {
    logger.error('notification worker tick failed', { error: err.message });
  }
}, 60 * 1000);

app.use(session({
  store: sqliteStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false, // FALSE = don't save empty sessions (prevents overwriting valid sessions!)
  rolling: true, // TRUE = reset cookie expiry on every request (extends session with activity)
  name: 'strata.sid',
  proxy: true, // Trust the reverse proxy for secure cookie handling
  cookie: {
    httpOnly: true,
    // CRITICAL: Set secure=true in production for HTTPS connections
    // With trust proxy enabled, Express will properly handle this behind Traefik
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 3 * 60 * 60 * 1000 // 3 hours timeout
  }
}));

logger.info('Session middleware configured', {
  store: 'SQLiteStore',
  cookieSecure: IS_PRODUCTION,
  cookieSameSite: 'lax',
  trustProxy: true,
  rolling: true,
  maxAge: '3 hours'
});

// Destroy every stored session apart from `keepSessionId`. Used after a password
// change so a cookie stolen beforehand stops working immediately instead of
// remaining valid for the rest of its 3-hour lifetime.
function invalidateOtherSessions(keepSessionId, callback) {
  sqliteStore.all((err, sessions) => {
    if (err) return callback(err);

    const others = (sessions || [])
      .map(s => (s && s.sid) || s)
      .filter(sid => typeof sid === 'string' && sid !== keepSessionId);

    if (others.length === 0) return callback(null, 0);

    let remaining = others.length;
    let destroyed = 0;
    let firstErr = null;

    others.forEach(sid => {
      sqliteStore.destroy(sid, (destroyErr) => {
        if (destroyErr) {
          if (!firstErr) firstErr = destroyErr;
        } else {
          destroyed++;
        }
        if (--remaining === 0) callback(firstErr, destroyed);
      });
    });
  });
}

// Note: No stale session recovery middleware needed.
// express-session handles stale cookies gracefully: if the store can't find
// the session, it creates a new empty one. On login, session.save() persists
// it and sends a fresh cookie to the browser.

// HTTP logger. Deliberately does NOT log session IDs, cookies, or query strings
// (vote tokens travel in ?token=...) so logs cannot be used to hijack anything.
app.use((req, res, next) => {
  const start = Date.now();
  const safePath = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    logger.info('HTTP', {
      method: req.method,
      path: safePath,
      status: res.statusCode,
      duration: `${Date.now() - start}ms`,
      isAdmin: isAdminAuthenticated(req.session)
    });
  });

  next();
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      formAction: ["'self'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' }
}));

// Static assets, now covered by the security headers above.
app.use(express.static(path.join(__dirname, 'public')));

// HTTPS enforcement in production.
//
// The redirect target is built from BASE_URL, never from Host/X-Forwarded-Host.
// Those headers are attacker-controlled, and because req.url carries the query
// string, a spoofed Host on a plaintext /vote/<id>?token=... request would have
// redirected the voter -- token included -- to an arbitrary domain.
if (process.env.NODE_ENV === 'production') {
  let configuredOrigin = null;
  try {
    const parsed = new URL(BASE_URL);
    if (parsed.protocol === 'https:') {
      configuredOrigin = parsed.origin;
    } else {
      logger.warn('HTTPS redirect disabled: BASE_URL is not an https URL', { baseUrl: BASE_URL });
    }
  } catch (e) {
    logger.error('HTTPS redirect disabled: BASE_URL could not be parsed', { baseUrl: BASE_URL });
  }

  app.use((req, res, next) => {
    // Skip HTTPS redirect for health check endpoints
    if (req.path === '/healthz' || req.path === '/health') {
      return next();
    }

    const isHttps = req.secure || req.get('x-forwarded-proto') === 'https';
    if (isHttps) return next();

    if (!configuredOrigin) return next();

    // 308 (not 301) so a redirected POST is not downgraded to GET.
    const redirectUrl = `${configuredOrigin}${req.originalUrl}`;
    logger.info('HTTPS REDIRECT', { path: req.path, to: redirectUrl });
    return res.redirect(308, redirectUrl);
  });
}

// CSRF protection (double-submit cookie, HMAC-bound to the session ID).
// csurf is deprecated/unmaintained; csrf-csrf replaces it.
const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.SESSION_SECRET,
  getSessionIdentifier: (req) => req.sessionID || '',
  cookieName: IS_PRODUCTION ? '__Host-strata.csrf' : 'strata.csrf',
  cookieOptions: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/'
  },
  // Body/header only -- no query-string fallback. A token in the URL ends up in
  // browser history, Referer headers and intermediary logs for no benefit.
  getCsrfTokenFromRequest: (req) =>
    (req.body && req.body._csrf) || req.headers['x-csrf-token']
});

app.use((req, res, next) => {
  // Skip CSRF for voting endpoints (they use one-time tokens for auth)
  if (req.path.startsWith('/vote/') && req.method === 'POST') {
    return next();
  }
  // Skip CSRF for login POST (no session to attack; rate limited)
  if (req.path === '/admin/login' && req.method === 'POST') {
    return next();
  }
  // Skip the CSV import POST: its multipart body is not parsed until multer
  // runs inside the route, so req.body._csrf is empty here. The route applies
  // doubleCsrfProtection itself once the upload has been parsed.
  if (req.path === '/admin/motions/import' && req.method === 'POST') {
    return next();
  }
  doubleCsrfProtection(req, res, next);
});

app.use((req, res, next) => {
  // Memoize: every call sets the CSRF cookie, so all forms on a page must share one token
  let cached;
  res.locals.csrfToken = () => (cached = cached || generateCsrfToken(req, res));
  next();
});

// CSRF error handler - show friendly message instead of raw 403
app.use((err, req, res, next) => {
  if (err.code !== 'EBADCSRFTOKEN') return next(err);

  logger.warn('CSRF token validation failed', {
    path: req.path,
    method: req.method,
  });

  // For admin routes, redirect to login (session/CSRF likely stale after redeploy)
  if (req.path.startsWith('/admin/')) {
    return res.redirect('/admin/login');
  }

  res.status(403).send('Form expired. Please go back and try again.');
});

// Helper: check isAdmin robustly (SQLite may deserialize true as 1 or "true")
function isAdminAuthenticated(session) {
  if (!session) return false;
  const val = session.isAdmin;
  return val === true || val === 1 || val === 'true';
}

// Auth middleware
function requireAuth(req, res, next) {
  if (isAdminAuthenticated(req.session)) {
    return next();
  }

  logger.warn('Auth failed - redirecting to login', {
    path: req.path,
  });

  res.redirect('/admin/login');
}

// Helper: hash IP address
function hashIP(ip) {
  if (!process.env.IP_HASH_SALT) return null;
  return crypto.createHash('sha256')
    .update(process.env.IP_HASH_SALT + ip)
    .digest('hex');
}

// Convert a date-range bound from a form input into a UTC ISO string comparable
// against the stored close_at column. Returns null when absent or unparseable.
function normalizeDateBound(value) {
  if (!value) return null;
  const parsed = parseMotionDateTime(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Helper: validate vote eligibility
function validateVoteEligibility(motion, token) {
  const now = new Date();
  const openAt = parseMotionDateTime(motion.open_at);
  const closeAt = parseMotionDateTime(motion.close_at);

  if (!token) {
    return { valid: false, message: 'Invalid voting link.' };
  }

  if (token.status === 'Used') {
    return { valid: false, message: 'This voting link has already been used.' };
  }

  if (token.status === 'Revoked') {
    return { valid: false, message: 'This voting link has been revoked.' };
  }

  if (token.status !== 'Active') {
    return { valid: false, message: 'This voting link is not active.' };
  }

  if (token.motion_id !== motion.id) {
    return { valid: false, message: 'Invalid voting link for this motion.' };
  }

  if (motion.status !== 'Open') {
    return { valid: false, message: 'Voting is not currently open for this motion.' };
  }

  if (now < openAt) {
    return {
      valid: false,
      message: `Voting has not yet opened. (Opens at: ${openAt.toISOString()}, server time: ${now.toISOString()})`
    };
  }

  if (now > closeAt) {
    return {
      valid: false,
      message: `Voting has closed. (Closed at: ${closeAt.toISOString()}, server time: ${now.toISOString()})`
    };
  }

  return { valid: true };
}

// PUBLIC ROUTES

// Home redirect
app.get('/', (req, res) => {
  res.redirect('/admin/login');
});

// Vote page
app.get('/vote/:motionId', (req, res) => {
  const { motionId } = req.params;
  const { token } = req.query;

  if (!token) {
    return res.render('vote', {
      error: 'No voting token provided.',
      motion: null,
      token: null
    });
  }

  const motion = motionQueries.getById.get(motionId);
  if (!motion) {
    return res.render('vote', {
      error: 'Motion not found.',
      motion: null,
      token: null
    });
  }

  const tokenRecord = tokenQueries.getByToken.get(token);
  const validation = validateVoteEligibility(motion, tokenRecord);

  if (!validation.valid) {
    return res.render('vote', {
      error: validation.message,
      motion,
      token: null
    });
  }

  // Parse options
  motion.options = JSON.parse(motion.options_json);

  res.render('vote', {
    error: null,
    motion,
    token: tokenRecord
  });
});

// Submit vote
app.post('/vote/:motionId', voteLimiter, validate(schemas.vote), (req, res) => {
  const { motionId } = req.params;
  const { token, choice } = req.body;

  if (!token || !choice) {
    return res.render('vote_result', {
      success: false,
      message: 'Missing required fields.'
    });
  }

  const motion = motionQueries.getById.get(motionId);
  if (!motion) {
    return res.render('vote_result', {
      success: false,
      message: 'Motion not found.'
    });
  }

  const tokenRecord = tokenQueries.getByToken.get(token);
  const validation = validateVoteEligibility(motion, tokenRecord);

  if (!validation.valid) {
    return res.render('vote_result', {
      success: false,
      message: validation.message
    });
  }

  // Validate choice is in options
  const options = JSON.parse(motion.options_json);
  if (!options.includes(choice)) {
    return res.render('vote_result', {
      success: false,
      message: 'Invalid choice.'
    });
  }

  try {
    const userAgent = req.get('user-agent') || null;
    const ipHash = hashIP(req.ip);

    submitVote(motion.id, tokenRecord.id, choice, userAgent, ipHash);

    // Opportunistic completion check: the worker will apply end-time/all-voted/early-threshold rules.
    try {
      sweepAndEnqueueCompletedMotions();
    } catch (e) {
      logger.error('post-vote completion check failed', { motionId: motion.id, error: e.message });
    }

    res.render('vote_result', {
      success: true,
      message: 'Your vote has been recorded successfully. Thank you for participating.'
    });
  } catch (err) {
    logger.error('Vote submission error:', err);
    res.render('vote_result', {
      success: false,
      message: 'An error occurred while recording your vote. Please contact support.'
    });
  }
});

// ADMIN ROUTES

// Login page
app.get('/admin/login', (req, res) => {
  // If already authenticated, redirect to dashboard
  if (isAdminAuthenticated(req.session)) {
    logger.info('Already logged in - redirecting to dashboard', { sessionID: req.sessionID });
    return res.redirect('/admin/dashboard');
  }

  res.render('admin_login', { error: null });
});

// Login handler
app.post('/admin/login', loginLimiter, validate(schemas.login), (req, res, next) => {
  const { password } = req.body;
  const passwordValid = verifyAdminPassword(password);

  if (!passwordValid) {
    logger.warn('Login failed - invalid password', { ip: req.ip });
    return res.render('admin_login', { error: 'Invalid password.' });
  }

  // Regenerate the session on login to prevent session fixation
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      logger.error('Session regenerate error on login', { error: regenErr.message });
      return next(regenErr);
    }
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) {
        logger.error('Session save error on login', { error: err.message });
        return next(err);
      }

      logger.info('Login success', { ip: req.ip });
      return res.redirect('/admin/dashboard');
    });
  });
});

// Logout
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('strata.sid');
    res.redirect('/admin/login');
  });
});

// Dashboard
app.get('/admin/dashboard', requireAuth, (req, res) => {
  const rawStart = req.query.start_date || '';
  const rawEnd = req.query.end_date || '';

  // The filter inputs are local wall-clock values while close_at is stored as a
  // UTC ISO string, so both bounds have to be converted before comparing --
  // otherwise "2026-03-01T09:00" is compared lexically against
  // "2026-03-01T17:00:00.000Z" and matches the wrong day either side of the zone.
  const startIso = normalizeDateBound(rawStart);
  const endIso = normalizeDateBound(rawEnd);

  const conditions = [];
  const params = [];
  if (startIso) { conditions.push('close_at >= ?'); params.push(startIso); }
  if (endIso) { conditions.push('close_at <= ?'); params.push(endIso); }

  const isFiltered = conditions.length > 0;
  const motions = isFiltered
    ? db.prepare(`SELECT * FROM motions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`).all(...params)
    : db.prepare('SELECT * FROM motions ORDER BY created_at DESC LIMIT 10').all();

  const motionsWithStats = motions.map(motion => {
    const stats = getMotionStats(motion.id);
    return { ...motion, stats };
  });

  res.render('admin_dashboard', {
    motions: motionsWithStats,
    isFiltered,
    startDate: rawStart,
    endDate: rawEnd,
    isPartialFilter: isFiltered && !(startIso && endIso),
    isInvertedRange: !!(startIso && endIso && endIso < startIso),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// New motion form
// CSV template download
app.get('/admin/motions/import/template.csv', requireAuth, (req, res) => {
  const csv = [
    'title,description,open_at,close_at,required_majority,options',
    '"Approve 2024 Budget","Vote to approve the annual operating budget of $250,000","2026-03-01T09:00","2026-03-08T17:00","Simple","Yes,No,Abstain"',
    '"Amend Bylaws Section 4","Proposal to amend noise restriction rules in section 4.2","2026-03-01T09:00","2026-03-08T17:00","TwoThirds",""'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="motions-import-template.csv"');
  res.send(csv);
});

// Import motions via CSV — form
app.get('/admin/motions/import', requireAuth, (req, res) => {
  res.render('motion_import', { results: null, error: null });
});

// Import motions via CSV — process upload
//
// A multipart/form-data body is not parsed until multer runs, and multer runs
// here -- after the global CSRF middleware. That middleware therefore cannot
// see the _csrf field, so it skips this path (see the exclusion in the CSRF
// setup) and the token is validated explicitly below, once req.body is
// populated. The token used to be passed in the query string to work around
// this, which leaked it into browser history, Referer headers and access logs.
app.post('/admin/motions/import', requireAuth, (req, res, next) => {
  csvUpload.single('csv_file')(req, res, (uploadErr) => {
    if (uploadErr) {
      return res.render('motion_import', { results: null, error: uploadErr.message });
    }

    if (!req.file) {
      return res.render('motion_import', { results: null, error: 'No file uploaded.' });
    }

    doubleCsrfProtection(req, res, (csrfErr) => {
      if (csrfErr) return next(csrfErr);
      processUploadedMotions(req, res);
    });
  });
});

function processUploadedMotions(req, res) {
    let rows;
    try {
      rows = parseCSV(req.file.buffer.toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true
      });
    } catch (parseErr) {
      return res.render('motion_import', { results: null, error: `CSV parse error: ${parseErr.message}` });
    }

    if (rows.length === 0) {
      return res.render('motion_import', { results: null, error: 'The CSV file contains no data rows.' });
    }

    if (rows.length > 100) {
      return res.render('motion_import', { results: null, error: 'Maximum 100 motions per import. Please split into smaller files.' });
    }

    const rowSchema = Joi.object({
      title: Joi.string().min(5).max(200).required(),
      description: Joi.string().min(10).max(5000).required(),
      open_at: Joi.string().required(),
      close_at: Joi.string().required(),
      required_majority: Joi.string().valid('Simple', 'TwoThirds').required(),
      options: Joi.string().max(500).allow('').optional()
    });

    const created = [];
    const failed = [];

    const importTx = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2; // +2: 1-based + header row
        const row = rows[i];

        const { error: valErr } = rowSchema.validate(row, { allowUnknown: true, stripUnknown: true });
        if (valErr) {
          failed.push({ row: rowNum, title: row.title || '(blank)', reason: valErr.details[0].message });
          continue;
        }

        const openAt = parseMotionDateTime(row.open_at);
        const closeAt = parseMotionDateTime(row.close_at);

        if (isNaN(openAt.getTime())) {
          failed.push({ row: rowNum, title: row.title, reason: 'Invalid open_at date/time' });
          continue;
        }
        if (isNaN(closeAt.getTime())) {
          failed.push({ row: rowNum, title: row.title, reason: 'Invalid close_at date/time' });
          continue;
        }
        if (closeAt <= openAt) {
          failed.push({ row: rowNum, title: row.title, reason: 'close_at must be after open_at' });
          continue;
        }

        let optionsArray = ['Yes', 'No', 'Abstain'];
        if (row.options && row.options.trim()) {
          optionsArray = row.options.split(',').map(o => o.trim()).filter(o => o);
          if (optionsArray.length < 2) {
            failed.push({ row: rowNum, title: row.title, reason: 'options must contain at least 2 choices' });
            continue;
          }
        }

        try {
          const motionId = generateUUID();
          const motionRef = generateMotionRef();
          motionQueries.create.run(
            motionId,
            motionRef,
            row.title.trim(),
            row.description.trim(),
            JSON.stringify(optionsArray),
            openAt.toISOString(),
            closeAt.toISOString(),
            'Draft',
            row.required_majority,
            new Date().toISOString()
          );
          created.push({ row: rowNum, title: row.title, motionId, motionRef });
        } catch (dbErr) {
          failed.push({ row: rowNum, title: row.title, reason: dbErr.message });
        }
      }
    });

    try {
      importTx();
    } catch (txErr) {
      logger.error('CSV import transaction error:', txErr);
      return res.render('motion_import', { results: null, error: `Import failed: ${txErr.message}` });
    }

    logger.info('CSV motion import complete', { created: created.length, failed: failed.length });
    res.render('motion_import', { results: { created, failed }, error: null });
}

app.get('/admin/motions/new', requireAuth, (req, res) => {
  res.render('motion_new', { error: null });
});

// Create motion
app.post('/admin/motions', requireAuth, validate(schemas.motion), (req, res) => {
  const { title, description, options, open_at, close_at, required_majority } = req.body;

  if (!title || !description || !open_at || !close_at) {
    return res.render('motion_new', {
      error: 'All required fields must be filled.'
    });
  }

  // Parse options
  let optionsArray = ['Yes', 'No', 'Abstain'];
  if (options && options.trim()) {
    optionsArray = options.split(',').map(opt => opt.trim()).filter(opt => opt);
  }

  const optionsJson = JSON.stringify(optionsArray);
  const majority = required_majority || 'Simple';
  const created_at = new Date().toISOString();

  // Normalize motion times to ISO (UTC) so comparisons are consistent across server restarts.
  const normalizedOpenAt = parseMotionDateTime(open_at).toISOString();
  const normalizedCloseAt = parseMotionDateTime(close_at).toISOString();

  try {
    const motionId = generateUUID();
    const motionRef = generateMotionRef();
    
    motionQueries.create.run(
      motionId,
      motionRef,
      title,
      description,
      optionsJson,
      normalizedOpenAt,
      normalizedCloseAt,
      'Draft',
      majority,
      created_at
    );

    res.redirect(`/admin/motions/${motionId}`);
  } catch (err) {
    logger.error('Motion creation error:', err);
    res.render('motion_new', {
      error: 'Failed to create motion.'
    });
  }
});

// Helper: can the motion still be edited (before voting opens)
function canEditMotion(motion) {
  return motion.status === 'Draft' || new Date() < parseMotionDateTime(motion.open_at);
}

// Edit motion form
app.get('/admin/motions/:id/edit', requireAuth, (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);
  if (!motion) return res.status(404).send('Motion not found');
  if (!canEditMotion(motion)) {
    return res.redirect(`/admin/motions/${id}?error=Motion+cannot+be+edited+after+voting+opens`);
  }
  motion.options = JSON.parse(motion.options_json);
  res.render('motion_edit', {
    motion,
    openAtValue: toDatetimeLocalValue(motion.open_at),
    closeAtValue: toDatetimeLocalValue(motion.close_at),
    error: null
  });
});

// Edit motion submit
app.post('/admin/motions/:id/edit', requireAuth, validate(schemas.motion), (req, res) => {
  const { id } = req.params;
  const { title, description, options, open_at, close_at, required_majority } = req.body;

  const motion = motionQueries.getById.get(id);
  if (!motion) return res.status(404).send('Motion not found');
  if (!canEditMotion(motion)) {
    return res.redirect(`/admin/motions/${id}?error=Motion+cannot+be+edited+after+voting+opens`);
  }

  let optionsArray = ['Yes', 'No', 'Abstain'];
  if (options && options.trim()) {
    optionsArray = options.split(',').map(opt => opt.trim()).filter(opt => opt);
  }

  const normalizedOpenAt = parseMotionDateTime(open_at).toISOString();
  const normalizedCloseAt = parseMotionDateTime(close_at).toISOString();

  try {
    motionQueries.update.run(
      title,
      description,
      JSON.stringify(optionsArray),
      normalizedOpenAt,
      normalizedCloseAt,
      required_majority || 'Simple',
      id
    );
    res.redirect(`/admin/motions/${id}?success=Motion+updated+successfully`);
  } catch (err) {
    logger.error('Motion update error:', err);
    motion.options = JSON.parse(motion.options_json);
    res.render('motion_edit', {
      motion,
      openAtValue: toDatetimeLocalValue(motion.open_at),
      closeAtValue: toDatetimeLocalValue(motion.close_at),
      error: 'Failed to update motion.'
    });
  }
});

// Motion detail
app.get('/admin/motions/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);

  if (!motion) {
    return res.status(404).send('Motion not found');
  }

  motion.options = JSON.parse(motion.options_json);
  const stats = getMotionStats(id);
  const voterStatus = ballotQueries.getVoterStatusByMotion.all(id);

  res.render('motion_detail', {
    motion,
    stats,
    voterStatus,
    canEdit: canEditMotion(motion),
    showVoterBreakdown: !!motion.show_voter_breakdown,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Update motion status
app.post('/admin/motions/:id/status', requireAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['Draft', 'Open', 'Closed', 'Published'];
  if (!validStatuses.includes(status)) {
    return res.redirect(`/admin/motions/${id}?error=Invalid+status`);
  }

  try {
    motionQueries.updateStatus.run(status, id);

    if (status === 'Closed' || status === 'Published') {
      const motion = motionQueries.getById.get(id);
      const queuedChanges = ensureResultsEmailNotification(id);
      logger.info('notification queued', {
        motionId: id,
        motionRef: motion ? motion.motion_ref : null,
        inserted: queuedChanges > 0,
        trigger: 'manual_status_change',
        status
      });

      // Best-effort: process immediately so admins see it happen without waiting for the 1-min tick
      processPendingResultsEmails({ baseUrl: BASE_URL, limit: 25 }).catch(err => {
        logger.error('immediate results email processing failed', { motionId: id, error: err.message });
      });
    }

    res.redirect(`/admin/motions/${id}?success=Status+updated`);
  } catch (err) {
    logger.error('Status update error:', err);
    res.redirect(`/admin/motions/${id}?error=Failed+to+update+status`);
  }
});

// Update motion outcome
app.post('/admin/motions/:id/outcome', requireAuth, (req, res) => {
  const { id } = req.params;
  const { outcome, outcome_notes } = req.body;

  const validOutcomes = ['Passed', 'Failed', 'Tie', 'Cancelled', null];
  if (outcome && !validOutcomes.includes(outcome)) {
    return res.redirect(`/admin/motions/${id}?error=Invalid+outcome`);
  }

  try {
    motionQueries.updateOutcome.run(outcome || null, outcome_notes || null, id);
    res.redirect(`/admin/motions/${id}?success=Outcome+updated`);
  } catch (err) {
    logger.error('Outcome update error:', err);
    res.redirect(`/admin/motions/${id}?error=Failed+to+update+outcome`);
  }
});

// Toggle whether the unauthenticated public results page lists individual votes.
app.post('/admin/motions/:id/voter-breakdown', requireAuth, (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);
  if (!motion) return res.status(404).send('Motion not found');

  const raw = req.body.show_voter_breakdown;
  const enabled = raw === 'on' || raw === 'true' || raw === '1';

  try {
    motionQueries.updateShowVoterBreakdown.run(enabled ? 1 : 0, id);

    logger.info('Public voter breakdown visibility updated', {
      motionId: id,
      motionRef: motion.motion_ref,
      enabled,
      ip: req.ip
    });

    const message = enabled
      ? 'Public results will now list each voter and their choice.'
      : 'Public results will now show aggregate totals only.';
    res.redirect(`/admin/motions/${id}?success=${encodeURIComponent(message)}`);
  } catch (err) {
    logger.error('Failed to update voter breakdown visibility', { motionId: id, error: err.message });
    res.redirect(`/admin/motions/${id}?error=${encodeURIComponent('Failed to update public results setting')}`);
  }
});

// Manually send the results email to everyone who voted plus the property manager
app.post('/admin/motions/:id/send-results-email', requireAuth, async (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);

  if (!motion) {
    return res.status(404).send('Motion not found');
  }

  if (!['Closed', 'Published'].includes(motion.status)) {
    return res.redirect(`/admin/motions/${id}?error=Motion+must+be+Closed+or+Published+before+sending+results`);
  }

  try {
    const result = await sendResultsEmailForMotion({
      motionId: id,
      baseUrl: BASE_URL,
      sendMailFn: sendGenericEmail,
      force: true
    });

    if (result.sent) {
      res.redirect(`/admin/motions/${id}?success=Results+email+sent+to+${result.recipientCount}+recipient(s)`);
    } else {
      logger.warn('manual results email not sent', { motionId: id, reason: result.reason });
      res.redirect(`/admin/motions/${id}?error=Results+email+not+sent:+${encodeURIComponent(result.reason || 'unknown error')}`);
    }
  } catch (err) {
    logger.error('Manual results email send failed', { motionId: id, error: err.message });
    res.redirect(`/admin/motions/${id}?error=Failed+to+send+results+email`);
  }
});

// Delete motion (Draft or Open)
app.post('/admin/motions/:id/delete', requireAuth, (req, res) => {
  const { id } = req.params;
  
  const motion = motionQueries.getById.get(id);
  if (!motion) {
    return res.status(404).send('Motion not found');
  }
  
  // Check if motion can be deleted
  if (motion.status !== 'Draft' && motion.status !== 'Open') {
    return res.redirect(`/admin/motions/${id}?error=Only+draft+or+open+motions+can+be+deleted`);
  }
  
  // Delete children before the parent so foreign keys can stay enabled. This
  // previously ran with `PRAGMA foreign_keys = OFF` outside a transaction, which
  // turned off referential integrity for the whole connection (every concurrent
  // request) and could leave orphaned rows if the process died mid-delete.
  const purgeMotion = db.transaction((motionId) => {
    const ballots = db.prepare('DELETE FROM ballots WHERE motion_id = ?').run(motionId).changes;
    const outbox = db.prepare(`
      DELETE FROM token_email_outbox
      WHERE token_id IN (SELECT id FROM voter_tokens WHERE motion_id = ?)
    `).run(motionId).changes;
    const tokens = db.prepare('DELETE FROM voter_tokens WHERE motion_id = ?').run(motionId).changes;
    const notifications = db.prepare('DELETE FROM motion_notifications WHERE motion_id = ?').run(motionId).changes;
    const motions = db.prepare('DELETE FROM motions WHERE id = ?').run(motionId).changes;
    return { ballots, outbox, tokens, notifications, motions };
  });

  try {
    const deleted = purgeMotion(id);
    logger.info('Motion deletion completed successfully', {
      motionId: id,
      title: motion.title,
      ...deleted
    });
    res.redirect('/admin/dashboard?success=' + encodeURIComponent('Motion deleted successfully'));
  } catch (err) {
    logger.error('Motion deletion error:', {
      motionId: id,
      title: motion.title,
      error: err.message,
      stack: err.stack,
      code: err.code
    });
    res.redirect(`/admin/motions/${id}?error=Failed+to+delete+motion`);
  }
});

// Token management page
app.get('/admin/motions/:id/tokens', requireAuth, (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);

  if (!motion) {
    return res.status(404).send('Motion not found');
  }

  const tokens = tokenQueries.getByMotion.all(id);
  const councilMembers = councilQueries.getAll.all();

  motion.options = JSON.parse(motion.options_json);

  res.render('tokens', {
    motion,
    tokens,
    councilMembers,
    baseUrl: BASE_URL,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Generate tokens
app.post('/admin/motions/:id/tokens', requireAuth, validate(schemas.token), (req, res) => {
  const { id } = req.params;
  const { recipients, selected_council_members } = req.body;

  const motion = motionQueries.getById.get(id);
  if (!motion) {
    return res.redirect(`/admin/motions/${id}/tokens?error=Motion+not+found`);
  }

  // Collect recipients from both sources
  const recipientList = [];
  const emailSet = new Set();

  // Parse textarea recipients (existing logic)
  if (recipients && recipients.trim()) {
    const lines = recipients.split('\n').map(line => line.trim()).filter(line => line);
    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim());
      const name = parts[0] || null;
      const email = parts[1] || null;
      const unit = parts[2] || null;

      if (email && !emailSet.has(email.toLowerCase())) {
        recipientList.push({ name, email, unit });
        emailSet.add(email.toLowerCase());
      }
    }
  }

  // Add selected council members
  if (selected_council_members) {
    const memberIds = Array.isArray(selected_council_members)
      ? selected_council_members
      : [selected_council_members];

    for (const memberId of memberIds) {
      const member = councilQueries.getById.get(memberId);
      if (member && !emailSet.has(member.email.toLowerCase())) {
        recipientList.push({
          name: member.name,
          email: member.email,
          unit: member.unit_number
        });
        emailSet.add(member.email.toLowerCase());
      }
    }
  }

  if (recipientList.length === 0) {
    return res.redirect(`/admin/motions/${id}/tokens?error=No+recipients+provided`);
  }

  let created = 0;
  let skippedDuplicates = 0;
  let emailsSent = 0;

  const emailConfigured = isEmailConfigured();

  try {
    for (const recipient of recipientList) {
      const { name, email, unit } = recipient;

      // Prevent duplicate tokens for the same motion + email (case-insensitive)
      if (email) {
        const existing = tokenQueries.getActiveByMotionEmail.get(id, email);
        if (existing) {
          skippedDuplicates++;
          continue;
        }
      }

      const token = crypto.randomBytes(24).toString('base64url');
      const created_at = new Date().toISOString();

      // Create token with email status fields
      let result;
      try {
        result = tokenQueries.create.run(
          id,
          token,
          name,
          email,
          unit,
          'Active',
          created_at,
          0, // email_sent
          null, // email_sent_at
          null // email_error
        );
      } catch (e) {
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          skippedDuplicates++;
          continue;
        }
        throw e;
      }
      created++;

      // Queue email for background delivery if configured and email address is provided
      if (emailConfigured && email) {
        enqueueTokenEmail(result.lastInsertRowid);
        emailsSent++;
      }
    }

    // Build success message
    let message = `Created ${created} token(s)`;
    if (skippedDuplicates > 0) {
      message += `. Skipped ${skippedDuplicates} duplicate(s)`;
    }
    if (emailConfigured) {
      message += `. ${emailsSent} email(s) queued for delivery`;
    } else {
      message += `. Email not configured - please copy links manually`;
    }

    res.redirect(`/admin/motions/${id}/tokens?success=${encodeURIComponent(message)}`);

    // Best-effort: kick off email processing immediately so messages go out without waiting for the next tick
    if (emailsSent > 0) {
      processPendingTokenEmails({ baseUrl: BASE_URL, limit: 50 }).catch(err => {
        logger.error('immediate token email processing failed', { motionId: id, error: err.message });
      });
    }
  } catch (err) {
    logger.error('Token creation error:', err);
    res.redirect(`/admin/motions/${id}/tokens?error=Failed+to+create+tokens`);
  }
});

// Revoke token
app.post('/admin/tokens/:tokenId/revoke', requireAuth, (req, res) => {
  const { tokenId } = req.params;

  try {
    const token = tokenQueries.getById.get(tokenId);
    if (!token) {
      return res.status(404).send('Token not found');
    }

    tokenQueries.revoke.run('Revoked', tokenId);
    res.redirect(`/admin/motions/${token.motion_id}/tokens?success=Token+revoked`);
  } catch (err) {
    logger.error('Token revoke error:', err);
    res.status(500).send('Failed to revoke token');
  }
});

// Resend email for a token
app.post('/admin/tokens/:tokenId/resend-email', requireAuth, (req, res) => {
  const { tokenId } = req.params;

  try {
    const token = tokenQueries.getById.get(tokenId);
    if (!token) {
      return res.status(404).send('Token not found');
    }

    if (token.status !== 'Active') {
      return res.redirect(`/admin/motions/${token.motion_id}/tokens?error=Can+only+resend+for+active+tokens`);
    }

    if (!token.recipient_email) {
      return res.redirect(`/admin/motions/${token.motion_id}/tokens?error=No+email+address+for+this+token`);
    }

    if (!isEmailConfigured()) {
      return res.redirect(`/admin/motions/${token.motion_id}/tokens?error=Email+not+configured`);
    }

    enqueueTokenEmail(tokenId);
    res.redirect(`/admin/motions/${token.motion_id}/tokens?success=Email+queued+for+delivery`);

    // Best-effort: kick off processing immediately
    processPendingTokenEmails({ baseUrl: BASE_URL, limit: 50 }).catch(err => {
      logger.error('immediate token email processing failed', { tokenId, error: err.message });
    });
  } catch (err) {
    logger.error('Email resend error:', err);
    const token = tokenQueries.getById.get(tokenId);
    if (token) {
      res.redirect(`/admin/motions/${token.motion_id}/tokens?error=Failed+to+queue+email`);
    } else {
      res.status(500).send('Failed to resend email');
    }
  }
});

// Council Members Management
app.get('/admin/council', requireAuth, (req, res) => {
  const members = councilQueries.getAll.all();
  res.render('council', {
    members,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

app.post('/admin/council', requireAuth, validate(schemas.councilMember), (req, res) => {
  const { name, email, unit_number, whatsapp } = req.body;

  try {
    const existing = councilQueries.findByEmail.get(email);
    if (existing) {
      return res.redirect('/admin/council?error=' + encodeURIComponent('Email already exists'));
    }

    const now = new Date().toISOString();
    councilQueries.create.run(name, email, unit_number || null, whatsapp || null, now, now);

    logger.info(`Council member created: ${email}`);
    res.redirect('/admin/council?success=' + encodeURIComponent('Council member added successfully'));
  } catch (err) {
    logger.error('Council member creation error:', err);
    res.redirect('/admin/council?error=' + encodeURIComponent('Failed to add council member'));
  }
});

app.post('/admin/council/:id/edit', requireAuth, validate(schemas.councilMember), (req, res) => {
  const { id } = req.params;
  const { name, email, unit_number, whatsapp } = req.body;

  try {
    const existing = councilQueries.getById.get(id);
    if (!existing) {
      return res.redirect('/admin/council?error=' + encodeURIComponent('Council member not found'));
    }

    const duplicate = db.prepare('SELECT * FROM council_members WHERE email = ? AND id != ?').get(email, id);
    if (duplicate) {
      return res.redirect('/admin/council?error=' + encodeURIComponent('Email already exists'));
    }

    const now = new Date().toISOString();
    councilQueries.update.run(name, email, unit_number || null, whatsapp || null, now, id);

    logger.info(`Council member updated: ${id}`);
    res.redirect('/admin/council?success=' + encodeURIComponent('Council member updated successfully'));
  } catch (err) {
    logger.error('Council member update error:', err);
    res.redirect('/admin/council?error=' + encodeURIComponent('Failed to update council member'));
  }
});

app.post('/admin/council/:id/delete', requireAuth, (req, res) => {
  const { id } = req.params;

  try {
    const existing = councilQueries.getById.get(id);
    if (!existing) {
      return res.redirect('/admin/council?error=' + encodeURIComponent('Council member not found'));
    }

    councilQueries.delete.run(id);

    logger.info(`Council member deleted: ${id}`);
    res.redirect('/admin/council?success=' + encodeURIComponent('Council member deleted successfully'));
  } catch (err) {
    logger.error('Council member deletion error:', err);
    res.redirect('/admin/council?error=' + encodeURIComponent('Failed to delete council member'));
  }
});

// Export ballots as CSV
app.get('/admin/motions/:id/export.csv', requireAuth, (req, res) => {
  const { id } = req.params;

  // Audit log CSV export
  logger.info('CSV export requested', {
    motionId: id,
    sessionId: req.session.id,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  const ballots = ballotQueries.getByMotion.all(id);

  let csv = 'submitted_at,choice,recipient_name,recipient_email,unit_number,token_status,used_at\n';

  for (const ballot of ballots) {
    csv += [
      csvField(ballot.submitted_at),
      csvField(ballot.choice),
      csvField(ballot.recipient_name || ''),
      csvField(ballot.recipient_email || ''),
      csvField(ballot.unit_number || ''),
      csvField(ballot.token_status),
      csvField(ballot.used_at || '')
    ].join(',') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="motion-${id}-ballots.csv"`);
  res.send(csv);
});

// Export Results - Display form
app.get('/admin/export', requireAuth, (req, res) => {
  res.render('export', { error: null, success: null });
});

// Export Results - Generate export
app.post('/admin/export', requireAuth, validate(schemas.export), (req, res) => {
  const { start_date, end_date, format } = req.body;

  // Convert both bounds from the input's wall-clock zone into UTC before
  // comparing against the stored close_at values.
  const startIso = normalizeDateBound(start_date);
  const endIso = normalizeDateBound(end_date);

  // Validate date range
  if (!startIso || !endIso) {
    return res.render('export', {
      error: 'Please provide a valid start and end date',
      success: null
    });
  }

  if (endIso < startIso) {
    return res.render('export', {
      error: 'End date must be after or equal to start date',
      success: null
    });
  }

  // Audit log
  logger.info('Export requested', {
    start_date,
    end_date,
    format,
    sessionId: req.session.id,
    ip: req.ip
  });

  // Query motions in date range
  const motions = db.prepare(`
    SELECT * FROM motions
    WHERE close_at >= ? AND close_at <= ?
    AND status IN ('Closed', 'Published')
    ORDER BY close_at DESC
  `).all(startIso, endIso);

  if (motions.length === 0) {
    return res.render('export', {
      error: 'No closed or published motions found in this date range',
      success: null
    });
  }

  // Aggregate data for each motion
  const exportData = motions.map(motion => {
    const stats = getMotionStats(motion.id);
    const results = ballotQueries.getResultsByMotion.all(motion.id);
    return { motion, stats, results };
  });

  // Generate export based on format
  try {
    if (format === 'csv') {
      generateCSVExport(res, exportData, start_date, end_date);
    } else {
      generatePDFExport(res, exportData, start_date, end_date);
    }
  } catch (error) {
    logger.error('Export generation failed', { error: error.message, stack: error.stack });
    res.status(500).render('export', {
      error: 'Failed to generate export. Please try again.',
      success: null
    });
  }
});

// Admin Settings page
app.get('/admin/settings', requireAuth, (req, res) => {
  const property_manager_name = getSetting('property_manager_name') || '';
  const property_manager_email = getSetting('property_manager_email') || '';
  res.render('admin_settings', {
    error: req.query.error || null,
    success: req.query.success || null,
    dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite',
    property_manager_name,
    property_manager_email,
    imap_host: getSetting('imap_host') || process.env.IMAP_HOST || '',
    imap_port: getSetting('imap_port') || process.env.IMAP_PORT || '993',
    imap_security: getSetting('imap_security') || process.env.IMAP_SECURITY || 'ssl',
    imap_user: getSetting('imap_user') || process.env.IMAP_USER || '',
    imap_password_set: !!(getSetting('imap_password') || process.env.IMAP_PASSWORD),
    imap_authorized_senders: getSetting('imap_authorized_senders') || process.env.IMAP_AUTHORIZED_SENDERS || '',
    imap_poll_interval_ms: getSetting('imap_poll_interval_ms') || process.env.IMAP_POLL_INTERVAL_MS || '60000',
    imap_default_deadline_hours: getSetting('imap_default_deadline_hours') || process.env.IMAP_DEFAULT_DEADLINE_HOURS || '48',
    openwa_url: getSetting('openwa_url') || process.env.OPENWA_URL || '',
    openwa_api_key_set: !!(getSetting('openwa_api_key') || process.env.OPENWA_API_KEY),
    openwa_session_id: getSetting('openwa_session_id') || process.env.OPENWA_SESSION_ID || ''
  });
});

function getSettingsData() {
  return {
    property_manager_name: getSetting('property_manager_name') || '',
    property_manager_email: getSetting('property_manager_email') || '',
    dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite',
    imap_host: getSetting('imap_host') || process.env.IMAP_HOST || '',
    imap_port: getSetting('imap_port') || process.env.IMAP_PORT || '993',
    imap_security: getSetting('imap_security') || process.env.IMAP_SECURITY || 'ssl',
    imap_user: getSetting('imap_user') || process.env.IMAP_USER || '',
    imap_password_set: !!(getSetting('imap_password') || process.env.IMAP_PASSWORD),
    imap_authorized_senders: getSetting('imap_authorized_senders') || process.env.IMAP_AUTHORIZED_SENDERS || '',
    imap_poll_interval_ms: getSetting('imap_poll_interval_ms') || process.env.IMAP_POLL_INTERVAL_MS || '60000',
    imap_default_deadline_hours: getSetting('imap_default_deadline_hours') || process.env.IMAP_DEFAULT_DEADLINE_HOURS || '48',
    openwa_url: getSetting('openwa_url') || process.env.OPENWA_URL || '',
    openwa_api_key_set: !!(getSetting('openwa_api_key') || process.env.OPENWA_API_KEY),
    openwa_session_id: getSetting('openwa_session_id') || process.env.OPENWA_SESSION_ID || ''
  };
}

function renderAdminSettings(req, res, { error = null, success = null, property_manager_name, property_manager_email } = {}) {
  const pmName = typeof property_manager_name === 'string' ? property_manager_name : (getSetting('property_manager_name') || '');
  const pmEmail = typeof property_manager_email === 'string' ? property_manager_email : (getSetting('property_manager_email') || '');

  return res.render('admin_settings', {
    error,
    success,
    ...getSettingsData(),
    property_manager_name: pmName,
    property_manager_email: pmEmail
  });
}

app.post('/admin/settings/property-manager', requireAuth, (req, res) => {
  const { property_manager_name, property_manager_email } = req.body;

  const name = (property_manager_name || '').trim();
  const email = (property_manager_email || '').trim();

  if (!email) {
    return renderAdminSettings(req, res, {
      error: 'Property Manager email is required',
      property_manager_name: name,
      property_manager_email: email
    });
  }

  const emailSchema = Joi.string().email().max(200);
  const { error } = emailSchema.validate(email);
  if (error) {
    return renderAdminSettings(req, res, {
      error: 'Property Manager email must be a valid email address',
      property_manager_name: name,
      property_manager_email: email
    });
  }

  try {
    setSetting('property_manager_name', name);
    setSetting('property_manager_email', email);
    logger.info('Property Manager settings updated', {
      sessionId: req.session.id,
      ip: req.ip
    });

    return renderAdminSettings(req, res, {
      success: 'Property Manager settings updated successfully!',
      property_manager_name: name,
      property_manager_email: email
    });
  } catch (err) {
    logger.error('Failed to update Property Manager settings', err);
    return renderAdminSettings(req, res, {
      error: 'Failed to update Property Manager settings. Please try again.',
      property_manager_name: name,
      property_manager_email: email
    });
  }
});

// Change Admin Password
app.post('/admin/settings/password', requireAuth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  
  // Validate input
  if (!current_password || !new_password || !confirm_password) {
    return renderAdminSettings(req, res, { error: 'All fields are required' });
  }
  
  if (new_password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return renderAdminSettings(req, res, {
      error: `New password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters long`
    });
  }
  
  if (new_password !== confirm_password) {
    return renderAdminSettings(req, res, { error: 'New passwords do not match' });
  }
  
  // Verify current password
  if (!verifyAdminPassword(current_password)) {
    logger.warn('Admin password change failed - incorrect current password', {
      sessionId: req.session.id,
      ip: req.ip
    });
    return renderAdminSettings(req, res, { error: 'Current password is incorrect' });
  }
  
  // Check if new password is the same as current
  if (verifyAdminPassword(new_password)) {
    return renderAdminSettings(req, res, { error: 'New password must be different from current password' });
  }
  
  // Update the password in real-time
  try {
    updateAdminPassword(new_password, 'admin');
  } catch (err) {
    logger.error('Failed to update admin password:', err);
    return renderAdminSettings(req, res, { error: 'Failed to update password. Please try again.' });
  }

  // Rotate this session's id, then drop every other stored session. The render
  // afterwards is a redirect rather than a direct render on purpose: the CSRF
  // token is bound to the session id, and this request's token was minted under
  // the *old* id, so a freshly-rendered form would carry a token that fails.
  const ip = req.ip;
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      logger.error('Session regenerate failed after password change', { error: regenErr.message });
      return res.redirect('/admin/settings?error=' + encodeURIComponent(
        'Password updated, but your session could not be refreshed. Please log in again.'
      ));
    }

    req.session.isAdmin = true;
    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error('Session save failed after password change', { error: saveErr.message });
        return res.redirect('/admin/settings?error=' + encodeURIComponent(
          'Password updated, but your session could not be saved. Please log in again.'
        ));
      }

      invalidateOtherSessions(req.sessionID, (invErr, destroyed) => {
        if (invErr) {
          logger.warn('Could not invalidate other sessions after password change', { error: invErr.message });
        }

        logger.info('Admin password changed successfully', {
          ip,
          otherSessionsDestroyed: destroyed || 0,
          timestamp: new Date().toISOString()
        });

        const message = invErr
          ? 'Password updated successfully. You may want to review active sessions.'
          : 'Password updated successfully. All other sessions have been signed out.';
        res.redirect('/admin/settings?success=' + encodeURIComponent(message));
      });
    });
  });
});

// Test Email Configuration
app.post('/admin/settings/test-email', requireAuth, async (req, res) => {
  try {
    const result = await testEmailConfig();
    
    if (result.success) {
      logger.info('Email configuration test successful', {
        sessionId: req.session.id,
        ip: req.ip
      });
      return renderAdminSettings(req, res, { success: 'Email configuration is working correctly!' });
    } else {
      logger.warn('Email configuration test failed', {
        error: result.error,
        sessionId: req.session.id,
        ip: req.ip
      });
      return renderAdminSettings(req, res, { error: `Email test failed: ${result.error}` });
    }
  } catch (err) {
    logger.error('Email test error:', err);
    return renderAdminSettings(req, res, { error: `Email test error: ${err.message}` });
  }
});

// Test email trigger polling (runs one cycle immediately)
app.post('/admin/settings/test-email-trigger', requireAuth, async (req, res) => {
  try {
    const result = await emailTriggerPollOnce(getBaseUrl(req));
    if (!result.connected) {
      return renderAdminSettings(req, res, { error: `IMAP connection failed: ${result.reason}` });
    }
    const msg = `Connected. Unseen emails: ${result.unseenCount}. Created ${result.processed} vote(s), skipped ${result.skipped}, errors: ${result.errors}.`;
    return renderAdminSettings(req, res, { success: msg });
  } catch (err) {
    logger.error('Email trigger test error', { error: err.message });
    return renderAdminSettings(req, res, { error: `Poll error: ${err.message}` });
  }
});

// Save email trigger (IMAP) settings
app.post('/admin/settings/email-trigger', requireAuth, (req, res) => {
  const {
    imap_host, imap_port, imap_security, imap_user, imap_password,
    imap_authorized_senders, imap_poll_interval_ms, imap_default_deadline_hours
  } = req.body;

  try {
    if (imap_host !== undefined) setSetting('imap_host', imap_host.trim());
    if (imap_port !== undefined) setSetting('imap_port', imap_port.trim());
    if (imap_security === 'ssl' || imap_security === 'starttls') setSetting('imap_security', imap_security);
    if (imap_user !== undefined) setSetting('imap_user', imap_user.trim());
    if (imap_password && imap_password.trim()) setSetting('imap_password', imap_password.trim());
    if (imap_authorized_senders !== undefined) setSetting('imap_authorized_senders', imap_authorized_senders.trim());
    if (imap_poll_interval_ms !== undefined) setSetting('imap_poll_interval_ms', imap_poll_interval_ms.trim());
    if (imap_default_deadline_hours !== undefined) setSetting('imap_default_deadline_hours', imap_default_deadline_hours.trim());

    logger.info('Email trigger settings updated', { sessionId: req.session.id, ip: req.ip });
    return renderAdminSettings(req, res, { success: 'Email trigger settings saved.' });
  } catch (err) {
    logger.error('Failed to save email trigger settings:', err);
    return renderAdminSettings(req, res, { error: 'Failed to save email trigger settings.' });
  }
});

// Save WhatsApp (OpenWA) settings
app.post('/admin/settings/whatsapp', requireAuth, (req, res) => {
  const { openwa_url, openwa_api_key, openwa_session_id } = req.body;

  try {
    if (openwa_url !== undefined) setSetting('openwa_url', openwa_url.trim());
    if (openwa_api_key && openwa_api_key.trim()) setSetting('openwa_api_key', openwa_api_key.trim());
    if (openwa_session_id !== undefined) setSetting('openwa_session_id', openwa_session_id.trim());

    logger.info('WhatsApp settings updated', { sessionId: req.session.id, ip: req.ip });
    return renderAdminSettings(req, res, { success: 'WhatsApp settings saved.' });
  } catch (err) {
    logger.error('Failed to save WhatsApp settings:', err);
    return renderAdminSettings(req, res, { error: 'Failed to save WhatsApp settings.' });
  }
});

// Public results page (no authentication required)
app.get('/results/:id', (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);

  if (!motion || !['Closed', 'Published'].includes(motion.status)) {
    return res.status(404).type('html')
      .send('<h1>Results not available.</h1><p>The results for this motion have not been published yet.</p>');
  }

  motion.options = JSON.parse(motion.options_json);
  const stats = getMotionStats(id);

  // The named per-voter breakdown is opt-in per motion. It is off by default
  // because this page is unauthenticated: anyone holding the link would
  // otherwise see exactly how each unit voted.
  const showVoterBreakdown = !!motion.show_voter_breakdown;
  const voterStatus = showVoterBreakdown ? ballotQueries.getVoterStatusByMotion.all(id) : [];

  // Keep results pages out of search-engine indexes.
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.render('public_results', { motion, stats, voterStatus, showVoterBreakdown });
});

// Plain robots.txt for crawlers that ignore the header above.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin/\nDisallow: /vote/\nDisallow: /results/\n');
});

// Health check endpoints (for Coolify/Docker/monitoring)
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.status(200).json({ status: 'healthy' });
  } catch (err) {
    logger.error('Health check failed:', err);
    res.status(503).json({ status: 'unhealthy' });
  }
});

// Simple health check (for load balancers)
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Start server
const server = app.listen(PORT, () => {
  logger.info(`Strata Vote server running at ${BASE_URL}`);
  logger.info(`Admin login: ${BASE_URL}/admin/login`);

  // Start email trigger poller (no-op if IMAP not configured)
  startEmailTriggerPoller(BASE_URL);
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received, starting graceful shutdown`);

  server.close(() => {
    logger.info('HTTP server closed');

    try {
      db.close();
      logger.info('Database connection closed');
      process.exit(0);
    } catch (err) {
      logger.error('Error closing database:', err);
      process.exit(1);
    }
  });

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
