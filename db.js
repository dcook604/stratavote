const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists with proper error handling
const dataDir = path.join(__dirname, 'data');
try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o775 });
  }
  // Verify directory is writable
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch (err) {
  console.error('Failed to create or access data directory:', err);
  console.error('Data directory path:', dataDir);
  console.error('Current user:', process.env.USER || 'unknown');
  // Log permissions
  try {
    const stats = fs.statSync(dataDir);
    console.error('Directory permissions:', stats.mode.toString(8));
  } catch (e) {
    console.error('Could not stat directory');
  }
  throw err;
}

const dbPath = path.join(dataDir, 'data.sqlite');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Enable WAL mode for better concurrency and durability
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('wal_autocheckpoint = 1000');

// Initialize database schema
function initDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS motions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      options_json TEXT NOT NULL,
      open_at TEXT NOT NULL,
      close_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Draft', 'Open', 'Closed', 'Published')),
      required_majority TEXT NOT NULL CHECK(required_majority IN ('Simple', 'TwoThirds')),
      outcome TEXT NULL CHECK(outcome IS NULL OR outcome IN ('Passed', 'Failed', 'Tie', 'Cancelled')),
      outcome_notes TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voter_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      motion_id INTEGER NOT NULL REFERENCES motions(id),
      token TEXT NOT NULL UNIQUE,
      recipient_name TEXT NULL,
      recipient_email TEXT NULL,
      unit_number TEXT NULL,
      status TEXT NOT NULL CHECK(status IN ('Active', 'Used', 'Revoked')),
      used_at TEXT NULL,
      created_at TEXT NOT NULL,
      email_sent BOOLEAN DEFAULT 0,
      email_sent_at TEXT NULL,
      email_error TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS ballots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      motion_id INTEGER NOT NULL REFERENCES motions(id),
      voter_token_id INTEGER NOT NULL UNIQUE REFERENCES voter_tokens(id),
      choice TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      user_agent TEXT NULL,
      ip_hash TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_voter_tokens_motion ON voter_tokens(motion_id);
    CREATE INDEX IF NOT EXISTS idx_voter_tokens_token ON voter_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_ballots_motion ON ballots(motion_id);
    CREATE INDEX IF NOT EXISTS idx_ballots_token ON ballots(voter_token_id);
    CREATE INDEX IF NOT EXISTS idx_ballots_submitted ON ballots(submitted_at);
  `;

  db.exec(schema);

  // Migration: Add email tracking columns if they don't exist
  try {
    const tableInfo = db.pragma('table_info(voter_tokens)');
    const hasEmailSent = tableInfo.some(col => col.name === 'email_sent');

    if (!hasEmailSent) {
      db.exec(`
        ALTER TABLE voter_tokens ADD COLUMN email_sent BOOLEAN DEFAULT 0;
        ALTER TABLE voter_tokens ADD COLUMN email_sent_at TEXT NULL;
        ALTER TABLE voter_tokens ADD COLUMN email_error TEXT NULL;
      `);
      const logger = require('./logger');
      logger.info('Added email tracking columns to voter_tokens table');
    }
  } catch (err) {
    // Columns might already exist, ignore error
  }

  // Council Members table
  db.exec(`
    CREATE TABLE IF NOT EXISTS council_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      unit_number TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_council_members_email ON council_members(email);
    CREATE INDEX IF NOT EXISTS idx_council_members_unit ON council_members(unit_number);
  `);

  // Performance index for dashboard date filtering
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_motions_close_at ON motions(close_at);
  `);

  const logger = require('./logger');
  logger.info('Database initialized at:', dbPath);
}

// Initialize database immediately
initDatabase();

