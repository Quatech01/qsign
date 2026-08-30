'use strict';
const pool = require('./db');

async function migrate(standalone = false) {
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

  // Add location_id to users if not already present
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES work_locations(id) ON DELETE SET NULL;
  `);

  // Multi-tenancy: companies table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      company_code TEXT UNIQUE NOT NULL,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Add company_id and staff_id to users; company_id to locations
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_id TEXT;
    ALTER TABLE work_locations ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
  `);

  // Unique staff_id per company (allows NULL)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_staff_company
    ON users(company_id, staff_id) WHERE staff_id IS NOT NULL;
  `);

  // Weekly hours target per worker
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_hours NUMERIC(5,2);
  `);

  // Seed a default company and assign any orphaned existing rows to it
  await pool.query(`
    INSERT INTO companies (name, company_code)
    VALUES ('My Company', 'DEFAULT')
    ON CONFLICT (company_code) DO NOTHING;

    UPDATE users SET company_id = (SELECT id FROM companies WHERE company_code = 'DEFAULT')
    WHERE company_id IS NULL;

    UPDATE work_locations SET company_id = (SELECT id FROM companies WHERE company_code = 'DEFAULT')
    WHERE company_id IS NULL;
  `);

  console.log('Migration complete');
  if (standalone) await pool.end();
}

if (require.main === module) {
  migrate(true).catch(err => { console.error('Migration failed:', err); process.exit(1); });
}

module.exports = migrate;
