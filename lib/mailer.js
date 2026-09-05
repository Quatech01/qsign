'use strict';

// Uses Resend (HTTPS API — no SMTP port issues on Render).
// Set RESEND_API_KEY in Render environment variables.
// Get a free key at resend.com — 3,000 emails/month free.

async function sendMail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[mailer] ⚠  RESEND_API_KEY not set — email not sent to', to);
    return;
  }

  const from = process.env.RESEND_FROM || 'QSign <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('[mailer] ✗ Resend error:', JSON.stringify(data));
    throw new Error(data.message || 'Email send failed');
  }
  console.log('[mailer] ✓ Email sent to', to, '| id:', data.id);
}

async function verifySmtp() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[mailer] ⚠  RESEND_API_KEY not set — password reset emails will NOT work');
    console.warn('[mailer]    Get a free key at https://resend.com and add RESEND_API_KEY to Render env vars');
    return;
  }
  console.log('[mailer] ✓ Resend API key found — emails enabled');
}

module.exports = { sendMail, verifySmtp };
