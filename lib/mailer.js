'use strict';
const nodemailer = require('nodemailer');

let _transport;

function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) === 465 : true, // 465=SSL, 587=STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transport;
}

// Call once at startup to confirm SMTP credentials work
async function verifySmtp() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mailer] ⚠ SMTP_USER/SMTP_PASS not set — password reset emails will not be sent');
    return;
  }
  try {
    await getTransport().verify();
    console.log('[mailer] ✓ SMTP connection verified —', process.env.SMTP_USER);
  } catch (err) {
    console.error('[mailer] ✗ SMTP connection FAILED:', err.message);
    console.error('[mailer]   Check SMTP_USER, SMTP_PASS, and that Gmail App Password is correct');
    _transport = null; // reset so next sendMail retries
  }
}

async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mailer] No SMTP credentials — skipping email to', to);
    return;
  }
  try {
    const from = `QSign <${process.env.SMTP_FROM || process.env.SMTP_USER}>`;
    const info = await getTransport().sendMail({ from, to, subject, html });
    console.log('[mailer] ✓ Email sent to', to, '—', info.messageId);
  } catch (err) {
    console.error('[mailer] ✗ Failed to send email to', to, ':', err.message);
    throw err;
  }
}

module.exports = { sendMail, verifySmtp };
