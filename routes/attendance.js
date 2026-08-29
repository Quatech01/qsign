'use strict';
const router = require('express').Router();
const pool   = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { haversine } = require('../lib/geo');

// Get the location assigned to this worker
async function getWorkerLocation(userId) {
  const { rows: [user] } = await pool.query(
    `SELECT u.location_id, wl.name, wl.lat, wl.lng, wl.radius_meters, wl.active
     FROM users u LEFT JOIN work_locations wl ON wl.id = u.location_id
     WHERE u.id = $1`, [userId]
  );
  return user;
}

function geofenceCheck(lat, lng, location) {
  const dist = Math.round(haversine(lat, lng, Number(location.lat), Number(location.lng)));
  const within = dist <= location.radius_meters;
  return { within, distanceMeters: dist };
}

// POST /api/attendance/checkin  { lat, lng }
router.post('/checkin', requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'GPS coordinates required' });

  try {
    const { rows: open } = await pool.query(
      "SELECT id FROM attendance WHERE user_id=$1 AND check_out_time IS NULL", [req.user.sub]
    );
    if (open.length) return res.status(409).json({ error: 'Already clocked in — please clock out first' });

    const user = await getWorkerLocation(req.user.sub);
    if (!user.location_id) return res.status(400).json({ error: 'No location assigned — contact your admin' });
    if (!user.active) return res.status(403).json({ error: 'Your assigned location is inactive — contact your admin' });

    const { within, distanceMeters } = geofenceCheck(lat, lng, user);
    if (!within) {
      return res.status(403).json({
        error: `Outside your work location — you are ${distanceMeters}m from "${user.name}" (allowed within ${user.radius_meters}m)`,
        distanceMeters,
        locationName: user.name,
        radiusMeters: user.radius_meters,
      });
    }

    const { rows: [record] } = await pool.query(
      `INSERT INTO attendance (user_id, location_id, check_in_lat, check_in_lng)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.sub, user.location_id, lat, lng]
    );
    res.status(201).json({ message: 'Clocked in', record, locationName: user.name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Clock-in failed' }); }
});

// POST /api/attendance/checkout  { lat, lng }
router.post('/checkout', requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'GPS coordinates required' });

  try {
    const { rows: [open] } = await pool.query(
      "SELECT * FROM attendance WHERE user_id=$1 AND check_out_time IS NULL ORDER BY check_in_time DESC LIMIT 1",
      [req.user.sub]
    );
    if (!open) return res.status(409).json({ error: 'Not clocked in' });

    const user = await getWorkerLocation(req.user.sub);
    if (!user.location_id) return res.status(400).json({ error: 'No location assigned — contact your admin' });

    const { within, distanceMeters } = geofenceCheck(lat, lng, user);
    if (!within) {
      return res.status(403).json({
        error: `Outside your work location — you are ${distanceMeters}m from "${user.name}" (allowed within ${user.radius_meters}m)`,
        distanceMeters,
        locationName: user.name,
        radiusMeters: user.radius_meters,
      });
    }

    const now = new Date();
    const hoursWorked = ((now - new Date(open.check_in_time)) / 3600000).toFixed(2);

    const { rows: [record] } = await pool.query(
      `UPDATE attendance SET check_out_time=$1, check_out_lat=$2, check_out_lng=$3, hours_worked=$4
       WHERE id=$5 RETURNING *`,
      [now, lat, lng, hoursWorked, open.id]
    );
    res.json({ message: 'Clocked out', record, hoursWorked: Number(hoursWorked) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Clock-out failed' }); }
});

// GET /api/attendance/status — current open record or null
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows: [record] } = await pool.query(
      `SELECT a.*, wl.name AS location_name
       FROM attendance a LEFT JOIN work_locations wl ON a.location_id = wl.id
       WHERE a.user_id=$1 AND a.check_out_time IS NULL
       ORDER BY a.check_in_time DESC LIMIT 1`,
      [req.user.sub]
    );
    res.json({ clocked_in: !!record, record: record || null });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/attendance/today — today's summary
router.get('/today', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, wl.name AS location_name
       FROM attendance a LEFT JOIN work_locations wl ON a.location_id = wl.id
       WHERE a.user_id=$1 AND a.check_in_time::date = CURRENT_DATE
       ORDER BY a.check_in_time`,
      [req.user.sub]
    );
    const totalHours = rows.reduce((sum, r) => {
      if (r.check_out_time) return sum + Number(r.hours_worked || 0);
      // still clocked in — add partial time
      return sum + (Date.now() - new Date(r.check_in_time)) / 3600000;
    }, 0);
    res.json({ records: rows, totalHours: parseFloat(totalHours.toFixed(2)) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/attendance/history?page=1&limit=20
router.get('/history', requireAuth, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const off   = (page - 1) * limit;
  try {
    const { rows } = await pool.query(
      `SELECT a.*, wl.name AS location_name
       FROM attendance a LEFT JOIN work_locations wl ON a.location_id = wl.id
       WHERE a.user_id=$1
       ORDER BY a.check_in_time DESC LIMIT $2 OFFSET $3`,
      [req.user.sub, limit, off]
    );
    const { rows: [{ n }] } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM attendance WHERE user_id=$1", [req.user.sub]
    );
    res.json({ records: rows, total: n, page, pages: Math.ceil(n / limit) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
