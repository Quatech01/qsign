'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../lib/db');
const { sendMail } = require('../lib/mailer');

// In-memory code store: key = "companyId:email", value = { code, userId, exp }
const _codes = new Map();

function storeCode(key, val) {
  _codes.set(key, { ...val, exp: Date.now() + 15 * 60_000 });
  setTimeout(() => _codes.delete(key), 15 * 60_000 + 500);
}

function consumeCode(key) {
  const e = _codes.get(key);
  _codes.delete(key);
  return (e && e.exp > Date.now()) ? e : null;
}

// POST /api/auth/forgot
// Body: { company_code, email }
// Always returns the same message to prevent user enumeration.
router.post('/forgot', async (req, res) => {
  const { company_code, email } = req.body || {};
  const SAFE = { message: 'If that email is registered, a reset code has been sent. Check your inbox.' };

  if (!company_code || !email)
    return res.status(400).json({ error: 'Company code and email are required' });

  try {
    const { rows: [company] } = await pool.query(
      "SELECT id FROM companies WHERE UPPER(company_code) = UPPER($1) AND active = TRUE",
      [company_code.trim()]
    );
    if (!company) return res.json(SAFE);

    const { rows: [u] } = await pool.query(
      "SELECT id, name, email FROM users WHERE company_id=$1 AND LOWER(email)=LOWER($2) AND active=TRUE",
      [company.id, email.trim()]
    );
    if (!u) return res.json(SAFE);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    storeCode(`${company.id}:${u.email.toLowerCase()}`, { code, userId: u.id });

    // Respond immediately — don't make the user wait for SMTP
    res.json(SAFE);

    // Send email in background
    sendMail({
      to: u.email,
      subject: 'QSign — Password Reset Code',
      html: `
        <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-size:1.25rem;font-weight:800;color:#2563eb;letter-spacing:-.02em">QSign</span>
          </div>
          <h2 style="font-size:1.35rem;font-weight:700;color:#0f172a;margin:0 0 12px">Password Reset</h2>
          <p style="color:#374151;margin:0 0 8px">Hi <strong>${u.name}</strong>,</p>
          <p style="color:#374151;margin:0 0 24px">
            Use the code below to reset your QSign password.
            It expires in <strong>15 minutes</strong>.
          </p>
          <div style="text-align:center;margin:0 0 28px">
            <span style="display:inline-block;font-size:2.2rem;font-weight:800;letter-spacing:.25em;
                         background:#eff6ff;color:#1d4ed8;padding:16px 32px;border-radius:12px;
                         font-family:ui-monospace,monospace">${code}</span>
          </div>
          <p style="color:#6b7280;font-size:.85rem;margin:0">
            If you didn't request a password reset, you can safely ignore this email —
            your password will not change.
          </p>
        </div>`,
    }).catch(err => console.error('[reset] email send failed:', err));
  } catch (err) {
    console.error('[reset] forgot:', err);
    res.json(SAFE); // never leak errors
  }
});

// POST /api/auth/reset
// Body: { company_code, email, code, new_password }
router.post('/reset', async (req, res) => {
  const { company_code, email, code, new_password } = req.body || {};
  if (!company_code || !email || !code || !new_password)
    return res.status(400).json({ error: 'All fields are required' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const { rows: [company] } = await pool.query(
      "SELECT id FROM companies WHERE UPPER(company_code) = UPPER($1) AND active = TRUE",
      [company_code.trim()]
    );
    if (!company) return res.status(400).json({ error: 'Invalid or expired code' });

    const key = `${company.id}:${email.trim().toLowerCase()}`;
    const stored = consumeCode(key);
    if (!stored || stored.code !== String(code).replace(/\s/g, ''))
      return res.status(400).json({ error: 'Invalid or expired code — request a new one' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, stored.userId]);

    res.json({ message: 'Password updated — you can now sign in.' });
  } catch (err) {
    console.error('[reset] reset:', err);
    res.status(500).json({ error: 'Reset failed — please try again' });
  }
});

module.exports = router;
