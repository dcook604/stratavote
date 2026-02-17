const logger = require('../logger');
const { getMotionStats, motionQueries, tokenQueries, getSetting } = require('../db');

function isResultsEmailsEnabled() {
  return process.env.RESULTS_EMAILS_ENABLED === 'true';
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function uniqEmails(emails) {
  const set = new Set();
  const out = [];
  for (const email of emails) {
    const norm = normalizeEmail(email);
    if (!norm) continue;
    if (set.has(norm)) continue;
    set.add(norm);
    out.push(norm);
  }
  return out;
}

function getPropertyManager() {
  return {
    name: getSetting('property_manager_name'),
    email: getSetting('property_manager_email')
  };
}

function getMotionCloseReason(motion) {
  // Placeholder until early-pass logic is implemented.
  // We infer close reason based on status; scheduler/early-pass will set this later.
  return motion.status === 'Closed' || motion.status === 'Published'
    ? 'Voting period ended'
    : 'Vote completed';
}

function computeOutcomeFromResults(motion, stats) {
  // If admin has explicitly set an outcome, use it.
  if (motion.outcome) return motion.outcome;

  const counts = {};
  for (const row of stats.results || []) {
    counts[row.choice] = row.count;
  }

  const yes = counts.Yes || counts.YES || 0;
  const no = counts.No || counts.NO || 0;

  if (yes === no) return 'Tie';

  const total = yes + no;
  if (total === 0) return 'Failed';

  const ratio = yes / total;
  if (motion.required_majority === 'TwoThirds') {
    return ratio >= (2 / 3) ? 'Passed' : 'Failed';
  }

  return ratio > 0.5 ? 'Passed' : 'Failed';
}

function buildRecipientsForMotion(motionId) {
  const tokens = tokenQueries.getByMotion.all(motionId);
  const participantEmails = tokens
    .map(t => t.recipient_email)
    .filter(Boolean);

  const { email: pmEmail } = getPropertyManager();

  return {
    participantEmails: uniqEmails(participantEmails),
    propertyManagerEmail: normalizeEmail(pmEmail)
  };
}

function buildResultsEmailContent({ motion, stats, closeReason, outcome, adminResultsUrl, propertyManagerName }) {
  const counts = {};
  for (const row of stats.results || []) {
    counts[row.choice] = row.count;
  }

  const yes = counts.Yes || counts.YES || 0;
  const no = counts.No || counts.NO || 0;
  const abstain = counts.Abstain || counts.ABSTAIN || 0;

  const subject = `Motion ${motion.motion_ref} results: ${String(outcome || 'UNKNOWN').toUpperCase()}`;

  const salutationName = propertyManagerName ? propertyManagerName : 'there';

  const text = [
    `Hello ${salutationName},`,
    '',
    `Motion: ${motion.motion_ref} - ${motion.title}`,
    `Close reason: ${closeReason}`,
    '',
    'Summary:',
    `Eligible: ${stats.eligible}`,
    `Cast: ${stats.voted}`,
    `Yes: ${yes}`,
    `No: ${no}`,
    `Abstain: ${abstain}`,
    '',
    `Outcome: ${outcome}`,
    '',
    `Admin results: ${adminResultsUrl}`,
    ''
  ].join('\n');

  const html = `
    <p>Hello ${salutationName},</p>
    <p><strong>Motion:</strong> ${motion.motion_ref} - ${motion.title}</p>
    <p><strong>Close reason:</strong> ${closeReason}</p>
    <h3>Summary</h3>
    <ul>
      <li><strong>Eligible:</strong> ${stats.eligible}</li>
      <li><strong>Cast:</strong> ${stats.voted}</li>
      <li><strong>Yes:</strong> ${yes}</li>
      <li><strong>No:</strong> ${no}</li>
      <li><strong>Abstain:</strong> ${abstain}</li>
    </ul>
    <p><strong>Outcome:</strong> ${outcome}</p>
    <p><a href="${adminResultsUrl}">View results in admin</a></p>
  `.trim();

  return { subject, text, html };
}

async function sendResultsEmailForMotion({ motionId, baseUrl, sendMailFn }) {
  if (!isResultsEmailsEnabled()) {
    return { sent: false, skipped: true, reason: 'results_emails_disabled' };
  }

  const motion = motionQueries.getById.get(motionId);
  if (!motion) {
    return { sent: false, skipped: true, reason: 'motion_not_found' };
  }

  const { propertyManagerEmail, participantEmails } = buildRecipientsForMotion(motionId);
  if (!propertyManagerEmail) {
    logger.warn('results email skipped: property manager email not configured', {
      motionId,
      motionRef: motion.motion_ref
    });
    return { sent: false, skipped: true, reason: 'property_manager_email_missing' };
  }

  const recipients = uniqEmails([...participantEmails, propertyManagerEmail]);
  if (recipients.length === 0) {
    return { sent: false, skipped: true, reason: 'no_recipients' };
  }

  const stats = getMotionStats(motionId);
  const closeReason = getMotionCloseReason(motion);
  const outcome = computeOutcomeFromResults(motion, stats);
  const adminResultsUrl = `${baseUrl}/admin/motions/${motionId}`;

  const { name: propertyManagerName } = getPropertyManager();

  const content = buildResultsEmailContent({
    motion,
    stats,
    closeReason,
    outcome,
    adminResultsUrl,
    propertyManagerName
  });

  await sendMailFn({
    to: recipients,
    subject: content.subject,
    text: content.text,
    html: content.html
  });

  logger.info('results email sent', {
    motionId,
    motionRef: motion.motion_ref,
    recipientCount: recipients.length
  });

  return { sent: true, skipped: false, recipientCount: recipients.length };
}

module.exports = {
  sendResultsEmailForMotion,
  buildRecipientsForMotion,
  getPropertyManager
};
