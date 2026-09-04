'use strict';
const nodemailer = require('nodemailer');

let _transport;
function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transport;
}

async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[mailer] SMTP_USER/SMTP_PASS not set — email not sent to', to);
    console.warn('[mailer] Subject:', subject);
    return;
  }
  const from = `QSign <${process.env.SMTP_FROM || process.env.SMTP_USER}>`;
  await getTransport().sendMail({ from, to, subject, html });
}

module.exports = { sendMail };
