'use strict';
const path    = require('node:path');
const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('./lib/db');
const { generateToken } = require('./lib/auth');

const app = express();

app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.use('/api/auth',       require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/admin',      require('./routes/admin'));

// One-time first-admin setup (blocked once any admin exists)
app.post('/api/setup', async (req, res) => {
  const { name, email, password, setup_key } = req.body || {};
  if (setup_key !== process.env.SETUP_KEY)
    return res.status(403).json({ error: 'Invalid setup key' });
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'name, email, password (min 6 chars) required' });
  try {
    const { rows: [existing] } = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
    if (existing) return res.status(409).json({ error: 'Admin already exists — log in via /admin' });
    const hash = await bcrypt.hash(password, 12);
    const { rows: [u] } = await pool.query(
      "INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'admin') RETURNING id,name,email,role",
      [name.trim(), email.toLowerCase().trim(), hash]
    );
    const token = generateToken({ sub: u.id, role: u.role, name: u.name });
    res.status(201).json({ message: 'Admin account created', token, user: u });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Setup failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`WorkTrack on http://localhost:${PORT}`));
}

module.exports = app;
