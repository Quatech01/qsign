'use strict';
const jwt  = require('jsonwebtoken');
const pool = require('./db');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function generateToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '12h' });
}

// Single-device enforcement: token carries `sv` (session version).
// On every authenticated request, sv is compared against the DB.
// A new login increments the DB version, making all older tokens invalid.
async function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(h.slice(7), SECRET);
    if (payload.sv !== undefined) {
      const { rows: [u] } = await pool.query(
        'SELECT session_ver FROM users WHERE id=$1 AND active=TRUE', [payload.sub]
      );
      if (!u || u.session_ver !== payload.sv) {
        return res.status(401).json({
          error: 'Signed in on another device — please sign in again',
          code: 'SESSION_DISPLACED',
        });
      }
    }
    req.user = payload;
    next();
  } catch {
    if (!res.headersSent) res.status(401).json({ error: 'Token expired — please log in again' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

module.exports = { generateToken, requireAuth, requireAdmin };
