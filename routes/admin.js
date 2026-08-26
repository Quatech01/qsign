'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

// All routes require admin role
router.use(requireAdmin);

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [workers, liveRows, hoursRows] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='worker' AND active=TRUE"),
      pool.query("SELECT COUNT(*)::int AS n FROM attendance WHERE check_out_time IS NULL"),
      pool.query(`SELECT COALESCE(SUM(
          CASE WHEN check_out_time IS NOT NULL THEN hours_worked
               ELSE EXTRACT(EPOCH FROM (NOW()-check_in_time))/3600 END
        ),0)::numeric(8,2) AS total
        FROM attendance WHERE check_in_time::date = CURRENT_DATE`),
    ]);
    res.json({
      totalWorkers:  workers.rows[0].n,
      currentlyIn:   liveRows.rows[0].n,
      hoursToday:    Number(hoursRows.rows[0].total),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/live — who is currently clocked in
router.get('/live', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.check_in_time, a.check_in_lat, a.check_in_lng,
              wl.name AS location_name,
              u.id AS user_id, u.name, u.department
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN work_locations wl ON wl.id = a.location_id
       WHERE a.check_out_time IS NULL
       ORDER BY a.check_in_time`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/attendance?user_id=&date_from=&date_to=&page=1
router.get('/attendance', async (req, res) => {
  const { user_id, date_from, date_to } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 50;
  const off   = (page - 1) * limit;

  let where = ['1=1'];
  const params = [];
  let p = 1;
  if (user_id)   { where.push(`a.user_id=$${p++}`);               params.push(user_id); }
  if (date_from) { where.push(`a.check_in_time::date>=$${p++}`);  params.push(date_from); }
  if (date_to)   { where.push(`a.check_in_time::date<=$${p++}`);  params.push(date_to); }

  const w = where.join(' AND ');
  try {
    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT a.*, u.name AS worker_name, u.department, wl.name AS location_name,
                au.name AS edited_by_name
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN work_locations wl ON wl.id = a.location_id
         LEFT JOIN users au ON au.id = a.edited_by
         WHERE ${w} ORDER BY a.check_in_time DESC LIMIT ${limit} OFFSET ${off}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM attendance a WHERE ${w}`, params),
    ]);
    res.json({ records: rows.rows, total: cnt.rows[0].n, page, pages: Math.ceil(cnt.rows[0].n / limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/admin/attendance/:id  — edit times
router.put('/attendance/:id', async (req, res) => {
  const { check_in_time, check_out_time, edit_reason, notes } = req.body || {};
  if (!check_in_time) return res.status(400).json({ error: 'check_in_time is required' });
  if (!edit_reason)   return res.status(400).json({ error: 'Reason for edit is required' });

  try {
    const { rows: [existing] } = await pool.query("SELECT * FROM attendance WHERE id=$1", [req.params.id]);
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
  try {
    const { rowCount } = await pool.query("DELETE FROM attendance WHERE id=$1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Record not found' });
    res.json({ message: 'Record deleted' });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// GET /api/admin/workers
router.get('/workers', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id,name,email,role,department,phone,active,created_at FROM users ORDER BY name"
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/workers
router.post('/workers', async (req, res) => {
  const { name, email, password, role = 'worker', department, phone } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['worker','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (name,email,password_hash,role,department,phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,department,phone,active,created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, role, department || null, phone || null]
    );
    res.status(201).json(u);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/workers/:id
router.put('/workers/:id', async (req, res) => {
  const { name, email, department, phone, active, password } = req.body || {};
  try {
    let hash = null;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      hash = await bcrypt.hash(password, 12);
    }
    const { rows: [u] } = await pool.query(
      `UPDATE users SET
         name       = COALESCE($1, name),
         email      = COALESCE($2, email),
         department = COALESCE($3, department),
         phone      = COALESCE($4, phone),
         active     = COALESCE($5, active),
         password_hash = COALESCE($6, password_hash)
       WHERE id=$7 RETURNING id,name,email,role,department,phone,active`,
      [name||null, email||null, department||null, phone||null, active??null, hash, req.params.id]
    );
    if (!u) return res.status(404).json({ error: 'Worker not found' });
    res.json(u);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

// GET /api/admin/locations
router.get('/locations', async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM work_locations ORDER BY name");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/locations
router.post('/locations', async (req, res) => {
  const { name, address, lat, lng, radius_meters = 200 } = req.body || {};
  if (!name || lat == null || lng == null) return res.status(400).json({ error: 'name, lat, lng required' });
  try {
    const { rows: [loc] } = await pool.query(
      `INSERT INTO work_locations (name,address,lat,lng,radius_meters)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), address || null, lat, lng, radius_meters]
    );
    res.status(201).json(loc);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT /api/admin/locations/:id
router.put('/locations/:id', async (req, res) => {
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
       WHERE id=$7 RETURNING *`,
      [name||null, address||null, lat??null, lng??null, radius_meters??null, active??null, req.params.id]
    );
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json(loc);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

// GET /api/admin/reports?date_from=&date_to=
router.get('/reports', async (req, res) => {
  const { date_from, date_to } = req.query;
  const from = date_from || new Date(Date.now() - 7*864e5).toISOString().slice(0,10);
  const to   = date_to   || new Date().toISOString().slice(0,10);
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.department,
              COUNT(a.id)::int AS shifts,
              COALESCE(SUM(CASE WHEN a.check_out_time IS NOT NULL THEN a.hours_worked ELSE 0 END),0)::numeric(8,2) AS total_hours,
              COUNT(CASE WHEN a.check_out_time IS NULL THEN 1 END)::int AS open_shifts
       FROM users u
       LEFT JOIN attendance a ON a.user_id=u.id
         AND a.check_in_time::date BETWEEN $1 AND $2
       WHERE u.role='worker' AND u.active=TRUE
       GROUP BY u.id, u.name, u.department
       ORDER BY u.name`,
      [from, to]
    );
    res.json({ from, to, rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
