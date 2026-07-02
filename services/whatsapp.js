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
  return `${phone.replace(/\D/g, '')}@c.us`;
}

async function sendVotingLink({ to, token, motionTitle, baseUrl }) {
  const cfg = getConfig();
  if (!cfg.openwaUrl || !cfg.openwaApiKey || !cfg.openwaSessionId) return;

  const link = `${baseUrl.replace(/\/$/, '')}/vote/${token}`;
  const chatId = toChatId(to);
  const text = `New vote: ${motionTitle}\n\nYou are invited to cast your vote. Tap the link below:\n\n${link}`;

  const url = `${cfg.openwaUrl.replace(/\/$/, '')}/api/sessions/${cfg.openwaSessionId}/messages/send-text`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.openwaApiKey}`
    },
    body: JSON.stringify({ chatId, text })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenWA ${response.status}: ${body}`);
  }

  logger.debug({ chatId, motionTitle }, 'WhatsApp voting link sent');
}

module.exports = { sendVotingLink };
