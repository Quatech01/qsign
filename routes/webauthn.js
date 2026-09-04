'use strict';
const router = require('express').Router();
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const pool = require('../lib/db');
const { generateToken, requireAuth } = require('../lib/auth');

const RP_NAME = 'QSign';
const RP_ID   = process.env.WEBAUTHN_RP_ID  || 'localhost';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';

// In-memory challenge store — fine for a single Render instance
const _ch = new Map();
function storeChallenge(key, val) {
  _ch.set(key, { val, exp: Date.now() + 90_000 });
  setTimeout(() => _ch.delete(key), 91_000);
}
function consumeChallenge(key) {
  const e = _ch.get(key); _ch.delete(key);
  return (e && e.exp > Date.now()) ? e.val : null;
}

// ── Registration (requires login) ─────────────────────────────────────────────

router.post('/register/options', requireAuth, async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      'SELECT id, name, email FROM users WHERE id=$1 AND active=TRUE', [req.user.sub]
    );
    if (!u) return res.status(401).json({ error: 'User not found' });

    const { rows: existing } = await pool.query(
      'SELECT credential_id FROM webauthn_credentials WHERE user_id=$1', [u.id]
    );

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(String(u.id)),
      userName: u.email,
      userDisplayName: u.name,
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({
        id: Buffer.from(c.credential_id, 'base64url'),
        type: 'public-key',
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    storeChallenge(`reg:${u.id}`, options.challenge);
    res.json(options);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to generate options' }); }
});

router.post('/register/verify', requireAuth, async (req, res) => {
  try {
    const challenge = consumeChallenge(`reg:${req.user.sub}`);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired — start over' });

    const { deviceName, ...body } = req.body;

    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo)
      return res.status(400).json({ error: 'Fingerprint verification failed' });

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

    await pool.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (credential_id) DO UPDATE SET counter=$4, name=$5`,
      [
        req.user.sub,
        Buffer.from(credentialID).toString('base64url'),
        Buffer.from(credentialPublicKey).toString('base64'),
        counter,
        (deviceName || 'My device').slice(0, 80),
      ]
    );

    res.json({ message: 'Fingerprint registered' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Registration failed' }); }
});

// ── Authentication (public) ───────────────────────────────────────────────────

router.post('/login/options', async (_req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: [], // discoverable — browser shows which account to use
    });

    const key = `auth:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    storeChallenge(key, options.challenge);
    res.json({ ...options, _ck: key });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to generate options' }); }
});

router.post('/login/verify', async (req, res) => {
  try {
    const { _ck, ...body } = req.body;
    const challenge = consumeChallenge(_ck);
    if (!challenge) return res.status(400).json({ error: 'Challenge expired — try again' });

    const { rows: [cred] } = await pool.query(
      `SELECT wc.*, u.id AS uid, u.name AS uname, u.email, u.role, u.company_id, u.active
       FROM webauthn_credentials wc
       JOIN users u ON u.id = wc.user_id
       WHERE wc.credential_id = $1`,
      [body.id]
    );
    if (!cred || !cred.active) return res.status(401).json({ error: 'Unknown credential' });

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: Buffer.from(cred.credential_id, 'base64url'),
        credentialPublicKey: Buffer.from(cred.public_key, 'base64'),
        counter: Number(cred.counter),
      },
      requireUserVerification: true,
    });

    if (!verification.verified) return res.status(401).json({ error: 'Fingerprint not recognised' });

    await pool.query(
      'UPDATE webauthn_credentials SET counter=$1 WHERE id=$2',
      [verification.authenticationInfo.newCounter, cred.id]
    );

    const { rows: [company] } = await pool.query(
      'SELECT name, company_code FROM companies WHERE id=$1', [cred.company_id]
    );

    const token = generateToken({
      sub: cred.uid, role: cred.role, name: cred.uname, company_id: cred.company_id,
    });

    res.json({
      token,
      user: { id: cred.uid, name: cred.uname, email: cred.email, role: cred.role },
      company: company || {},
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Fingerprint login failed' }); }
});

// ── Device management ─────────────────────────────────────────────────────────

router.get('/devices', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, created_at FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.sub]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/devices/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.sub]
    );
    if (!rowCount) return res.status(404).json({ error: 'Device not found' });
    res.json({ message: 'Device removed' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
