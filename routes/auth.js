'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../lib/db');
const { generateToken, requireAuth } = require('../lib/auth');

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows: [u] } = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND active = TRUE", [email.toLowerCase().trim()]
    );
    if (!u) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = generateToken({ sub: u.id, role: u.role, name: u.name });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, department: u.department } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      "SELECT id,name,email,role,department,phone FROM users WHERE id=$1 AND active=TRUE", [req.user.sub]
    );
    if (!u) return res.status(401).json({ error: 'User not found' });
    res.json(u);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
