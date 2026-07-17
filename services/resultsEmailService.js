const logger = require('../logger');
const { getMotionStats, motionQueries, ballotQueries, getSetting } = require('../db');

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

function buildResultsEmailContent({ motion, stats, closeReason, outcome, publicResultsUrl, propertyManagerName, voterStatus }) {
  const counts = {};
  for (const row of stats.results || []) {
    counts[row.choice] = row.count;
  }

  const yes = counts.Yes || counts.YES || 0;
  const no = counts.No || counts.NO || 0;
  const abstain = counts.Abstain || counts.ABSTAIN || 0;

  const subject = `Motion ${motion.motion_ref} results: ${String(outcome || 'UNKNOWN').toUpperCase()}`;

  const salutationName = propertyManagerName ? propertyManagerName : 'there';

  const voters = voterStatus || [];

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
    `Eligible: ${stats.eligible}`,
    `Cast: ${stats.voted}`,
    `Yes: ${yes}`,
    `No: ${no}`,
    `Abstain: ${abstain}`,
    `Outcome: ${outcome}`,
    '',
    'Votes:',
    ...(voters.length > 0
      ? voters.map(v => `${v.recipient_name || v.recipient_email || 'Unknown'}${v.unit_number ? ` (Unit ${v.unit_number})` : ''}: ${v.choice || 'Did not vote'}`)
      : ['No voter information available.']),
    '',
    `View results: ${publicResultsUrl}`,
    ''
  ].join('\n');

  const voterRows = voters.length > 0
    ? voters.map(v => `
      <tr>
        <td>${v.recipient_name || v.recipient_email || 'Unknown'}</td>
        <td>${v.unit_number || '-'}</td>
        <td>${v.choice || 'Did not vote'}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="3">No voter information available.</td></tr>';

  const html = `
    <p>Hello ${salutationName},</p>
    <p><strong>Motion:</strong> ${motion.motion_ref} - ${motion.title}</p>
    <p><strong>Description:</strong></p>
    <p>${(motion.description || '(none)').replace(/\n/g, '<br>')}</p>
    <p><strong>Close reason:</strong> ${closeReason}</p>
    <h3>Summary</h3>
    <ul>
      <li><strong>Eligible:</strong> ${stats.eligible}</li>
      <li><strong>Cast:</strong> ${stats.voted}</li>
      <li><strong>Yes:</strong> ${yes}</li>
      <li><strong>No:</strong> ${no}</li>
      <li><strong>Abstain:</strong> ${abstain}</li>
      <li><strong>Outcome:</strong> ${outcome}</li>
    </ul>
    <h3>Votes</h3>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
      <thead>
        <tr><th>Name</th><th>Unit</th><th>Vote</th></tr>
      </thead>
      <tbody>
        ${voterRows}
      </tbody>
    </table>
    <p><a href="${publicResultsUrl}">View results</a></p>
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
  const voterStatus = ballotQueries.getVoterStatusByMotion.all(motionId);

  const { name: propertyManagerName } = getPropertyManager();

  const content = buildResultsEmailContent({
    motion,
    stats,
    closeReason,
    outcome,
    publicResultsUrl,
    propertyManagerName,
    voterStatus
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
