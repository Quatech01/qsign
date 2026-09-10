'use strict';
const router = require('express').Router();
const pool   = require('../lib/db');

const KEY = process.env.SUPERADMIN_KEY;

// Brute-force guard
const _attempts = new Map();
function guardKey(req, res) {
  if (!KEY) { res.status(503).json({ error: 'SUPERADMIN_KEY not configured' }); return false; }
  const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'x';
  const now = Date.now();
  const rec = _attempts.get(ip) || { n: 0, until: 0 };
  if (rec.until > now) {
    const mins = Math.ceil((rec.until - now) / 60000);
    res.status(429).json({ error: `Too many attempts — try again in ${mins}m` });
    return false;
  }
  const provided = req.headers['x-superadmin-key'];
  if (provided !== KEY) {
    // Only count as a failed attempt when a non-empty key was deliberately sent
    if (provided) {
      rec.n += 1;
      if (rec.n >= 5) { rec.until = now + 15 * 60_000; rec.n = 0; }
      _attempts.set(ip, rec);
    }
    res.status(401).json({ error: 'Invalid key' });
    return false;
  }
  _attempts.delete(ip);
  return true;
}

// GET /api/superadmin/stats
router.get('/stats', async (req, res) => {
  if (!guardKey(req, res)) return;
  try {
    const [companies, users, attendance, liveNow] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM companies"),
      pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='worker'"),
      pool.query("SELECT COUNT(*)::int AS n FROM attendance"),
      pool.query("SELECT COUNT(*)::int AS n FROM attendance WHERE check_out_time IS NULL"),
    ]);
    res.json({
      totalCompanies:  companies.rows[0].n,
      totalWorkers:    users.rows[0].n,
      totalAttendance: attendance.rows[0].n,
      liveNow:         liveNow.rows[0].n,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/superadmin/companies
router.get('/companies', async (req, res) => {
  if (!guardKey(req, res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.company_code, c.pay_period, c.created_at,
             COUNT(DISTINCT u.id) FILTER (WHERE u.role='worker') ::int AS workers,
             COUNT(DISTINCT u.id) FILTER (WHERE u.role='admin')  ::int AS admins,
             MAX(u.email) FILTER (WHERE u.role='admin') AS admin_email,
             COUNT(DISTINCT a.id)::int AS total_shifts
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN attendance a ON a.user_id = u.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/superadmin/companies/:id
router.delete('/companies/:id', async (req, res) => {
  if (!guardKey(req, res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    // Cascade: attendance → users → work_locations → company
    await pool.query(`
      DELETE FROM attendance WHERE user_id IN (SELECT id FROM users WHERE company_id=$1)
    `, [id]);
    await pool.query('DELETE FROM users WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM work_locations WHERE company_id=$1', [id]);
    const { rowCount } = await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Company not found' });
    res.json({ message: 'Company deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Delete failed' }); }
});

// GET /api/superadmin/users
router.get('/users', async (req, res) => {
  if (!guardKey(req, res)) return;
  const { q, company_id, role } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const off   = (page - 1) * limit;

  const conds = [];
  const params = [];
  let p = 1;
  if (company_id) { conds.push(`u.company_id=$${p++}`); params.push(company_id); }
  if (role)       { conds.push(`u.role=$${p++}`);        params.push(role); }
  if (q)          { conds.push(`(u.name ILIKE $${p} OR u.email ILIKE $${p})`); params.push(`%${q}%`); p++; }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  try {
    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.department, u.active, u.created_at,
                c.name AS company_name, c.company_code
         FROM users u JOIN companies c ON c.id = u.company_id
         ${where} ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${off}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM users u JOIN companies c ON c.id = u.company_id ${where}`,
        params
      ),
    ]);
    res.json({ users: rows.rows, total: cnt.rows[0].n, page, pages: Math.ceil(cnt.rows[0].n / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/superadmin/users/:id  { active: true/false }
router.patch('/users/:id', async (req, res) => {
  if (!guardKey(req, res)) return;
  const { active } = req.body || {};
  if (active === undefined) return res.status(400).json({ error: 'active required' });
  try {
    const { rows: [u] } = await pool.query(
      'UPDATE users SET active=$1 WHERE id=$2 RETURNING id, name, email, active',
      [!!active, req.params.id]
    );
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json(u);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

// GET /api/superadmin/attendance
router.get('/attendance', async (req, res) => {
  if (!guardKey(req, res)) return;
  const { company_id, user_id, date_from, date_to, live } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const off   = (page - 1) * limit;

  const conds = [];
  const params = [];
  let p = 1;
  if (company_id) { conds.push(`u.company_id=$${p++}`);               params.push(company_id); }
  if (user_id)    { conds.push(`a.user_id=$${p++}`);                  params.push(user_id); }
  if (date_from)  { conds.push(`a.check_in_time::date>=$${p++}`);     params.push(date_from); }
  if (date_to)    { conds.push(`a.check_in_time::date<=$${p++}`);     params.push(date_to); }
  if (live === '1') conds.push('a.check_out_time IS NULL');

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  try {
    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT a.id, a.check_in_time, a.check_out_time, a.hours_worked,
                a.check_in_lat, a.check_in_lng,
                u.name AS worker_name, u.email AS worker_email,
                c.name AS company_name, c.company_code,
                wl.name AS location_name
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         JOIN companies c ON c.id = u.company_id
         LEFT JOIN work_locations wl ON wl.id = a.location_id
         ${where}
         ORDER BY a.check_in_time DESC
         LIMIT ${limit} OFFSET ${off}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         JOIN companies c ON c.id = u.company_id
         ${where}`,
        params
      ),
    ]);
    res.json({ records: rows.rows, total: cnt.rows[0].n, page, pages: Math.ceil(cnt.rows[0].n / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
