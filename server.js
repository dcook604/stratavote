require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
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
    recipients: Joi.string().min(1).max(10000).required()
  }),

  vote: Joi.object({
    token: Joi.string().length(32).required(),
    choice: Joi.string().min(1).max(100).required()
  }),

  login: Joi.object({
    password: Joi.string().min(1).max(200).required()
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

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'strata.sid',
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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
  if (req.session.isAdmin) {
    return next();
  }
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
  if (req.session.isAdmin) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin_login', { error: null });
});

// Login handler
app.post('/admin/login', loginLimiter, validate(schemas.login), (req, res) => {
  const { password } = req.body;

  if (password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }

  res.render('admin_login', { error: 'Invalid password.' });
});

// Logout
app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Dashboard
app.get('/admin/dashboard', requireAuth, (req, res) => {
  const motions = motionQueries.getAll.all();

  const motionsWithStats = motions.map(motion => {
    const stats = getMotionStats(motion.id);
    return { ...motion, stats };
  });

  res.render('admin_dashboard', { motions: motionsWithStats });
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

  res.render('tokens', {
    motion,
    tokens,
    baseUrl: BASE_URL,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Generate tokens
app.post('/admin/motions/:id/tokens', requireAuth, validate(schemas.token), async (req, res) => {
  const { id } = req.params;
  const { recipients } = req.body;

  if (!recipients || !recipients.trim()) {
    return res.redirect(`/admin/motions/${id}/tokens?error=No+recipients+provided`);
  }

  const motion = motionQueries.getById.get(id);
  if (!motion) {
    return res.redirect(`/admin/motions/${id}/tokens?error=Motion+not+found`);
  }

  const lines = recipients.split('\n').map(line => line.trim()).filter(line => line);
  let created = 0;
  let emailsSent = 0;
  let emailsFailed = 0;

  const emailConfigured = isEmailConfigured();

  try {
    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim());
      const name = parts[0] || null;
      const email = parts[1] || null;
      const unit = parts[2] || null;

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
