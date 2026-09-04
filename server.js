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

app.use('/api/auth',            require('./routes/auth'));
app.use('/api/auth/totp',       require('./routes/totp'));
app.use('/api/auth/webauthn',   require('./routes/webauthn'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/admin',      require('./routes/admin'));

// Register a new company + admin account
app.post('/api/companies/register', async (req, res) => {
  const { company_name, company_code, admin_name, admin_email, password, setup_key } = req.body || {};
  if (setup_key !== process.env.SETUP_KEY)
    return res.status(403).json({ error: 'Invalid setup key' });
  if (!company_name || !company_code || !admin_name || !admin_email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const code = company_code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 3) return res.status(400).json({ error: 'Company code must be at least 3 characters (letters/numbers only)' });

  try {
    const { rows: [company] } = await pool.query(
      "INSERT INTO companies (name, company_code) VALUES ($1, $2) RETURNING *",
      [company_name.trim(), code]
    );
    const hash = await bcrypt.hash(password, 12);
    const { rows: [u] } = await pool.query(
      "INSERT INTO users (name,email,password_hash,role,company_id) VALUES ($1,$2,$3,'admin',$4) RETURNING id,name,email,role",
      [admin_name.trim(), admin_email.toLowerCase().trim(), hash, company.id]
    );
    const token = generateToken({ sub: u.id, role: u.role, name: u.name, company_id: company.id });
    res.status(201).json({
      message: 'Company registered',
      company: { name: company.name, company_code: company.company_code },
      token, user: u,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Company code or email already in use' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// List all companies (setup_key protected — for account recovery)
app.post('/api/companies/list', async (req, res) => {
  const { setup_key } = req.body || {};
  if (setup_key !== process.env.SETUP_KEY)
    return res.status(403).json({ error: 'Invalid setup key' });
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.company_code, c.created_at,
              u.email AS admin_email, u.name AS admin_name
       FROM companies c
       LEFT JOIN users u ON u.company_id = c.id AND u.role = 'admin'
       ORDER BY c.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Reset admin password (setup_key protected)
app.post('/api/admin-reset', async (req, res) => {
  const { setup_key, company_code, new_password } = req.body || {};
  if (setup_key !== process.env.SETUP_KEY)
    return res.status(403).json({ error: 'Invalid setup key' });
  if (!company_code || !new_password || new_password.length < 6)
    return res.status(400).json({ error: 'company_code and new_password (min 6 chars) required' });
  try {
    const { rows: [company] } = await pool.query(
      "SELECT id FROM companies WHERE UPPER(company_code) = UPPER($1)", [company_code]
    );
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const hash = await bcrypt.hash(new_password, 12);
    const { rows } = await pool.query(
      "UPDATE users SET password_hash=$1 WHERE company_id=$2 AND role='admin' RETURNING name, email",
      [hash, company.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No admin found for this company' });
    res.json({ message: 'Password reset', admins: rows.map(u => ({ name: u.name, email: u.email })) });
  } catch (err) { res.status(500).json({ error: 'Reset failed' }); }
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
  require('./lib/migrate')().then(() => {
    app.listen(PORT, () => console.log(`Qsign on http://localhost:${PORT}`));
  }).catch(err => { console.error('Startup migration failed:', err); process.exit(1); });
}

module.exports = app;
