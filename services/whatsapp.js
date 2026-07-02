'use strict';

const logger = require('../logger');
const { getSetting } = require('../db');

function getConfig() {
  return {
    openwaUrl: getSetting('openwa_url') || process.env.OPENWA_URL || '',
    openwaApiKey: getSetting('openwa_api_key') || process.env.OPENWA_API_KEY || '',
    openwaSessionId: getSetting('openwa_session_id') || process.env.OPENWA_SESSION_ID || ''
  };
}

function toChatId(phone) {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

async function sendVotingLink({ to, token, motionTitle, baseUrl }) {
  const cfg = getConfig();

  if (!cfg.openwaUrl || !cfg.openwaApiKey || !cfg.openwaSessionId) {
    logger.warn('WhatsApp: sendVotingLink called but OpenWA is not configured', {
      hasUrl: !!cfg.openwaUrl,
      hasApiKey: !!cfg.openwaApiKey,
      hasSessionId: !!cfg.openwaSessionId,
      to
    });
    return;
  }

  const chatId = toChatId(to);
  const link = `${baseUrl.replace(/\/$/, '')}/vote/${token}`;
  const text = `New vote: ${motionTitle}\n\nYou are invited to cast your vote. Tap the link below:\n\n${link}`;
  const url = `${cfg.openwaUrl.replace(/\/$/, '')}/api/sessions/${cfg.openwaSessionId}/messages/send-text`;

  logger.info('WhatsApp: sending voting link', {
    to,
    chatId,
    motionTitle,
    url: url.replace(cfg.openwaApiKey, '[REDACTED]')
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.openwaApiKey}`
      },
      body: JSON.stringify({ chatId, text })
    });
  } catch (err) {
    logger.error('WhatsApp: HTTP request failed (network error)', {
      to,
      chatId,
      motionTitle,
      error: err.message
    });
    throw err;
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    logger.error('WhatsApp: OpenWA returned error response', {
      to,
      chatId,
      motionTitle,
      status: response.status,
      body
    });
    throw new Error(`OpenWA ${response.status}: ${body}`);
  }

  logger.info('WhatsApp: voting link sent successfully', {
    to,
    chatId,
    motionTitle,
    status: response.status
  });
}

module.exports = { sendVotingLink };
