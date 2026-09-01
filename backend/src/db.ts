import pg, { type PoolClient } from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;
export const db = new Pool({
  host: config.postgresHost,
  port: config.postgresPort,
  database: config.postgresDatabase,
  user: config.postgresUser,
  password: config.postgresPassword,
});
db.on('connect', () => logger.debug({ event: 'database_connection_opened' }, 'PostgreSQL connection opened'));
db.on('remove', () => logger.debug({ event: 'database_connection_closed' }, 'PostgreSQL connection closed'));
db.on('error', (error) => logger.error({ event: 'database_pool_error', err: error }, 'Unexpected PostgreSQL pool error'));

type Migration = {
  version: string;
  up: (client: PoolClient) => Promise<void>;
};

const migrations: Migration[] = [{
  version: '20260901_001_initial_schema',
  up: async (client) => {
    await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username varchar(32) UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name varchar(80);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_key varchar(64);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trash_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS show_hidden_files boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    UPDATE users SET display_name=username WHERE display_name IS NULL;
    UPDATE users SET storage_key=username WHERE storage_key IS NULL;
    UPDATE users SET disabled_at=COALESCE(disabled_at,now())
      WHERE storage_key IN ('.upload-sessions','.dav-staging') OR storage_key LIKE '.originvault-%';
    ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
    ALTER TABLE users ALTER COLUMN storage_key SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_storage_key_unique ON users(storage_key);
    CREATE TABLE IF NOT EXISTS app_settings (
      id smallint PRIMARY KEY CHECK (id=1),
      registration_enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT INTO app_settings(id,registration_enabled) VALUES(1,false) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS folders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES folders(id) ON DELETE CASCADE,
      name varchar(255) NOT NULL,
      relative_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS modified_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS original_created_at timestamptz;
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS original_modified_at timestamptz;
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS trash_root_id uuid;
    ALTER TABLE folders ADD COLUMN IF NOT EXISTS trash_storage_path text;
    ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_user_id_parent_id_name_key;
    DROP INDEX IF EXISTS folders_root_name_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS folders_user_parent_name_active_unique
      ON folders(user_id, parent_id, name) WHERE trashed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS folders_root_name_unique
      ON folders(user_id, name) WHERE parent_id IS NULL AND trashed_at IS NULL;
    CREATE INDEX IF NOT EXISTS folders_user_trash_idx ON folders(user_id,trashed_at DESC) WHERE trashed_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
      original_name text NOT NULL,
      stored_name text NOT NULL,
      relative_path text NOT NULL,
      mime_type text NOT NULL,
      size_bytes bigint NOT NULL,
      sha256 char(64) NOT NULL,
      upload_identity_hash char(64),
      client_last_modified timestamptz,
      extracted_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE files ADD COLUMN IF NOT EXISTS upload_identity_hash char(64);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS modified_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE files ADD COLUMN IF NOT EXISTS original_created_at timestamptz;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS text_encoding varchar(32);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS text_has_bom boolean;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS trash_root_id uuid;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS trash_storage_path text;
    CREATE INDEX IF NOT EXISTS files_user_folder_idx ON files(user_id, folder_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS files_user_trash_idx ON files(user_id,trashed_at DESC) WHERE trashed_at IS NOT NULL;
    DROP INDEX IF EXISTS files_user_relative_path_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS files_user_relative_path_unique
      ON files(user_id, relative_path) WHERE trashed_at IS NULL;
    DROP INDEX IF EXISTS files_user_upload_identity_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS files_user_upload_identity_unique
      ON files(user_id, upload_identity_hash) WHERE upload_identity_hash IS NOT NULL AND trashed_at IS NULL;
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id uuid PRIMARY KEY,
      file_id uuid NOT NULL UNIQUE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_fingerprint text NOT NULL,
      identity_hash char(64) NOT NULL,
      destination_folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
      destination_folder_path text NOT NULL DEFAULT '',
      final_folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
      relative_directory text NOT NULL DEFAULT '',
      original_name text NOT NULL,
      mime_type text NOT NULL,
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      offset_bytes bigint NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0 AND offset_bytes <= size_bytes),
      client_last_modified timestamptz,
      temp_relative_path text NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finalizing')),
      stored_name text,
      final_relative_path text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(user_id, identity_hash)
    );
    ALTER TABLE upload_sessions
      ADD COLUMN IF NOT EXISTS final_folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS upload_sessions_user_updated_idx
      ON upload_sessions(user_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_reserved_path_unique
      ON upload_sessions(user_id, final_relative_path) WHERE final_relative_path IS NOT NULL;
    CREATE TABLE IF NOT EXISTS shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id uuid REFERENCES files(id) ON DELETE SET NULL,
      folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
      target_type varchar(8) NOT NULL CHECK (target_type IN ('file','folder')),
      target_name text NOT NULL,
      reshared_from_id uuid REFERENCES shares(id) ON DELETE SET NULL,
      expires_at timestamptz,
      revoked_at timestamptz,
      hidden_at timestamptz,
      token_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT shares_target_consistency CHECK ((target_type='file' AND folder_id IS NULL) OR (target_type='folder' AND file_id IS NULL))
    );
    ALTER TABLE shares ADD COLUMN IF NOT EXISTS paused_at timestamptz;
    ALTER TABLE shares ADD COLUMN IF NOT EXISTS password_hash text;
    ALTER TABLE shares ADD COLUMN IF NOT EXISTS password_version integer NOT NULL DEFAULT 0;
    ALTER TABLE shares ADD COLUMN IF NOT EXISTS access varchar(16) NOT NULL DEFAULT 'read';
    ALTER TABLE shares ADD COLUMN IF NOT EXISTS include_hidden boolean NOT NULL DEFAULT false;
    UPDATE shares SET access='read' WHERE access IS NULL;
    UPDATE folders SET is_hidden=true WHERE name LIKE '.%' AND is_hidden=false;
    UPDATE files SET is_hidden=true WHERE stored_name LIKE '.%' AND is_hidden=false;
    DO $share_access_constraint$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='shares'::regclass AND conname='shares_access_check'
      ) THEN
        ALTER TABLE shares ADD CONSTRAINT shares_access_check
          CHECK (access IN ('read','readwrite'));
      END IF;
    END
    $share_access_constraint$;
    DO $share_history_migration$
    DECLARE constraint_name text;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='2026-08-share-history-retention') THEN
        ALTER TABLE shares ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
        ALTER TABLE shares ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
        ALTER TABLE shares ADD COLUMN IF NOT EXISTS target_type varchar(8);
        ALTER TABLE shares ADD COLUMN IF NOT EXISTS target_name text;
        ALTER TABLE shares ADD COLUMN IF NOT EXISTS reshared_from_id uuid;
        UPDATE shares SET target_type=CASE WHEN file_id IS NULL THEN 'folder' ELSE 'file' END WHERE target_type IS NULL;
        UPDATE shares s SET target_name=COALESCE(
          s.target_name,
          (SELECT original_name FROM files WHERE id=s.file_id),
          (SELECT name FROM folders WHERE id=s.folder_id),
          '[deleted item]'
        ) WHERE s.target_name IS NULL;
        ALTER TABLE shares ALTER COLUMN target_type SET NOT NULL;
        ALTER TABLE shares ALTER COLUMN target_name SET NOT NULL;
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid='shares'::regclass AND contype='c'
            AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%'
        LOOP
          EXECUTE format('ALTER TABLE shares DROP CONSTRAINT %I',constraint_name);
        END LOOP;
        ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_file_id_fkey;
        ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_folder_id_fkey;
        ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_reshared_from_id_fkey;
        ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_target_consistency;
        ALTER TABLE shares ADD CONSTRAINT shares_file_id_fkey FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE SET NULL;
        ALTER TABLE shares ADD CONSTRAINT shares_folder_id_fkey FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL;
        ALTER TABLE shares ADD CONSTRAINT shares_reshared_from_id_fkey FOREIGN KEY(reshared_from_id) REFERENCES shares(id) ON DELETE SET NULL;
        ALTER TABLE shares ADD CONSTRAINT shares_target_consistency CHECK (
          (target_type='file' AND folder_id IS NULL) OR (target_type='folder' AND file_id IS NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS shares_reshared_from_unique ON shares(reshared_from_id) WHERE reshared_from_id IS NOT NULL;
        INSERT INTO schema_migrations(version) VALUES('2026-08-share-history-retention');
      END IF;
    END
    $share_history_migration$;
    CREATE UNIQUE INDEX IF NOT EXISTS shares_reshared_from_unique ON shares(reshared_from_id) WHERE reshared_from_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS shares_owner_created_idx ON shares(owner_user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS shares_owner_visible_created_idx
      ON shares(owner_user_id,created_at DESC) WHERE hidden_at IS NULL;
    CREATE TABLE IF NOT EXISTS share_events (
      id bigserial PRIMARY KEY,
      share_id uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      action varchar(24) NOT NULL CHECK (action IN ('view','download','denied')),
      ip_address varchar(64) NOT NULL,
      user_agent varchar(512),
      target_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
      bytes_sent bigint,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS share_events_share_created_idx ON share_events(share_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS webdav_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id uuid REFERENCES folders(id) ON DELETE CASCADE,
      name varchar(80) NOT NULL,
      secret_hash char(64) NOT NULL,
      access varchar(16) NOT NULL DEFAULT 'readwrite' CHECK (access IN ('read','readwrite')),
      expires_at timestamptz,
      revoked_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS webdav_tokens_user_created_idx ON webdav_tokens(user_id,created_at DESC);
    `);
  },
}];

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function migrate(): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const client = await db.connect();
  logger.info({ event: 'database_migration_started' }, 'Database migration started');
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('originvault:schema-migrations'))");
    await ensureMigrationTable(client);
    const applied = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.rows.map((entry) => entry.version));
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [migration.version]);
        await client.query('COMMIT');
        logger.info({ event: 'database_migration_applied', version: migration.version }, 'Database migration applied');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('originvault:schema-migrations'))").catch(() => undefined);
    client.release();
  }
  logger.info({ event: 'database_migration_completed', durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }, 'Database migration completed');
}