// Prepared statements for motions
const motionQueries = {
  create: db.prepare(`
    INSERT INTO motions (title, description, options_json, open_at, close_at, status, required_majority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getById: db.prepare('SELECT * FROM motions WHERE id = ?'),

  getAll: db.prepare('SELECT * FROM motions ORDER BY created_at DESC'),

  updateStatus: db.prepare('UPDATE motions SET status = ? WHERE id = ?'),

  updateOutcome: db.prepare(`
    UPDATE motions SET outcome = ?, outcome_notes = ? WHERE id = ?
  `)
};

// Prepared statements for voter tokens
const tokenQueries = {
  create: db.prepare(`
    INSERT INTO voter_tokens (motion_id, token, recipient_name, recipient_email, unit_number, status, created_at, email_sent, email_sent_at, email_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getByToken: db.prepare('SELECT * FROM voter_tokens WHERE token = ?'),

  getById: db.prepare('SELECT * FROM voter_tokens WHERE id = ?'),

  getByMotion: db.prepare('SELECT * FROM voter_tokens WHERE motion_id = ? ORDER BY created_at DESC'),

  markUsed: db.prepare('UPDATE voter_tokens SET status = ?, used_at = ? WHERE id = ?'),

  revoke: db.prepare('UPDATE voter_tokens SET status = ? WHERE id = ?'),

  updateEmailStatus: db.prepare(`
    UPDATE voter_tokens
    SET email_sent = ?, email_sent_at = ?, email_error = ?
    WHERE id = ?
  `)
};

// Prepared statements for ballots
const ballotQueries = {
  create: db.prepare(`
    INSERT INTO ballots (motion_id, voter_token_id, choice, submitted_at, user_agent, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  getByMotion: db.prepare(`
    SELECT b.*, vt.recipient_name, vt.recipient_email, vt.unit_number, vt.status as token_status, vt.used_at
    FROM ballots b
    JOIN voter_tokens vt ON b.voter_token_id = vt.id
    WHERE b.motion_id = ?
    ORDER BY b.submitted_at DESC
  `),

  countByMotion: db.prepare('SELECT COUNT(*) as count FROM ballots WHERE motion_id = ?'),

  getResultsByMotion: db.prepare(`
    SELECT choice, COUNT(*) as count
    FROM ballots
    WHERE motion_id = ?
    GROUP BY choice
    ORDER BY count DESC
  `),

  existsForToken: db.prepare('SELECT 1 FROM ballots WHERE voter_token_id = ? LIMIT 1')
};

// Prepared statements for council members
const councilQueries = {
  create: db.prepare(`
    INSERT INTO council_members (name, email, unit_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getById: db.prepare('SELECT * FROM council_members WHERE id = ?'),
  getAll: db.prepare('SELECT * FROM council_members ORDER BY name ASC'),
  update: db.prepare(`
    UPDATE council_members
    SET name = ?, email = ?, unit_number = ?, updated_at = ?
    WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM council_members WHERE id = ?'),
  findByEmail: db.prepare('SELECT * FROM council_members WHERE email = ?')
};

// Transaction wrapper for vote submission
function submitVote(motionId, tokenId, choice, userAgent, ipHash) {
  try {
    const transaction = db.transaction(() => {
      const now = new Date().toISOString();

      // Verify token hasn't been used (race condition protection)
      const token = tokenQueries.getById.get(tokenId);
      if (!token || token.status !== 'Active') {
        throw new Error('Token is not active');
      }

      ballotQueries.create.run(motionId, tokenId, choice, now, userAgent, ipHash);
      tokenQueries.markUsed.run('Used', now, tokenId);
    });

    return transaction();
  } catch (err) {
    logger.error('submitVote transaction error:', err);
    throw err;
  }
}

// Get motion statistics
function getMotionStats(motionId) {
  const tokenCount = db.prepare('SELECT COUNT(*) as count FROM voter_tokens WHERE motion_id = ? AND status != ?')
    .get(motionId, 'Revoked');

  const ballotCount = ballotQueries.countByMotion.get(motionId);
  const results = ballotQueries.getResultsByMotion.all(motionId);

  return {
    eligible: tokenCount.count,
    voted: ballotCount.count,
    remaining: tokenCount.count - ballotCount.count,
    results
  };
}

module.exports = {
  db,
  motionQueries,
  tokenQueries,
  ballotQueries,
  councilQueries,
  submitVote,
  getMotionStats
};
