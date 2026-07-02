'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const logger = require('../logger');
const { getSetting, db, generateUUID, generateMotionRef, motionQueries, tokenQueries, enqueueTokenEmail, isEmailAlreadyProcessed, recordProcessedEmail } = require('../db');
const { isEmailConfigured } = require('../email');
const { sendVotingLink: sendWhatsApp } = require('./whatsapp');
const { processPendingTokenEmails } = require('./notificationWorker');

function getImapConfig() {
  const security = getSetting('imap_security') || process.env.IMAP_SECURITY || 'ssl';
  return {
    user: getSetting('imap_user') || process.env.IMAP_USER || '',
    password: getSetting('imap_password') || process.env.IMAP_PASSWORD || '',
    host: getSetting('imap_host') || process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(getSetting('imap_port') || process.env.IMAP_PORT || '993', 10),
    secure: security !== 'starttls',
    authorizedSenders: (getSetting('imap_authorized_senders') || process.env.IMAP_AUTHORIZED_SENDERS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    pollIntervalMs: parseInt(getSetting('imap_poll_interval_ms') || process.env.IMAP_POLL_INTERVAL_MS || '60000', 10),
    defaultDeadlineHours: parseInt(getSetting('imap_default_deadline_hours') || process.env.IMAP_DEFAULT_DEADLINE_HOURS || '48', 10)
  };
}

function createMotionFromEmail({ title, description, deadlineDate }) {
  const motionId = generateUUID();
  const motionRef = generateMotionRef();
  const now = new Date().toISOString();

  motionQueries.create.run(
    motionId,
    motionRef,
    title,
    description || title,
    JSON.stringify(['Yes', 'No', 'Abstain']),
    now,
    deadlineDate.toISOString(),
    'Open',
    'Simple',
    now
  );

  return { id: motionId, title, description };
}

function issueTokensToCouncil(motion, baseUrl) {
  const allMembers = db.prepare('SELECT * FROM council_members ORDER BY name ASC').all();
  const emailConfigured = isEmailConfigured();
  const tokenIds = [];

  for (const member of allMembers) {
    const { name, email, whatsapp } = member;
    if (!email) continue;

    const existing = tokenQueries.getActiveByMotionEmail.get(motion.id, email);
    if (existing) continue;

    const token = crypto.randomBytes(24).toString('base64url');
    const now = new Date().toISOString();

    let result;
    try {
      result = tokenQueries.create.run(
        motion.id, token, name, email, member.unit_number,
        'Active', now, 0, null, null
      );
    } catch (e) {
      if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
      throw e;
    }

    if (emailConfigured && email) {
      enqueueTokenEmail(result.lastInsertRowid);
      tokenIds.push(result.lastInsertRowid);
    }

    if (whatsapp) {
      sendWhatsApp({ to: whatsapp, token, motionTitle: motion.title, baseUrl }).catch(err => {
        logger.warn('WhatsApp send failed', { error: err.message, phone: whatsapp });
      });
    }
  }

  if (tokenIds.length > 0) {
    processPendingTokenEmails({ baseUrl, limit: 50 }).catch(err => {
      logger.error('immediate token email processing failed', { motionId: motion.id, error: err.message });
    });
  }

  return allMembers.length;
}

const POLL_TIMEOUT_MS = 60000;

// Returns { connected, unseenCount, processed, skipped, errors }
async function pollOnceInner(baseUrl) {
  const cfg = getImapConfig();
  if (!cfg.user || !cfg.password) {
    return { connected: false, reason: 'IMAP credentials not configured' };
  }

  const imapLogger = {
    debug: (obj) => logger.debug('IMAP', obj),
    info:  (obj) => logger.debug('IMAP', obj),
    warn:  (obj) => logger.warn('IMAP', obj),
    error: (obj) => logger.error('IMAP', obj)
  };

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: imapLogger,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });

  let lock;

  try {
    logger.info('Email trigger: connecting to IMAP', { host: cfg.host, port: cfg.port, secure: cfg.secure });
    await client.connect();
    logger.info('Email trigger: IMAP connected');
  } catch (err) {
    const detail = err.response || err.responseText || err.serverResponseCode || err.code || '';
    logger.error('Email trigger: IMAP connection failed', {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      error: err.message,
      detail,
      code: err.code || ''
    });
    await client.logout().catch(() => {});
    const reason = detail ? `${err.message}: ${detail}` : err.message;
    return { connected: false, reason };
  }

  try {
    logger.info('Email trigger: acquiring INBOX lock');
    lock = await client.getMailboxLock('INBOX');
    logger.info('Email trigger: INBOX lock acquired');
  } catch (err) {
    const detail = err.response || err.responseText || err.serverResponseCode || '';
    logger.error('Email trigger: IMAP mailbox lock failed', {
      error: err.message,
      detail,
      responseStatus: err.responseStatus || ''
    });
    await client.logout().catch(() => {});
    const reason = detail ? `${err.message}: ${detail}` : err.message;
    return { connected: false, reason };
  }

  const result = { connected: true, unseenCount: 0, processed: 0, skipped: 0, errors: 0 };

  try {
    // Only look at emails from the last 7 days to avoid scanning a huge inbox
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    logger.info('Email trigger: searching for unseen messages', { since: since.toISOString() });
    const uids = await client.search({ seen: false, since }, { uid: true });
    logger.info('Email trigger: search complete', { unseenCount: uids ? uids.length : 0 });
    if (!uids || uids.length === 0) return result;

    result.unseenCount = uids.length;

    // Fetch envelopes only first — no body download yet
    for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
      const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
      const messageId = msg.envelope?.messageId ?? null;

      if (cfg.authorizedSenders.length > 0 && !cfg.authorizedSenders.includes(from)) {
        logger.debug('Email trigger: ignoring unauthorized sender', { from });
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
        result.skipped++;
        continue;
      }

      if (messageId && isEmailAlreadyProcessed(messageId)) {
        logger.info('Email trigger: skipping already-processed message', { messageId });
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
        result.skipped++;
        continue;
      }

      // Passed all filters — now fetch the full source for this one message
      try {
        let source = null;
        for await (const full of client.fetch([msg.uid], { source: true }, { uid: true })) {
          source = full.source;
        }

        if (!source) {
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          result.skipped++;
          continue;
        }

        const parsed = await simpleParser(source);
        const title = (msg.envelope?.subject ?? 'New Vote').trim();
        const body = (parsed.text ?? '').trim();
        const deadlineDate = new Date(Date.now() + cfg.defaultDeadlineHours * 3_600_000);

        const motion = db.transaction(() => {
          const m = createMotionFromEmail({ title, description: body, deadlineDate });
          if (messageId) recordProcessedEmail(messageId, m.id);
          return m;
        })();

        const memberCount = issueTokensToCouncil(motion, baseUrl);

        logger.info('Vote created via email trigger', { motionId: motion.id, title, from, members: memberCount });
        result.processed++;
      } catch (err) {
        logger.error('Failed to process trigger email', { error: err.message, uid: msg.uid });
        result.errors++;
      }

      await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return result;
}

async function pollOnce(baseUrl) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`IMAP poll timed out after ${POLL_TIMEOUT_MS / 1000}s`)), POLL_TIMEOUT_MS)
  );
  return Promise.race([pollOnceInner(baseUrl), timeout]);
}

function startEmailTriggerPoller(baseUrl) {
  logger.info('Email trigger poller starting (reads IMAP config from DB on each cycle)');

  const run = () =>
    pollOnce(baseUrl).catch(err => logger.error('Email trigger poll error', { error: err.message }));

  // Schedule runs config on every tick so credentials saved via admin UI
  // take effect without a server restart
  const schedule = () => {
    const interval = getImapConfig().pollIntervalMs;
    setTimeout(() => run().then(schedule).catch(schedule), interval);
  };

  run().then(schedule).catch(schedule);
}

module.exports = { startEmailTriggerPoller, pollOnce };
