'use strict';
const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const speakeasy = require('speakeasy');
const pool      = require('../lib/db');
const { generateToken, requireAuth } = require('../lib/auth');

router.post('/login', async (req, res) => {
  const { company_code, email, staff_id, password, totp_code } = req.body || {};
  const identifier = (email || staff_id || '').trim();
  if (!company_code || !identifier || !password)
    return res.status(400).json({ error: 'Company code, email/staff ID, and password required' });

  try {
    const { rows: [company] } = await pool.query(
      "SELECT * FROM companies WHERE UPPER(company_code) = UPPER($1) AND active = TRUE",
      [company_code.trim()]
    );
    if (!company) return res.status(401).json({ error: 'Company not found — check your company code' });

    const { rows: [u] } = await pool.query(
      `SELECT * FROM users
       WHERE company_id = $1
         AND (LOWER(email) = LOWER($2) OR staff_id = $2)
         AND active = TRUE`,
      [company.id, identifier]
    );
    if (!u) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // 2FA check
    if (u.totp_enabled) {
      if (!totp_code) return res.status(200).json({ totp_required: true });
      const totpOk = speakeasy.totp.verify({
        secret: u.totp_secret, encoding: 'base32',
        token: String(totp_code).replace(/\s/g, ''), window: 1,
      });
      if (!totpOk) return res.status(401).json({ error: 'Invalid authenticator code' });
    }

    const token = generateToken({ sub: u.id, role: u.role, name: u.name, company_id: company.id });
    res.json({
      token,
      user: { id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, staff_id: u.staff_id },
      company: { name: company.name, company_code: company.company_code },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      "SELECT id,name,email,role,department,phone,staff_id FROM users WHERE id=$1 AND active=TRUE",
      [req.user.sub]
    );
    if (!u) return res.status(401).json({ error: 'User not found' });
    res.json(u);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
