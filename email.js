const nodemailer = require('nodemailer');
const logger = require('./logger');

// Check if email is configured
function isEmailConfigured() {
  const password = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    password
  );
}

async function sendGenericEmail({ to, subject, text, html }) {
  if (!isEmailConfigured()) {
    logger.info('Email not configured, skipping email send');
    throw new Error('Email not configured');
  }

  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('Failed to create email transporter');
  }

  const recipients = Array.isArray(to) ? to : [to];
  const filtered = recipients.map(r => (r || '').trim()).filter(Boolean);
  if (filtered.length === 0) {
    throw new Error('No recipients provided');
  }

  const fromName = process.env.SMTP_FROM_NAME || 'Strata Council';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const from = process.env.SMTP_FROM || `"${fromName}" <${fromEmail}>`;

  await transporter.sendMail({
    from,
    to: filtered.join(', '),
    subject,
    text,
    html
  });
}

// Create transporter (lazy initialization)
let transporter = null;
function getTransporter() {
  if (!isEmailConfigured()) {
    return null;
  }

  const password = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: password
      }
    });
  }

  return transporter;
}

// Generate HTML email template
function generateHtmlEmail(recipientName, votingLink, motion) {
  const name = recipientName || 'Strata Council Member';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      border-bottom: 3px solid #007bff;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    h1 {
      color: #007bff;
      margin: 0;
      font-size: 24px;
    }
    .motion-title {
      font-size: 18px;
      font-weight: 600;
      color: #333;
      margin: 20px 0 10px 0;
    }
    .motion-description {
      background-color: #f8f9fa;
      padding: 15px;
      border-left: 4px solid #007bff;
      margin: 15px 0;
      color: #555;
    }
    .button {
      display: inline-block;
      background-color: #007bff;
      color: #ffffff !important;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 5px;
      font-weight: 600;
      margin: 20px 0;
      text-align: center;
    }
    .button:hover {
      background-color: #0056b3;
    }
    .link-box {
      background-color: #f8f9fa;
      padding: 15px;
      border-radius: 5px;
      margin: 20px 0;
      word-break: break-all;
      font-family: monospace;
      font-size: 12px;
      color: #666;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      font-size: 12px;
      color: #777;
    }
    .warning {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 12px;
      margin: 15px 0;
      color: #856404;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🗳️ Your Voting Link</h1>
    </div>

    <p>Hello ${name},</p>

    <p>You have been invited to vote on the following motion:</p>

    <div class="motion-title">${motion.title}</div>

    <div class="motion-description">
      ${motion.description.replace(/\n/g, '<br>')}
    </div>

    <p><strong>Click the button below to cast your vote:</strong></p>

    <a href="${votingLink}" class="button">Vote Now</a>

    <div class="warning">
      ⚠️ <strong>Important:</strong> This voting link can only be used once. Once you submit your vote, the link will be deactivated.
    </div>

    <p>If the button doesn't work, copy and paste this link into your browser:</p>
    <div class="link-box">${votingLink}</div>

    <div class="footer">
      <p>This is an automated message from your Strata Council voting system. Please do not reply to this email.</p>
      <p>If you have questions about this vote, please contact your strata council directly.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

// Generate plain text email template
function generatePlainTextEmail(recipientName, votingLink, motion) {
  const name = recipientName || 'Strata Council Member';

  return `
Hello ${name},

You have been invited to vote on the following motion:

MOTION: ${motion.title}

${motion.description}

==========================================
VOTE NOW: ${votingLink}
==========================================

IMPORTANT: This voting link can only be used once. Once you submit your vote, the link will be deactivated.

If you have questions about this vote, please contact your strata council directly.

---
This is an automated message from your Strata Council voting system.
  `.trim();
}

/**
 * Send voting link email to a recipient
 * @param {string} recipientName - Name of the recipient
 * @param {string} recipientEmail - Email address of the recipient
 * @param {string} votingLink - Full URL to the voting page
 * @param {object} motion - Motion object with title and description
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendVotingLink(recipientName, recipientEmail, votingLink, motion) {
  // Check if email is configured
  if (!isEmailConfigured()) {
    logger.info('Email not configured, skipping email send');
    return { success: false, error: 'Email not configured' };
  }

  // Validate email address
  if (!recipientEmail || !recipientEmail.includes('@')) {
    logger.warn(`Invalid email address: ${recipientEmail}`);
    return { success: false, error: 'Invalid email address' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { success: false, error: 'Failed to create email transporter' };
  }

  try {
    const fromName = process.env.SMTP_FROM_NAME || 'Strata Council';
    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: recipientEmail,
      subject: `Vote Required: ${motion.title}`,
      text: generatePlainTextEmail(recipientName, votingLink, motion),
      html: generateHtmlEmail(recipientName, votingLink, motion)
    };

    await transporter.sendMail(mailOptions);

    logger.info('Voting email sent successfully', {
      recipient: recipientEmail,
      motionId: motion.id,
      motionTitle: motion.title
    });

    return { success: true };
  } catch (error) {
    logger.error('Failed to send voting email', {
      recipient: recipientEmail,
      error: error.message,
      motionId: motion.id
    });

    return { success: false, error: error.message };
  }
}

// Test email configuration
async function testEmailConfig() {
  if (!isEmailConfigured()) {
    return { success: false, error: 'Email environment variables not configured' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { success: false, error: 'Failed to create email transporter' };
  }

  try {
    // Verify connection configuration
    await transporter.verify();
    return { success: true };
  } catch (error) {
    logger.error('Email configuration test failed', { error: error.message });
    
    // Provide more helpful error messages
    let helpfulError = error.message;
    if (error.message.includes('535')) {
      helpfulError = 'Authentication failed. Check SMTP_USER and SMTP_PASSWORD. For Gmail, use an App Password.';
    } else if (error.message.includes('ENOTFOUND')) {
      helpfulError = `SMTP host not found: ${process.env.SMTP_HOST}`;
    } else if (error.message.includes('ECONNREFUSED')) {
      helpfulError = `Connection refused. Check SMTP_PORT: ${process.env.SMTP_PORT || '587'}`;
    }
    
    return { success: false, error: helpfulError };
  }
}

module.exports = {
  isEmailConfigured,
  sendVotingLink,
  testEmailConfig,
  sendGenericEmail
};
