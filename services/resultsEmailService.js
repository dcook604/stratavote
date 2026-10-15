const logger = require('../logger');
const { getMotionStats, motionQueries, ballotQueries, getSetting } = require('../db');
const { escapeHtml } = require('../email');

function isResultsEmailsEnabled() {
  // Enabled by default; set RESULTS_EMAILS_ENABLED=false to disable the automatic worker.
  return process.env.RESULTS_EMAILS_ENABLED !== 'false';
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
  const ballots = ballotQueries.getByMotion.all(motionId);
  const participantEmails = ballots
    .map(b => b.recipient_email)
    .filter(Boolean);

  const { email: pmEmail } = getPropertyManager();

  return {
    participantEmails: uniqEmails(participantEmails),
    propertyManagerEmail: normalizeEmail(pmEmail)
  };
}

function buildResultsEmailContent({ motion, stats, closeReason, outcome, publicResultsUrl, propertyManagerName }) {
  const subject = `Motion ${motion.motion_ref} results: ${String(outcome || 'UNKNOWN').toUpperCase()}`;

  const salutationName = propertyManagerName ? propertyManagerName : 'there';

  // Aggregate breakdown, driven by the motion's actual options so custom choices
  // are reported correctly rather than being forced into Yes/No/Abstain.
  const breakdown = (stats.results || []).map(r => ({ choice: r.choice, count: r.count }));

  const text = [
    `Hello ${salutationName},`,
    '',
    `Motion: ${motion.motion_ref} - ${motion.title}`,
    '',
    'Description:',
    motion.description || '(none)',
    '',
    `Close reason: ${closeReason}`,
    '',
    'Summary:',
    `  Eligible: ${stats.eligible}`,
    `  Cast: ${stats.voted}`,
    ...(breakdown.length > 0
      ? breakdown.map(r => `  ${r.choice}: ${r.count}`)
      : ['  No votes cast']),
    `  Outcome: ${outcome}`,
    '',
    // Individual ballots are deliberately not included: this message goes to
    // every participant at once.
    'Individual votes are not listed. Aggregate results are available at the link below.',
    '',
    `View results: ${publicResultsUrl}`,
    ''
  ].join('\n');

  const breakdownItems = breakdown.length > 0
    ? breakdown.map(r => `<li><strong>${escapeHtml(r.choice)}:</strong> ${r.count}</li>`).join('\n      ')
    : '<li>No votes cast</li>';

  const html = `
    <p>Hello ${escapeHtml(salutationName)},</p>
    <p><strong>Motion:</strong> ${escapeHtml(motion.motion_ref)} - ${escapeHtml(motion.title)}</p>
    <p><strong>Description:</strong></p>
    <p>${escapeHtml(motion.description || '(none)').replace(/\n/g, '<br>')}</p>
    <p><strong>Close reason:</strong> ${escapeHtml(closeReason)}</p>
    <h3>Summary</h3>
    <ul>
      <li><strong>Eligible:</strong> ${stats.eligible}</li>
      <li><strong>Cast:</strong> ${stats.voted}</li>
      ${breakdownItems}
      <li><strong>Outcome:</strong> ${escapeHtml(outcome)}</li>
    </ul>
    <p style="color:#666;font-size:13px;">Individual votes are not listed. Aggregate results are available at the link below.</p>
    <p><a href="${escapeHtml(publicResultsUrl)}">View results</a></p>
  `.trim();

  return { subject, text, html };
}

async function sendResultsEmailForMotion({ motionId, baseUrl, sendMailFn, force = false }) {
  if (!force && !isResultsEmailsEnabled()) {
    logger.warn('results email skipped: RESULTS_EMAILS_ENABLED=false', { motionId });
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
    logger.warn('results email skipped: no recipients', { motionId, motionRef: motion.motion_ref });
    return { sent: false, skipped: true, reason: 'no_recipients' };
  }

  const stats = getMotionStats(motionId);
  const closeReason = getMotionCloseReason(motion);
  const outcome = computeOutcomeFromResults(motion, stats);
  const publicResultsUrl = `${baseUrl}/results/${motionId}`;

  const { name: propertyManagerName } = getPropertyManager();

  const content = buildResultsEmailContent({
    motion,
    stats,
    closeReason,
    outcome,
    publicResultsUrl,
    propertyManagerName
  });

  // bcc: every participant is a recipient, so nobody should see the others'
  // addresses in the To header.
  await sendMailFn({
    to: recipients,
    bcc: true,
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
