'use strict';
const pool = require('./db');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'worker',
      department    TEXT,
      phone         TEXT,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS work_locations (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      address        TEXT,
      lat            NUMERIC(11,7) NOT NULL,
      lng            NUMERIC(11,7) NOT NULL,
      radius_meters  INTEGER NOT NULL DEFAULT 200,
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      location_id     INTEGER REFERENCES work_locations(id),
      check_in_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      check_out_time  TIMESTAMPTZ,
      check_in_lat    NUMERIC(11,7),
      check_in_lng    NUMERIC(11,7),
      check_out_lat   NUMERIC(11,7),
      check_out_lng   NUMERIC(11,7),
      hours_worked    NUMERIC(6,2),
      notes           TEXT,
      edited_by       INTEGER REFERENCES users(id),
      edited_at       TIMESTAMPTZ,
      edit_reason     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_att_user    ON attendance(user_id);
    CREATE INDEX IF NOT EXISTS idx_att_checkin ON attendance(check_in_time);
    CREATE INDEX IF NOT EXISTS idx_att_open    ON attendance(user_id) WHERE check_out_time IS NULL;
  `);

  // Add location_id to users if not already present (safe to run multiple times)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES work_locations(id) ON DELETE SET NULL;
  `);
  console.log('Migration complete');
  await pool.end();
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
