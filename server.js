require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
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
  updateAdminPassword
} = require('./db');
const { isEmailConfigured, sendVotingLink } = require('./email');

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

const app = express();
const PORT = process.env.PORT || 3300;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Helper to get the base URL from request (respects proxy)
function getBaseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// BASE_URL for logging and emails only (not for redirects)
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
    unit_number: Joi.string().max(50).allow('').optional()
  })
};

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

// Export helper functions
function generateCSVExport(res, exportData, start_date, end_date) {
  const now = new Date().toISOString();
  const startFormatted = start_date.substring(0, 10);
  const endFormatted = end_date.substring(0, 10);

  let csv = 'VOTE RESULTS EXPORT\n';
  csv += `Generated: ${now}\n`;
  csv += `Date Range: ${start_date} to ${end_date}\n\n`;
  csv += 'Motion ID,Motion Title,Status,Outcome,Opens At,Closes At,Required Majority,Eligible Voters,Votes Cast,Turnout %,Choice,Vote Count,Vote %\n';

  for (const { motion, stats, results } of exportData) {
    const turnout = stats.eligible > 0
      ? (stats.voted / stats.eligible * 100).toFixed(2)
      : '0.00';

    if (results.length === 0) {
      // Motion with no votes
      csv += [
        motion.id,
        `"${motion.title.replace(/"/g, '""')}"`,
        motion.status,
        motion.outcome || '',
        motion.open_at,
        motion.close_at,
        motion.required_majority,
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
          motion.id,
          `"${motion.title.replace(/"/g, '""')}"`,
          motion.status,
          motion.outcome || '',
          motion.open_at,
          motion.close_at,
          motion.required_majority,
          stats.eligible,
          stats.voted,
          turnout,
          `"${result.choice.replace(/"/g, '""')}"`,
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
app.use(express.static('public'));
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

// Note: No stale session recovery middleware needed.
// express-session handles stale cookies gracefully: if the store can't find
// the session, it creates a new empty one. On login, session.save() persists
// it and sends a fresh cookie to the browser.

// GLOBAL HTTP LOGGER - Logs ALL requests with session details
app.use((req, res, next) => {
  const start = Date.now();

  // Log immediately when request arrives
  logger.info('HTTP REQUEST', {
    method: req.method,
    path: req.originalUrl,
    sessionID: req.sessionID,
    sessionKeys: Object.keys(req.session || {}),
    hasIsAdmin: 'isAdmin' in (req.session || {}),
    isAdmin: req.session?.isAdmin,
    hasCookieHeader: !!req.headers.cookie,
    referer: req.headers.referer || 'none',
    userAgent: req.get('user-agent')?.substring(0, 50)
  });

  // Log when response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const setCookieRaw = res.getHeader('set-cookie');

    // Parse Set-Cookie to show details (not the actual value for security)
    let cookieInfo = 'none';
    let rawCookieForDebug = 'none';
    if (setCookieRaw) {
      const cookieStr = Array.isArray(setCookieRaw) ? setCookieRaw[0] : setCookieRaw;
      // Log the FULL raw cookie to diagnose SameSite mismatch
      rawCookieForDebug = cookieStr;
      const parts = cookieStr.split(';').map(p => p.trim());
      const name = parts[0].split('=')[0];
      const flags = parts.slice(1).join('; ');
      cookieInfo = `${name}=<value>; ${flags}`;
    }

    logger.info('HTTP RESPONSE', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      sessionID: req.sessionID,
      sessionKeys: Object.keys(req.session || {}),
      isAdmin: req.session?.isAdmin,
      setCookieHeader: !!setCookieRaw,
      setCookieDetails: cookieInfo,
      RAW_SET_COOKIE_HEADER: rawCookieForDebug, // DEBUG: full cookie to find SameSite issue
      location: res.getHeader('location') || 'none'
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
  xssFilter: true
}));

// HTTPS enforcement in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // Skip HTTPS redirect for health check endpoints
    if (req.path === '/healthz' || req.path === '/health') {
      return next();
    }

    const forwardedProto = req.get('x-forwarded-proto');
    const forwardedHost = req.get('x-forwarded-host');

    // Check if request is already HTTPS (via proxy or direct)
    const isHttps = req.secure || forwardedProto === 'https';

    if (!isHttps) {
      // Use forwarded host if available, otherwise fallback to req.get('host')
      const host = forwardedHost || req.get('host');
      const redirectUrl = `https://${host}${req.url}`;

      logger.info('HTTPS REDIRECT', {
        from: `${req.protocol}://${req.get('host')}${req.url}`,
        to: redirectUrl,
        forwardedProto,
        forwardedHost
      });

      return res.redirect(301, redirectUrl);
    }
    next();
  });
}

// CSRF protection using COOKIES (not session) to avoid overwriting session cookie
// cookie: true means CSRF tokens are stored in a separate cookie, not in the session
const csrfProtection = csrf({
  cookie: {
    key: '_csrf',
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/'
  }
});
app.use((req, res, next) => {
  // Skip CSRF for voting endpoints (they use one-time tokens for auth)
  if (req.path.startsWith('/vote/') && req.method === 'POST') {
    return next();
  }
  if (req.path.match(/^\/vote\/\d+$/) && req.method === 'GET') {
    return next();
  }
  // Skip CSRF for login POST (password-only form, no CSRF attack vector)
  if (req.path === '/admin/login' && req.method === 'POST') {
    return next();
  }
  csrfProtection(req, res, next);
});

app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken;
  next();
});

