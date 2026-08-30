'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

router.use(requireAdmin);

// GET /api/admin/company
router.get('/company', async (req, res) => {
  try {
    const { rows: [c] } = await pool.query(
      "SELECT id, name, company_code, created_at FROM companies WHERE id = $1",
      [req.user.company_id]
    );
    if (!c) return res.status(404).json({ error: 'Company not found' });
    res.json(c);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/admin/company
router.put('/company', async (req, res) => {
  const { name, company_code } = req.body || {};
  try {
    const { rows: [c] } = await pool.query(
      `UPDATE companies SET
         name         = COALESCE($1, name),
         company_code = COALESCE($2, company_code)
       WHERE id = $3 RETURNING id, name, company_code`,
      [name || null, company_code ? company_code.toUpperCase().replace(/[^A-Z0-9]/g, '') : null, req.user.company_id]
    );
    res.json(c);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Company code already in use' });
    res.status(500).json({ error: 'Update failed' });
  }
});

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  const cid = req.user.company_id;
  try {
    const [workers, liveRows, hoursRows] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='worker' AND active=TRUE AND company_id=$1", [cid]),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM attendance a
         JOIN users u ON u.id = a.user_id
         WHERE a.check_out_time IS NULL AND u.company_id = $1`, [cid]
      ),
      pool.query(
        `SELECT COALESCE(SUM(
            CASE WHEN a.check_out_time IS NOT NULL THEN a.hours_worked
                 ELSE EXTRACT(EPOCH FROM (NOW()-a.check_in_time))/3600 END
          ),0)::numeric(8,2) AS total
          FROM attendance a JOIN users u ON u.id = a.user_id
          WHERE a.check_in_time::date = CURRENT_DATE AND u.company_id = $1`, [cid]
      ),
    ]);
    res.json({
      totalWorkers: workers.rows[0].n,
      currentlyIn:  liveRows.rows[0].n,
      hoursToday:   Number(hoursRows.rows[0].total),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/live
router.get('/live', async (req, res) => {
  const cid = req.user.company_id;
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.check_in_time, a.check_in_lat, a.check_in_lng,
              wl.name AS location_name,
              u.id AS user_id, u.name, u.department, u.staff_id
       FROM attendance a
       JOIN users u ON u.id = a.user_id AND u.company_id = $1
       LEFT JOIN work_locations wl ON wl.id = a.location_id
       WHERE a.check_out_time IS NULL
       ORDER BY a.check_in_time`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/attendance
router.get('/attendance', async (req, res) => {
  const cid = req.user.company_id;
  const { user_id, date_from, date_to } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const off   = (page - 1) * limit;

  let where = ['u.company_id=$1'];
  const params = [cid];
  let p = 2;
  if (user_id)   { where.push(`a.user_id=$${p++}`);               params.push(user_id); }
  if (date_from) { where.push(`a.check_in_time::date>=$${p++}`);  params.push(date_from); }
  if (date_to)   { where.push(`a.check_in_time::date<=$${p++}`);  params.push(date_to); }

  const w = where.join(' AND ');
  try {
    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT a.*, u.name AS worker_name, u.department, u.staff_id, wl.name AS location_name,
                au.name AS edited_by_name
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN work_locations wl ON wl.id = a.location_id
         LEFT JOIN users au ON au.id = a.edited_by
         WHERE ${w} ORDER BY a.check_in_time DESC LIMIT ${limit} OFFSET ${off}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM attendance a JOIN users u ON u.id = a.user_id WHERE ${w}`,
        params
      ),
    ]);
    res.json({ records: rows.rows, total: cnt.rows[0].n, page, pages: Math.ceil(cnt.rows[0].n / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/admin/attendance/:id
router.put('/attendance/:id', async (req, res) => {
  const cid = req.user.company_id;
  const { check_in_time, check_out_time, edit_reason, notes } = req.body || {};
  if (!check_in_time) return res.status(400).json({ error: 'check_in_time is required' });
  if (!edit_reason)   return res.status(400).json({ error: 'Reason for edit is required' });

  try {
    const { rows: [existing] } = await pool.query(
      `SELECT a.* FROM attendance a JOIN users u ON u.id = a.user_id
       WHERE a.id=$1 AND u.company_id=$2`, [req.params.id, cid]
    );
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    let hoursWorked = null;
    if (check_out_time) {
      hoursWorked = ((new Date(check_out_time) - new Date(check_in_time)) / 3600000).toFixed(2);
      if (hoursWorked < 0) return res.status(400).json({ error: 'Check-out time must be after check-in time' });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE attendance SET
         check_in_time  = $1,
         check_out_time = $2,
         hours_worked   = $3,
         notes          = COALESCE($4, notes),
         edited_by      = $5,
         edited_at      = NOW(),
         edit_reason    = $6
       WHERE id=$7 RETURNING *`,
      [check_in_time, check_out_time || null, hoursWorked, notes, req.user.sub, edit_reason, req.params.id]
    );
    res.json({ message: 'Record updated', record: updated });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

// DELETE /api/admin/attendance/:id
router.delete('/attendance/:id', async (req, res) => {
  const cid = req.user.company_id;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM attendance a USING users u
       WHERE a.id=$1 AND a.user_id=u.id AND u.company_id=$2`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ error: 'Record not found' });
    res.json({ message: 'Record deleted' });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// GET /api/admin/workers
router.get('/workers', async (req, res) => {
  const cid = req.user.company_id;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.department, u.phone, u.active, u.created_at,
              u.staff_id, u.location_id, wl.name AS location_name
       FROM users u LEFT JOIN work_locations wl ON wl.id = u.location_id
       WHERE u.company_id = $1
       ORDER BY u.name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/workers
router.post('/workers', async (req, res) => {
  const cid = req.user.company_id;
  const { name, email, password, role = 'worker', department, phone, location_id, staff_id } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['worker', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name,email,password_hash,role,department,phone,location_id,company_id,staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,name,email,role,department,phone,active,location_id,staff_id,created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, role,
       department || null, phone || null, location_id || null, cid, staff_id || null]
    );
    res.status(201).json(u);
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint?.includes('staff')) return res.status(409).json({ error: 'Staff ID already in use' });
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/workers/:id
router.put('/workers/:id', async (req, res) => {
  const cid = req.user.company_id;
  const { name, email, department, phone, active, password, location_id, staff_id } = req.body || {};
  try {
    let hash = null;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      hash = await bcrypt.hash(password, 12);
    }
    const { rows: [u] } = await pool.query(
      `UPDATE users SET
         name          = COALESCE($1, name),
         email         = COALESCE($2, email),
         department    = COALESCE($3, department),
         phone         = COALESCE($4, phone),
         active        = COALESCE($5, active),
         password_hash = COALESCE($6, password_hash),
         location_id   = $7,
         staff_id      = $8
       WHERE id=$9 AND company_id=$10
       RETURNING id,name,email,role,department,phone,active,location_id,staff_id`,
      [name || null, email || null, department || null, phone || null,
       active ?? null, hash, location_id || null, staff_id || null, req.params.id, cid]
    );
    if (!u) return res.status(404).json({ error: 'Worker not found' });
    res.json(u);
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint?.includes('staff')) return res.status(409).json({ error: 'Staff ID already in use' });
    }
    console.error(err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/admin/workers/:id
router.delete('/workers/:id', async (req, res) => {
  const cid = req.user.company_id;
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM users WHERE id=$1 AND company_id=$2 AND role='worker'",
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ error: 'Worker not found' });
    res.json({ message: 'Worker deleted' });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// GET /api/admin/locations
router.get('/locations', async (req, res) => {
  const cid = req.user.company_id;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM work_locations WHERE company_id=$1 ORDER BY name", [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/locations
router.post('/locations', async (req, res) => {
  const cid = req.user.company_id;
  const { name, address, lat, lng, radius_meters = 200 } = req.body || {};
  if (!name || lat == null || lng == null) return res.status(400).json({ error: 'name, lat, lng required' });
  try {
    const { rows: [loc] } = await pool.query(
      `INSERT INTO work_locations (name,address,lat,lng,radius_meters,company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), address || null, lat, lng, radius_meters, cid]
    );
    res.status(201).json(loc);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/admin/locations/:id
router.put('/locations/:id', async (req, res) => {
  const cid = req.user.company_id;
  const { name, address, lat, lng, radius_meters, active } = req.body || {};
  try {
    const { rows: [loc] } = await pool.query(
      `UPDATE work_locations SET
         name          = COALESCE($1, name),
         address       = COALESCE($2, address),
         lat           = COALESCE($3, lat),
         lng           = COALESCE($4, lng),
         radius_meters = COALESCE($5, radius_meters),
         active        = COALESCE($6, active)
       WHERE id=$7 AND company_id=$8 RETURNING *`,
      [name || null, address || null, lat ?? null, lng ?? null,
       radius_meters ?? null, active ?? null, req.params.id, cid]
    );
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json(loc);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

// GET /api/admin/reports
router.get('/reports', async (req, res) => {
  const cid = req.user.company_id;
  const { date_from, date_to } = req.query;
  const from = date_from || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const to   = date_to   || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.department, u.staff_id,
              COUNT(a.id)::int AS shifts,
              COALESCE(SUM(CASE WHEN a.check_out_time IS NOT NULL THEN a.hours_worked ELSE 0 END),0)::numeric(8,2) AS total_hours,
              COUNT(CASE WHEN a.check_out_time IS NULL THEN 1 END)::int AS open_shifts
       FROM users u
       LEFT JOIN attendance a ON a.user_id=u.id
         AND a.check_in_time::date BETWEEN $1 AND $2
       WHERE u.role='worker' AND u.active=TRUE AND u.company_id=$3
       GROUP BY u.id, u.name, u.department, u.staff_id
       ORDER BY u.name`,
      [from, to, cid]
    );
    res.json({ from, to, rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
