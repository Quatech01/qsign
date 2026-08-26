'use strict';
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function generateToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '12h' });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(h.slice(7), SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token expired — please log in again' }); }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

module.exports = { generateToken, requireAuth, requireAdmin };