// CSRF error handler - show friendly message instead of raw 403
app.use((err, req, res, next) => {
  if (err.code !== 'EBADCSRFTOKEN') return next(err);

  logger.warn('CSRF token validation failed', {
    path: req.path,
    method: req.method,
    sessionID: req.sessionID
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
    sessionID: req.sessionID
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

// Helper: validate vote eligibility
function validateVoteEligibility(motion, token) {
  const now = new Date();
  const openAt = new Date(motion.open_at);
  const closeAt = new Date(motion.close_at);

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
    return { valid: false, message: 'Voting has not yet opened.' };
  }

  if (now > closeAt) {
    return { valid: false, message: 'Voting has closed.' };
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
    logger.warn('Login failed - invalid password', { sessionID: req.sessionID });
    return res.render('admin_login', { error: 'Invalid password.' });
  }

  // Set admin flag and save session
  req.session.isAdmin = true;
  req.session.save((err) => {
    if (err) {
      logger.error('Session save error on login', { error: err.message, sessionID: req.sessionID });
      return next(err);
    }

    logger.info('Login success', { sessionID: req.sessionID });
    return res.redirect('/admin/dashboard');
  });
});

// Logout
app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Dashboard
app.get('/admin/dashboard', requireAuth, (req, res) => {
  const { start_date, end_date } = req.query;

  let motions;
  let isFiltered = false;

  if (start_date && end_date) {
    // Filter by close_at date range
    motions = db.prepare(`
      SELECT * FROM motions
      WHERE close_at >= ? AND close_at <= ?
      ORDER BY created_at DESC
    `).all(start_date, end_date);
    isFiltered = true;
  } else {
    // Default: Last 10 motions
    motions = db.prepare(`
      SELECT * FROM motions
      ORDER BY created_at DESC
      LIMIT 10
    `).all();
  }

  const motionsWithStats = motions.map(motion => {
    const stats = getMotionStats(motion.id);
    return { ...motion, stats };
  });

  res.render('admin_dashboard', {
    motions: motionsWithStats,
    isFiltered,
    startDate: start_date || null,
    endDate: end_date || null
  });
});

// New motion form
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

  try {
    const motionId = generateUUID();
    const motionRef = generateMotionRef();
    
    motionQueries.create.run(
      motionId,
      motionRef,
      title,
      description,
      optionsJson,
      open_at,
      close_at,
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

// Motion detail
app.get('/admin/motions/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const motion = motionQueries.getById.get(id);

  if (!motion) {
    return res.status(404).send('Motion not found');
  }

  motion.options = JSON.parse(motion.options_json);
  const stats = getMotionStats(id);

  res.render('motion_detail', {
    motion,
    stats,
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
  
  try {
    logger.info('Attempting to delete motion', { motionId: id, title: motion.title });
    
    // Check if motion has any voter tokens
    const tokens = tokenQueries.getByMotion.all(id);
    logger.info('Motion has tokens', { motionId: id, tokenCount: tokens.length });
    
    // Delete in transaction to maintain referential integrity
    const transaction = db.transaction(() => {
      // Delete voter tokens first (foreign key constraint)
      logger.info('Deleting voter tokens for motion', { motionId: id });
      const deleteResult = tokenQueries.deleteByMotion.run(id);
      logger.info('Voter tokens deleted', { motionId: id, deletedCount: deleteResult.changes });
      
      // Delete the motion
      logger.info('Deleting motion', { motionId: id });
      const motionResult = motionQueries.delete.run(id);
      logger.info('Motion deleted', { motionId: id, deletedCount: motionResult.changes });
    });
    
    transaction();
    logger.info('Motion deletion transaction completed successfully', { motionId: id, title: motion.title });
    res.redirect('/admin/dashboard?success=Motion+deleted+successfully');
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
app.post('/admin/motions/:id/tokens', requireAuth, validate(schemas.token), async (req, res) => {
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
  let emailsSent = 0;
  let emailsFailed = 0;

  const emailConfigured = isEmailConfigured();

  try {
    for (const recipient of recipientList) {
      const { name, email, unit } = recipient;

      const token = crypto.randomBytes(24).toString('base64url');
      const created_at = new Date().toISOString();

      // Create token with email status fields
      const result = tokenQueries.create.run(
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
      created++;

      // Try to send email if configured and email address is provided
      if (emailConfigured && email) {
        const votingLink = `${BASE_URL}/vote/${id}?token=${token}`;

        try {
          const emailResult = await sendVotingLink(name, email, votingLink, motion);

          if (emailResult.success) {
            // Update token with email sent status
            tokenQueries.updateEmailStatus.run(
              1, // email_sent = true
              new Date().toISOString(), // email_sent_at
              null, // email_error
              result.lastInsertRowid
            );
            emailsSent++;
          } else {
            // Update token with email error
            tokenQueries.updateEmailStatus.run(
              0, // email_sent = false
              null, // email_sent_at
              emailResult.error || 'Unknown error', // email_error
              result.lastInsertRowid
            );
            emailsFailed++;
          }
        } catch (emailErr) {
          logger.error('Email send error:', emailErr);
          tokenQueries.updateEmailStatus.run(
            0,
            null,
            emailErr.message,
            result.lastInsertRowid
          );
          emailsFailed++;
        }
      }
    }

    // Build success message
    let message = `Created ${created} token(s)`;
    if (emailConfigured) {
      message += `. Sent ${emailsSent} email(s)`;
      if (emailsFailed > 0) {
        message += `, ${emailsFailed} failed`;
      }
    } else {
      message += `. Email not configured - please copy links manually`;
    }

    res.redirect(`/admin/motions/${id}/tokens?success=${encodeURIComponent(message)}`);
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
app.post('/admin/tokens/:tokenId/resend-email', requireAuth, async (req, res) => {
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

    const motion = motionQueries.getById.get(token.motion_id);
    if (!motion) {
      return res.status(404).send('Motion not found');
    }

    const votingLink = `${BASE_URL}/vote/${token.motion_id}?token=${token.token}`;

    const emailResult = await sendVotingLink(
      token.recipient_name,
      token.recipient_email,
      votingLink,
      motion
    );

    if (emailResult.success) {
      tokenQueries.updateEmailStatus.run(
        1, // email_sent = true
        new Date().toISOString(), // email_sent_at
        null, // email_error
        tokenId
      );
      res.redirect(`/admin/motions/${token.motion_id}/tokens?success=Email+sent+successfully`);
    } else {
      tokenQueries.updateEmailStatus.run(
        0, // email_sent = false
        null, // email_sent_at
        emailResult.error || 'Unknown error', // email_error
        tokenId
      );
      res.redirect(`/admin/motions/${token.motion_id}/tokens?error=${encodeURIComponent('Failed to send email: ' + emailResult.error)}`);
    }
  } catch (err) {
    logger.error('Email resend error:', err);
    const token = tokenQueries.getById.get(tokenId);
    if (token) {
      res.redirect(`/admin/motions/${token.motion_id}/tokens?error=Failed+to+send+email`);
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
  const { name, email, unit_number } = req.body;

  try {
    const existing = councilQueries.findByEmail.get(email);
    if (existing) {
      return res.redirect('/admin/council?error=' + encodeURIComponent('Email already exists'));
    }

    const now = new Date().toISOString();
    councilQueries.create.run(name, email, unit_number || null, now, now);

    logger.info(`Council member created: ${email}`);
    res.redirect('/admin/council?success=' + encodeURIComponent('Council member added successfully'));
  } catch (err) {
    logger.error('Council member creation error:', err);
    res.redirect('/admin/council?error=' + encodeURIComponent('Failed to add council member'));
  }
});

app.post('/admin/council/:id/edit', requireAuth, validate(schemas.councilMember), (req, res) => {
  const { id } = req.params;
  const { name, email, unit_number } = req.body;

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
    councilQueries.update.run(name, email, unit_number || null, now, id);

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
      ballot.submitted_at,
      ballot.choice,
      ballot.recipient_name || '',
      ballot.recipient_email || '',
      ballot.unit_number || '',
      ballot.token_status,
      ballot.used_at || ''
    ].map(field => `"${field}"`).join(',') + '\n';
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

  // Validate date range
  if (new Date(end_date) < new Date(start_date)) {
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
  `).all(start_date, end_date);

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
  res.render('admin_settings', { 
    error: null, 
    success: null,
    dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
  });
});

// Change Admin Password
app.post('/admin/settings/password', requireAuth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  
  // Validate input
  if (!current_password || !new_password || !confirm_password) {
    return res.render('admin_settings', {
      error: 'All fields are required',
      success: null,
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  }
  
  if (new_password.length < 8) {
    return res.render('admin_settings', {
      error: 'New password must be at least 8 characters long',
      success: null,
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  }
  
  if (new_password !== confirm_password) {
    return res.render('admin_settings', {
      error: 'New passwords do not match',
      success: null,
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  }
  
  // Verify current password
  if (!verifyAdminPassword(current_password)) {
    logger.warn('Admin password change failed - incorrect current password', {
      sessionId: req.session.id,
      ip: req.ip
    });
    return res.render('admin_settings', {
      error: 'Current password is incorrect',
      success: null,
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  }
  
  // Check if new password is the same as current
  if (verifyAdminPassword(new_password)) {
    return res.render('admin_settings', {
      error: 'New password must be different from current password',
      success: null,
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  }
  
  // Update the password in real-time
  try {
    updateAdminPassword(new_password, 'admin');
    
    logger.info('Admin password changed successfully', {
      sessionId: req.session.id,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    
    res.render('admin_settings', {
      error: null,
      success: 'Password updated successfully!',
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  } catch (err) {
    logger.error('Failed to update admin password:', err);
    res.render('admin_settings', {
      error: 'Failed to update password. Please try again.',
      success: null,
      dbPath: db.filename ? db.filename.split('/').pop() : 'SQLite'
    });
  }
});

// Health check endpoints (for Coolify/Docker/monitoring)
app.get('/health', (req, res) => {
  try {
    // Check database connection
    const dbCheck = db.prepare('SELECT 1').get();

    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbCheck ? 'connected' : 'disconnected',
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    });
  } catch (err) {
    logger.error('Health check failed:', err);
    res.status(503).json({
      status: 'unhealthy',
      error: 'Database connection failed'
    });
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
