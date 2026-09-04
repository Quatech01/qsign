'use strict';
const router    = require('express').Router();
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const pool      = require('../lib/db');
const { requireAuth } = require('../lib/auth');

// Generate a new TOTP secret and return setup QR
router.post('/setup', requireAuth, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT name, email FROM users WHERE id=$1 AND active=TRUE', [req.user.sub]
    );
    if (!u) return res.status(401).json({ error: 'User not found' });

    const secret = speakeasy.generateSecret({ length: 20 });
    const otpauth = speakeasy.otpauthURL({
      secret: secret.base32,
      label:  encodeURIComponent(`QSign:${u.email}`),
      issuer: 'QSign',
      encoding: 'base32',
    });

    // Store secret temporarily (not enabled yet)
    await pool.query(
      'UPDATE users SET totp_secret=$1, totp_enabled=FALSE WHERE id=$2',
      [secret.base32, req.user.sub]
    );

    const qrDataUri = await QRCode.toDataURL(otpauth);
    res.json({ secret: secret.base32, otpauth, qr: qrDataUri });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Setup failed' }); }
});

// Confirm the code and enable 2FA
router.post('/enable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const { rows: [u] } = await pool.query(
      'SELECT totp_secret FROM users WHERE id=$1 AND active=TRUE', [req.user.sub]
    );
    if (!u?.totp_secret) return res.status(400).json({ error: 'Run setup first' });

    const ok = speakeasy.totp.verify({
      secret: u.totp_secret, encoding: 'base32',
      token: code.replace(/\s/g, ''), window: 1,
    });
    if (!ok) return res.status(401).json({ error: 'Invalid code — try again' });

    await pool.query('UPDATE users SET totp_enabled=TRUE WHERE id=$1', [req.user.sub]);
    res.json({ message: '2FA enabled' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Enable failed' }); }
});

// Disable 2FA (requires current TOTP code)
router.post('/disable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const { rows: [u] } = await pool.query(
      'SELECT totp_secret, totp_enabled FROM users WHERE id=$1 AND active=TRUE', [req.user.sub]
    );
    if (!u?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });

    const ok = speakeasy.totp.verify({
      secret: u.totp_secret, encoding: 'base32',
      token: code.replace(/\s/g, ''), window: 1,
    });
    if (!ok) return res.status(401).json({ error: 'Invalid code' });

    await pool.query(
      'UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=$1', [req.user.sub]
    );
    res.json({ message: '2FA disabled' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Disable failed' }); }
});

// Get current 2FA status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT totp_enabled FROM users WHERE id=$1 AND active=TRUE', [req.user.sub]
    );
    res.json({ totp_enabled: u?.totp_enabled ?? false });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
