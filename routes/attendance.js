'use strict';
const router = require('express').Router();
const pool   = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { findNearestLocation } = require('../lib/geo');

// Fetch active locations once per request (small dataset)
async function getLocations() {
  const { rows } = await pool.query("SELECT * FROM work_locations WHERE active=TRUE");
  return rows;
}

// POST /api/attendance/checkin  { lat, lng }
router.post('/checkin', requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'GPS coordinates required' });

  try {
    // Block if already clocked in
    const { rows: open } = await pool.query(
      "SELECT id FROM attendance WHERE user_id=$1 AND check_out_time IS NULL", [req.user.sub]
    );
    if (open.length) return res.status(409).json({ error: 'Already clocked in — please clock out first' });

    // Geofence check
    const locations = await getLocations();
    if (!locations.length) return res.status(400).json({ error: 'No work location configured — contact your admin' });

    const { location, within, distanceMeters } = findNearestLocation(lat, lng, locations);
    if (!within) {
      return res.status(403).json({
        error: `Outside work location — you are ${distanceMeters}m from "${location.name}" (max ${location.radius_meters}m)`,
        distanceMeters,
        locationName: location.name,
        radiusMeters: location.radius_meters,
      });
    }

    const { rows: [record] } = await pool.query(
      `INSERT INTO attendance (user_id, location_id, check_in_lat, check_in_lng)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.sub, location.id, lat, lng]
    );
    res.status(201).json({ message: 'Clocked in', record, locationName: location.name });
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

    // Geofence check
    const locations = await getLocations();
    const { location, within, distanceMeters } = findNearestLocation(lat, lng, locations);
    if (!within) {
      return res.status(403).json({
        error: `Outside work location — you are ${distanceMeters}m from "${location.name}" (max ${location.radius_meters}m)`,
        distanceMeters,
        locationName: location.name,
        radiusMeters: location.radius_meters,
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
