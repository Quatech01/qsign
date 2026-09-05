'use strict';
const nodemailer = require('nodemailer');

let _transport;

function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    service: 'gmail', // nodemailer knows Gmail's SMTP settings automatically
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS, // must be a Gmail App Password (16 chars, no spaces)
    },
  });
  return _transport;
}

async function verifySmtp() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mailer] ⚠  SMTP_USER / SMTP_PASS not set — reset emails will not be sent');
    return;
  }
  try {
    await getTransport().verify();
    console.log('[mailer] ✓ Gmail SMTP ready —', process.env.SMTP_USER);
  } catch (err) {
    console.error('[mailer] ✗ Gmail SMTP FAILED:', err.message);
    console.error('[mailer]   → Make sure SMTP_PASS is a Gmail App Password (not your account password)');
    console.error('[mailer]   → Get one at: myaccount.google.com → Security → App passwords');
    _transport = null;
  }
}

async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mailer] No credentials — skipping email to', to);
    return;
  }
  const from = `QSign <${process.env.SMTP_USER}>`;
  const info = await getTransport().sendMail({ from, to, subject, html });
  console.log('[mailer] ✓ Sent to', to, info.messageId);
}

module.exports = { sendMail, verifySmtp };
