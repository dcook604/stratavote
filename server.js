require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
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
  submitVote,
  getMotionStats
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
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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
// Determine session storage directory
const persistentDir = path.join(__dirname, 'persistent');
const sessionDir = fs.existsSync(persistentDir) ? persistentDir : __dirname;

logger.info('Session store configuration', {
  directory: sessionDir,
  isPersistent: fs.existsSync(persistentDir)
});

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: sessionDir,
    table: 'sessions',
    // Clean up expired sessions every hour
    concurrentDB: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'strata.sid',
  proxy: true, // Trust the reverse proxy for secure cookie handling
  cookie: {
    httpOnly: true,
    // CRITICAL: Set secure=true in production for HTTPS connections
    // With trust proxy enabled, Express will properly handle this behind Traefik
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

logger.info('Session middleware configured', {
  store: 'SQLiteStore',
  cookieSecure: IS_PRODUCTION,
  cookieSameSite: 'lax',
  trustProxy: true
});

// Debug middleware - log session state on every request
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) {
    logger.info('Request', {
      method: req.method,
      path: req.path,
      sessionID: req.sessionID,
      hasSession: !!req.session,
      isAdmin: req.session?.isAdmin,
      cookies: req.headers.cookie ? 'present' : 'missing'
    });
  }
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
    if (!req.secure && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect(301, 'https://' + req.get('host') + req.url);
    }
    next();
  });
}

// CSRF protection (skip for public voting endpoints)
const csrfProtection = csrf({ cookie: false });
app.use((req, res, next) => {
  // Skip CSRF for voting endpoints (they use one-time tokens for auth)
  if (req.path.startsWith('/vote/') && req.method === 'POST') {
    return next();
  }
  if (req.path.match(/^\/vote\/\d+$/) && req.method === 'GET') {
    return next();
  }
  csrfProtection(req, res, next);
});

app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken;
  next();
});

// Auth middleware
function requireAuth(req, res, next) {
  // CRITICAL DEBUG: Log EVERYTHING about the session
  logger.info('Auth check', {
    path: req.path,
    sessionID: req.sessionID,
    hasSession: !!req.session,
    sessionKeys: Object.keys(req.session || {}),
    isAdmin: req.session?.isAdmin,
    isAdminType: typeof req.session?.isAdmin,
    isAdminValue: String(req.session?.isAdmin),
    hasCookie: !!req.headers.cookie,
    cookieHeader: req.headers.cookie
  });

  if (req.session.isAdmin) {
    logger.info('Auth PASSED - allowing access');
    return next();
  }

  logger.warn('Auth FAILED - redirecting to login', {
    path: req.path,
    sessionID: req.sessionID,
    reason: `isAdmin is ${req.session?.isAdmin}`
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
  logger.info('Login page accessed', {
    sessionID: req.sessionID,
    hasSession: !!req.session,
    isAdmin: req.session?.isAdmin,
    hasCookie: !!req.headers.cookie,
    cookieNames: req.headers.cookie ? req.headers.cookie.split(';').map(c => c.trim().split('=')[0]) : []
  });

  if (req.session.isAdmin) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin_login', { error: null });
});

// Login handler
app.post('/admin/login', loginLimiter, validate(schemas.login), (req, res) => {
  const { password } = req.body;

  // Debug logging for login attempts
  logger.info('Login attempt', {
    sessionID: req.sessionID,
    hasSession: !!req.session,
    protocol: req.protocol,
    secure: req.secure,
    hostname: req.hostname,
    forwardedProto: req.get('x-forwarded-proto'),
    forwardedHost: req.get('x-forwarded-host'),
    userAgent: req.get('user-agent')
  });

  if (password === process.env.ADMIN_PASSWORD) {
    // Regenerate session to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        logger.error('Session regeneration error', { error: err.message, sessionID: req.sessionID });
        return res.render('admin_login', { error: 'Session error. Please try again.' });
      }

      // Set admin flag on the NEW regenerated session
      req.session.isAdmin = true;

      // Explicitly save the session to SQLite store
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error('Session save error', { error: saveErr.message, sessionID: req.sessionID });
          return res.render('admin_login', { error: 'Session error. Please try again.' });
        }

        // CRITICAL DEBUG: Log exactly what we saved
        logger.info('Login successful - session saved', {
          sessionID: req.sessionID,
          sessionKeys: Object.keys(req.session),
          isAdmin: req.session.isAdmin,
          isAdminType: typeof req.session.isAdmin,
          isAdminValue: String(req.session.isAdmin),
          cookieSecure: req.session.cookie.secure,
          cookieSameSite: req.session.cookie.sameSite,
          cookiePath: req.session.cookie.path,
          storeType: 'SQLiteStore',
          redirectTo: '/admin/dashboard'
        });

        // NOW redirect - session is saved to disk
        return res.redirect('/admin/dashboard');
      });
    });
  } else {
    logger.warn('Login failed - invalid password', { sessionID: req.sessionID });
    res.render('admin_login', { error: 'Invalid password.' });
  }
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
    const result = motionQueries.create.run(
      title,
      description,
      optionsJson,
      open_at,
      close_at,
      'Draft',
      majority,
      created_at
    );

    res.redirect(`/admin/motions/${result.lastInsertRowid}`);
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
