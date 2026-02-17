const logger = require('../logger');
const {
  getPendingNotifications,
  markNotificationSent,
  markNotificationFailed,
  ensureResultsEmailNotification,
  motionQueries,
  getMotionStats,
  db
} = require('../db');
const { sendResultsEmailForMotion } = require('./resultsEmailService');
const { sendGenericEmail } = require('../email');

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function computeBackoffMinutes(attempts) {
  if (attempts <= 0) return 1;
  if (attempts === 1) return 1;
  if (attempts === 2) return 5;
  if (attempts === 3) return 15;
  if (attempts === 4) return 30;
  return 60;
}

function getCount(stats, label) {
  const target = String(label).toLowerCase();
  for (const row of stats.results || []) {
    if (String(row.choice).toLowerCase() === target) return row.count;
  }
  return 0;
}

function evaluateEarlyCompletion(motion, stats) {
  const eligible = stats.eligible || 0;
  const voted = stats.voted || 0;
  const remaining = stats.remaining || 0;

  if (eligible <= 0) return { complete: false };
  if (voted <= 0) return { complete: false };

  const yes = getCount(stats, 'Yes');
  const no = getCount(stats, 'No');

  if (motion.required_majority === 'TwoThirds') {
    const threshold = Math.ceil((eligible * 2) / 3);
    if (yes >= threshold) {
      return { complete: true, outcome: 'Passed', reason: 'early_threshold_passed' };
    }

    // Can't reach threshold anymore
    if (yes + remaining < threshold) {
      return { complete: true, outcome: 'Failed', reason: 'early_threshold_failed' };
    }

    return { complete: false };
  }

  // Simple majority
  const threshold = Math.floor(eligible / 2) + 1;
  if (yes >= threshold) {
    return { complete: true, outcome: 'Passed', reason: 'early_threshold_passed' };
  }
  if (no >= threshold) {
    return { complete: true, outcome: 'Failed', reason: 'early_threshold_failed' };
  }

  return { complete: false };
}

function closeMotionIfEligible(motion, now) {
  if (!motion) return { changed: false };

  if (motion.status !== 'Open') return { changed: false };

  const closeAt = new Date(motion.close_at);
  const stats = getMotionStats(motion.id);

  const closeByTime = now >= closeAt;
  const closeByAllVoted = stats.remaining <= 0 && stats.eligible > 0;

  const early = evaluateEarlyCompletion(motion, stats);
  const closeByEarlyOutcome = !!early.complete;

  if (!closeByTime && !closeByAllVoted && !closeByEarlyOutcome) return { changed: false };

  motionQueries.updateStatus.run('Closed', motion.id);

  const reason = closeByEarlyOutcome ? early.reason : (closeByAllVoted ? 'all_votes_cast' : 'end_time_reached');
  logger.info('motion completed', {
    motionId: motion.id,
    motionRef: motion.motion_ref,
    reason
  });

  ensureResultsEmailNotification(motion.id);
  logger.info('notification queued', { motionId: motion.id, motionRef: motion.motion_ref });

  return { changed: true, reason };
}

function sweepAndEnqueueCompletedMotions() {
  const now = new Date();

  const openMotions = db.prepare("SELECT * FROM motions WHERE status = 'Open'").all();
  for (const motion of openMotions) {
    try {
      db.transaction(() => {
        closeMotionIfEligible(motion, now);
      })();
    } catch (err) {
      logger.error('motion completion sweep failed', {
        motionId: motion.id,
        motionRef: motion.motion_ref,
        error: err.message
      });
    }
  }

  // Ensure outbox row exists for already-closed motions (idempotent)
  const closedMotions = db.prepare("SELECT id, motion_ref FROM motions WHERE status IN ('Closed', 'Published')").all();
  for (const motion of closedMotions) {
    try {
      ensureResultsEmailNotification(motion.id);
    } catch (err) {
      logger.error('ensure notification failed', {
        motionId: motion.id,
        motionRef: motion.motion_ref,
        error: err.message
      });
    }
  }
}

async function processPendingResultsEmails({ baseUrl, limit = 25 } = {}) {
  const nowIso = new Date().toISOString();
  const pending = getPendingNotifications(nowIso, limit);

  for (const notif of pending) {
    try {
      const result = await sendResultsEmailForMotion({
        motionId: notif.motion_id,
        baseUrl,
        sendMailFn: sendGenericEmail
      });

      if (result.sent) {
        markNotificationSent(notif.id);
        continue;
      }

      // Skipped/failed -> keep retry path
      const nextMinutes = computeBackoffMinutes((notif.attempts || 0) + 1);
      const nextAttemptAtIso = addMinutes(new Date(), nextMinutes).toISOString();
      markNotificationFailed(
        notif.id,
        (notif.attempts || 0) + 1,
        nextAttemptAtIso,
        result.reason || 'skipped'
      );

      logger.warn('results email failed or skipped', {
        motionId: notif.motion_id,
        notificationId: notif.id,
        reason: result.reason,
        nextAttemptAt: nextAttemptAtIso
      });
    } catch (err) {
      const nextMinutes = computeBackoffMinutes((notif.attempts || 0) + 1);
      const nextAttemptAtIso = addMinutes(new Date(), nextMinutes).toISOString();
      markNotificationFailed(
        notif.id,
        (notif.attempts || 0) + 1,
        nextAttemptAtIso,
        err.message
      );

      logger.error('email failed', {
        motionId: notif.motion_id,
        notificationId: notif.id,
        error: err.message
      });
    }
  }
}

module.exports = {
  sweepAndEnqueueCompletedMotions,
  processPendingResultsEmails
};
