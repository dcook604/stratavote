'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const logger = require('../logger');
const { getSetting, db, generateUUID, generateMotionRef, motionQueries, tokenQueries, enqueueTokenEmail } = require('../db');
const { isEmailConfigured } = require('../email');
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
        logger.warn({ err, phone: whatsapp }, 'WhatsApp send failed');
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

  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock('INBOX');
  } catch (err) {
    logger.error({ err }, 'Email trigger: IMAP connect/lock failed');
    await client.logout().catch(() => {});
    return;
  }

  try {
    // Use UIDs throughout so sequence-number shifts don't cause mismatches
    const uids = await client.search({ seen: false }, { uid: true });
    if (!uids || uids.length === 0) return;

    for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
      const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? '';

      if (cfg.authorizedSenders.length > 0 && !cfg.authorizedSenders.includes(from)) {
        logger.debug({ from }, 'Email trigger: ignoring unauthorized sender');
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
        continue;
      }

      try {
        const source = msg.source;
        if (!source) {
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          continue;
        }

        const parsed = await simpleParser(source);
        const title = (msg.envelope?.subject ?? 'New Vote').trim();
        const body = (parsed.text ?? '').trim();
        const deadlineDate = new Date(Date.now() + cfg.defaultDeadlineHours * 3_600_000);

        const motion = createMotionFromEmail({ title, description: body, deadlineDate });
        const memberCount = issueTokensToCouncil(motion, baseUrl);

        logger.info({ motionId: motion.id, title, from, members: memberCount }, 'Vote created via email trigger');
      } catch (err) {
        logger.error({ err, uid: msg.uid }, 'Failed to process trigger email');
      }

      await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

function startEmailTriggerPoller(baseUrl) {
  logger.info('Email trigger poller starting (reads IMAP config from DB on each cycle)');

  const run = () =>
    pollOnce(baseUrl).catch(err => logger.error({ err }, 'Email trigger poll error'));

  // Schedule runs config on every tick so credentials saved via admin UI
  // take effect without a server restart
  const schedule = () => {
    const interval = getImapConfig().pollIntervalMs;
    setTimeout(() => run().then(schedule).catch(schedule), interval);
  };

  run().then(schedule).catch(schedule);
}

module.exports = { startEmailTriggerPoller };
