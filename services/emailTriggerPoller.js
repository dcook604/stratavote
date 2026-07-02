'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const logger = require('../logger');
const { getSetting, db, generateUUID, generateMotionRef, councilQueries, motionQueries, tokenQueries, enqueueTokenEmail } = require('../db');
const { isEmailConfigured, sendVotingLink } = require('../email');
const { sendVotingLink: sendWhatsApp } = require('./whatsapp');
const { processPendingTokenEmails } = require('./notificationWorker');

function getImapConfig() {
  return {
    user: getSetting('imap_user') || process.env.IMAP_USER || '',
    password: getSetting('imap_password') || process.env.IMAP_PASSWORD || '',
    host: getSetting('imap_host') || process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(getSetting('imap_port') || process.env.IMAP_PORT || '993', 10),
    authorizedSenders: (getSetting('imap_authorized_senders') || process.env.IMAP_AUTHORIZED_SENDERS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    pollIntervalMs: parseInt(getSetting('imap_poll_interval_ms') || process.env.IMAP_POLL_INTERVAL_MS || '60000', 10),
    defaultDeadlineHours: parseInt(getSetting('imap_default_deadline_hours') || process.env.IMAP_DEFAULT_DEADLINE_HOURS || '48', 10)
  };
}

async function createMotionFromEmail({ title, description, deadlineDate }) {
  const motionId = generateUUID();
  const motionRef = generateMotionRef();
  const now = new Date().toISOString();
  const openAt = now;
  const closeAt = deadlineDate.toISOString();

  motionQueries.create.run(
    motionId,
    motionRef,
    title,
    description || title,
    JSON.stringify(['Yes', 'No', 'Abstain']),
    openAt,
    closeAt,
    'Open',
    'Simple',
    now
  );

  return { id: motionId, title, description, open_at: openAt, close_at: closeAt };
}

async function issueTokensToCouncil(motion, baseUrl) {
  const members = councilQueries.getAll.get ? [councilQueries.getAll.get()] : councilQueries.getAll.all();
  // councilQueries.getAll returns all rows
  const allMembers = db.prepare('SELECT * FROM council_members ORDER BY name ASC').all();

  const emailConfigured = isEmailConfigured();
  const tokenIds = [];

  for (const member of allMembers) {
    const { name, email, whatsapp } = member;
    if (!email) continue;

    // Skip duplicates
    const existing = tokenQueries.getActiveByMotionEmail.get(motion.id, email);
    if (existing) continue;

    const token = crypto.randomBytes(24).toString('base64url');
    const now = new Date().toISOString();

    let result;
    try {
      result = tokenQueries.create.run(
        motion.id,
        token,
        name,
        email,
        member.unit_number,
        'Active',
        now,
        0,
        null,
        null
      );
    } catch (e) {
      if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
      throw e;
    }

    if (emailConfigured && email) {
      enqueueTokenEmail(result.lastInsertRowid);
      tokenIds.push(result.lastInsertRowid);
    }

    // Best-effort WhatsApp
    if (whatsapp) {
      sendWhatsApp({ to: whatsapp, token, motionTitle: motion.title, baseUrl }).catch(err => {
        logger.warn({ err, phone: whatsapp }, 'WhatsApp send failed; email was sent');
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

async function pollOnce(baseUrl) {
  const cfg = getImapConfig();
  if (!cfg.user || !cfg.password) return;

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const uids = await client.search({ seen: false });
    if (!uids || !Array.isArray(uids) || uids.length === 0) return;

    for await (const msg of client.fetch(uids, { envelope: true, source: true })) {
      const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';

      if (cfg.authorizedSenders.length > 0 && !cfg.authorizedSenders.includes(from)) {
        logger.debug({ from }, 'Email trigger: ignoring unauthorized sender');
        await client.messageFlagsAdd(String(msg.uid), ['\\Seen'], { uid: true });
        continue;
      }

      try {
        const source = msg.source;
        if (!source) {
          await client.messageFlagsAdd(String(msg.uid), ['\\Seen'], { uid: true });
          continue;
        }

        const parsed = await simpleParser(source);
        const title = (msg.envelope?.subject ?? 'New Vote').trim();
        const body = (parsed.text ?? '').trim();
        const deadlineDate = new Date(Date.now() + cfg.defaultDeadlineHours * 3_600_000);

        const motion = await createMotionFromEmail({ title, description: body, deadlineDate });
        const memberCount = await issueTokensToCouncil(motion, baseUrl);

        logger.info(
          { motionId: motion.id, title, from, members: memberCount },
          'Vote created via email trigger'
        );
      } catch (err) {
        logger.error({ err, uid: msg.uid }, 'Failed to process trigger email');
      }

      await client.messageFlagsAdd(String(msg.uid), ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

function startEmailTriggerPoller(baseUrl) {
  const cfg = getImapConfig();
  if (!cfg.user || !cfg.password) {
    logger.info('Email trigger poller disabled (IMAP credentials not configured)');
    return;
  }

  logger.info('Email trigger poller started');

  const run = () =>
    pollOnce(baseUrl).catch(err => logger.error({ err }, 'Email trigger poll error'));

  run();

  const schedule = () => {
    const interval = getImapConfig().pollIntervalMs;
    setTimeout(() => {
      run().then(schedule).catch(schedule);
    }, interval);
  };

  schedule();
}

module.exports = { startEmailTriggerPoller };
