'use strict';
const path    = require('node:path');
const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('./lib/db');
const { generateToken } = require('./lib/auth');
const { sendMail }      = require('./lib/mailer');

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
app.use('/api/auth',            require('./routes/reset'));
app.use('/api/auth/totp',       require('./routes/totp'));
app.use('/api/auth/webauthn',   require('./routes/webauthn'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/admin',      require('./routes/admin'));

// ── Public self-service signup ────────────────────────────────────────────────
// Simple in-memory rate limiter: max 5 signups per IP per hour
const _signupRateMap = new Map();
function signupRateOk(ip) {
  const now = Date.now();
  const key  = ip || 'unknown';
  const hits  = (_signupRateMap.get(key) || []).filter(t => now - t < 3_600_000);
  if (hits.length >= 5) return false;
  hits.push(now);
  _signupRateMap.set(key, hits);
  return true;
}

app.post('/api/companies/signup', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
  if (!signupRateOk(ip))
    return res.status(429).json({ error: 'Too many sign-ups from this network — try again in an hour' });

  const { company_name, company_code, admin_name, admin_email, password } = req.body || {};
  if (!company_name || !company_code || !admin_name || !admin_email || !password)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(admin_email.trim()))
    return res.status(400).json({ error: 'Enter a valid email address' });

  const code = company_code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 3 || code.length > 12)
    return res.status(400).json({ error: 'Company code must be 3–12 letters/numbers' });

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
      token,
      user: u,
      company: { name: company.name, company_code: company.company_code },
    });

    // Welcome email (background — don't block response)
    sendMail({
      to: u.email,
      subject: `Welcome to QSign — your company is live`,
      html: `
        <div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:20px">
            <span style="font-size:1.25rem;font-weight:800;color:#2563eb;letter-spacing:-.02em">QSign</span>
          </div>
          <h2 style="font-size:1.3rem;font-weight:700;color:#0f172a;margin:0 0 8px">Welcome, ${u.name}! 🎉</h2>
          <p style="color:#374151;margin:0 0 20px">Your company <strong>${company.name}</strong> is live on QSign. Here's everything you need to get started.</p>

          <div style="background:#eff6ff;border-radius:12px;padding:16px 20px;margin-bottom:24px">
            <div style="font-size:.8rem;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Your company code</div>
            <div style="font-size:2rem;font-weight:800;color:#1d4ed8;font-family:ui-monospace,monospace;letter-spacing:.1em">${company.company_code}</div>
            <div style="font-size:.8rem;color:#3b82f6;margin-top:4px">Share this with your workers so they can sign in at qsign.uk</div>
          </div>

          <div style="font-weight:700;color:#0f172a;margin-bottom:12px">Your next 3 steps:</div>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;vertical-align:top;width:28px"><span style="display:inline-block;width:22px;height:22px;background:#2563eb;color:#fff;border-radius:50%;text-align:center;font-size:.75rem;font-weight:700;line-height:22px">1</span></td>
                <td style="padding:8px 0"><strong>Add a work location</strong><br><span style="color:#6b7280;font-size:.875rem">Set the GPS location where your workers clock in from.</span></td></tr>
            <tr><td style="padding:8px 0;vertical-align:top"><span style="display:inline-block;width:22px;height:22px;background:#2563eb;color:#fff;border-radius:50%;text-align:center;font-size:.75rem;font-weight:700;line-height:22px">2</span></td>
                <td style="padding:8px 0"><strong>Add your workers</strong><br><span style="color:#6b7280;font-size:.875rem">Create an account for each team member.</span></td></tr>
            <tr><td style="padding:8px 0;vertical-align:top"><span style="display:inline-block;width:22px;height:22px;background:#2563eb;color:#fff;border-radius:50%;text-align:center;font-size:.75rem;font-weight:700;line-height:22px">3</span></td>
                <td style="padding:8px 0"><strong>Share your company code</strong><br><span style="color:#6b7280;font-size:.875rem">Workers go to qsign.uk, enter <strong>${company.company_code}</strong> and sign in.</span></td></tr>
          </table>

          <div style="margin-top:28px">
            <a href="https://www.qsign.uk/admin.html" style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 28px;border-radius:10px;text-decoration:none;font-size:.95rem">Go to admin dashboard →</a>
          </div>
          <p style="color:#9ca3af;font-size:.78rem;margin-top:24px">You're receiving this because you signed up at qsign.uk.</p>
        </div>`,
    }).catch(err => console.error('[signup] welcome email failed:', err));

  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That company code or email is already registered' });
    console.error(err);
    res.status(500).json({ error: 'Sign-up failed — please try again' });
  }
});

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

app.get('/signup', (_, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));

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
  require('./lib/migrate')().then(async () => {
    app.listen(PORT, () => console.log(`Qsign on http://localhost:${PORT}`));
    await require('./lib/mailer').verifySmtp();
  }).catch(err => { console.error('Startup migration failed:', err); process.exit(1); });
}

module.exports = app;
