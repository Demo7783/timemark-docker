import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { getDb, waitForDb, query } from './index.js';
import { encrypt, decrypt } from '@timemark/shared/crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Auto-migration: ensures database schema is up to date on startup.
 * Reads schema.sql and executes it (all statements are idempotent with IF NOT EXISTS).
 * Tracks schema version for future incremental migrations.
 *
 * 链路构成（docker 变基 v2.30）：
 * - schema.sql：基础表结构（SQLite 方言，幂等，勿在此追加新表）；
 * - v2→v33：docker 历史链（SQLite 方言，除 5 处必要修复外原样保留，见各条目注释）；
 * - v34→v81：自 timemark-vercel migrate.ts（PG 方言）翻译而来。PG 专属对象
 *   （pg_trgm GIN、pgvector、ALTER COLUMN TYPE、ADD CONSTRAINT、FOR UPDATE 行锁）
 *   按既定规则降级/删除，语义不可等价处见条目注释与 docs/PORT-LEDGER-v2.30.md。
 */
export async function runMigrations(): Promise<void> {
  console.log('[DB] Running migrations...');

  // Ensure database is ready
  await waitForDb();
  const db = getDb();

  // Find schema.sql - check multiple possible locations
  const possiblePaths = [
    path.resolve('./docker/schema.sql'),
    path.resolve('../docker/schema.sql'),
    path.resolve(__dirname, '../../../docker/schema.sql'),
    path.resolve(__dirname, '../../../../docker/schema.sql'),
  ];

  let schemaPath: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      schemaPath = p;
      break;
    }
  }

  if (!schemaPath) {
    console.warn('[DB] schema.sql not found, skipping migrations. Searched:', possiblePaths);
    return;
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Execute schema (all CREATE TABLE IF NOT EXISTS, so idempotent)
  try {
    db.exec(schemaSql);
    console.log('[DB] Schema applied successfully');
  } catch (error) {
    console.error('[DB] Failed to apply schema:', error);
    throw error;
  }

  // Check current schema version
  try {
    const stmt = db.prepare('SELECT MAX(version) as version FROM schema_version');
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    const currentVersion = rows[0]?.version || 0;
    console.log(`[DB] Current schema version: ${currentVersion}`);

    // Apply incremental migrations
    await applyIncrementalMigrations(db, currentVersion);
  } catch (error) {
    console.error('[DB] Failed to check schema version:', error);
  }
}

/**
 * Tables that carry the nullable `profile_id` added by v41 and are backfilled to the
 * owner's default `我` profile. `medications` (v42) is created after that backfill runs
 * and has no pre-existing rows, so it is not part of the v41 backfill list.
 */
const PROFILE_AWARE_TABLES = [
  'events',
  'fixed_contacts',
  'expiry_items',
  'inventory_items',
  'maintenance_plans',
  'documents',
  'habits',
] as const;

/**
 * SQLite 没有 ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT（PG 方言特性），
 * 且 db.exec 多语句会在第一条报错处截断。照 v32 先例：逐条 try/catch，
 * 失败（典型为 schema.sql 重叠或更早迁移已建列）仅警告跳过，不拖垮整条迁移链。
 * 统一走 query()（与 postMigrate 钩子同一通道，享受集中方言转换）。
 */
async function tryExec(label: string, sql: string): Promise<void> {
  try {
    await query(sql);
  } catch (e: any) {
    console.warn(`[DB] ${label} skipped: ${e?.message ?? e}`);
  }
}

export async function applyIncrementalMigrations(dbOrVersion: any, currentVersion?: number): Promise<void> {
  // 双形态签名：docker 运行时传 (db, currentVersion)；单参形态兼容 vercel 上游/既有测试的
  // (currentVersion) 调用习惯（此时经 getDb() 取库）。
  const db: any = currentVersion === undefined ? getDb() : dbOrVersion;
  const fromVersion: number = currentVersion === undefined ? Number(dbOrVersion) || 0 : currentVersion;
  const migrations: Array<{ version: number; name: string; sql: string; postMigrate?: (db: any) => void | Promise<void> }> = [
    {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS（PG 方言特性，sql.js 实测语法报错）。
      // api_key 不在 schema.sql 中，去掉该子句即可；版本号门闩保证只执行一次。
      version: 2,
      name: 'add_api_key_column',
      sql: `ALTER TABLE user_configs ADD COLUMN api_key TEXT;`
    },
    {
      version: 3,
      name: 'add_notification_queue',
      sql: `CREATE TABLE IF NOT EXISTS notification_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        next_retry_at TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status);
      CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id);`
    },
    {
      // schema.sql 的 events 已含 recurring_config（历史演进造成的重叠）：裸 ALTER 会报
      // duplicate column 并在 db.exec 多语句处截断。照 v32 先例走 postMigrate tryExec：
      // 列缺失时补建，已存在时仅警告，版本号照常落账（消除每次启动重跑报错的历史噪音）。
      version: 4,
      name: 'add_recurring_events',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v4 events.recurring_config', 'ALTER TABLE events ADD COLUMN recurring_config TEXT');
      },
    },
    {
      // 同 v4：next_occurrence 已在 schema.sql 中。
      version: 5,
      name: 'add_next_occurrence',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v5 events.next_occurrence', 'ALTER TABLE events ADD COLUMN next_occurrence TEXT');
      },
    },
    {
      version: 6,
      name: 'add_recurring_index',
      sql: `CREATE INDEX IF NOT EXISTS idx_events_next_occurrence ON events(next_occurrence);`
    },
    {
      version: 7,
      name: 'add_push_subscriptions',
      sql: `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        keys_p256dh TEXT,
        keys_auth TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);`
    },
    {
      // 同 v2：SQLite 不支持 ADD COLUMN IF NOT EXISTS；timezone 不在 schema.sql 中，去子句即可。
      version: 8,
      name: 'add_timezone_column',
      sql: `ALTER TABLE user_configs ADD COLUMN timezone TEXT DEFAULT 'Asia/Shanghai';`
    },
    {
      version: 9,
      name: 'hash_existing_api_keys',
      sql: `SELECT 1;`,
      postMigrate: (db: any) => {
        // Hash existing plaintext API keys in-place (SHA-256)
        const stmt = db.prepare('SELECT user_id, api_key FROM user_configs WHERE api_key IS NOT NULL');
        const rows: Array<{ user_id: number; api_key: string }> = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as any);
        }
        stmt.free();
        for (const row of rows) {
          // Skip if already hashed (64 hex chars = SHA-256 hash)
          if (row.api_key.length === 64 && /^[0-9a-f]+$/.test(row.api_key)) continue;
          const hash = createHash('sha256').update(row.api_key).digest('hex');
          db.run('UPDATE user_configs SET api_key = ? WHERE user_id = ?', [hash, row.user_id]);
        }
        if (rows.length > 0) {
          console.log(`[DB] Hashed ${rows.length} existing API key(s)`);
        }
      },
    },
    {
      // 同 v4：channel_results 已在 schema.sql 的 event_trigger_logs 中，走 postMigrate tryExec。
      version: 10,
      name: 'add_channel_results_column',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v10 event_trigger_logs.channel_results', 'ALTER TABLE event_trigger_logs ADD COLUMN channel_results TEXT');
      },
    },
    {
      version: 11,
      name: 'add_plugin_sessions',
      sql: `CREATE TABLE IF NOT EXISTS plugin_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_type TEXT NOT NULL,
        session_id TEXT UNIQUE NOT NULL,
        session_data TEXT,
        status TEXT DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_sessions_id ON plugin_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_plugin_sessions_expires ON plugin_sessions(expires_at);`
    },
    {
      version: 12,
      name: 'add_trigger_log_failure_details',
      sql: `ALTER TABLE event_trigger_logs ADD COLUMN error_details TEXT;
ALTER TABLE event_trigger_logs ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE event_trigger_logs ADD COLUMN channel_type TEXT;
ALTER TABLE event_trigger_logs ADD COLUMN account_id INTEGER;`
    },
    {
      version: 13,
      name: 'add_connection_status',
      sql: `ALTER TABLE notification_accounts ADD COLUMN connection_status TEXT;`
    },
    {
      version: 14,
      name: 'add_test_result_columns',
      sql: `ALTER TABLE notification_accounts ADD COLUMN last_test_result TEXT;
ALTER TABLE notification_accounts ADD COLUMN last_test_at TEXT;`
    },
    {
      version: 15,
      name: 'add_quiet_hours',
      sql: `ALTER TABLE user_configs ADD COLUMN quiet_hours_start TEXT;
ALTER TABLE user_configs ADD COLUMN quiet_hours_end TEXT;`
    },
    // v16-32 粗略移植自 vercel backend/src/db/migrate.ts (Approach B: JSONB->TEXT, SERIAL->INTEGER, TIMESTAMP->TEXT, BOOLEAN->INTEGER, jsonb_build_object->json_object)
    {
      version: 16,
      name: 'vercel_free_tier_features',
      sql: `ALTER TABLE events ADD COLUMN tags TEXT DEFAULT '[]';
ALTER TABLE events ADD COLUMN share_token TEXT;
ALTER TABLE events ADD COLUMN event_photo_url TEXT;
ALTER TABLE user_configs ADD COLUMN password_changed_at TEXT;
ALTER TABLE event_trigger_logs ADD COLUMN read_at TEXT;
CREATE TABLE IF NOT EXISTS cron_execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  result_summary TEXT,
  error_message TEXT,
  executed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_execution_logs(job_name, executed_at);`
    },
    {
      version: 17,
      name: 'security_features_v17',
      sql: `CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_logs_ip_time ON login_logs(ip_address, login_time);
ALTER TABLE user_configs ADD COLUMN ip_whitelist TEXT DEFAULT '[]';
ALTER TABLE user_configs ADD COLUMN ip_whitelist_enabled INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN refresh_family TEXT;
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  device_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);`
    },
    {
      version: 18,
      name: 'contacts_broadcast_v18',
      sql: `CREATE TABLE IF NOT EXISTS fixed_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  nickname TEXT,
  email TEXT,
  phone TEXT,
  telegram_chat_id TEXT,
  qq TEXT,
  wxpusher_uid TEXT,
  preferred_channels TEXT DEFAULT '[]',
  notes TEXT,
  validation_status TEXT DEFAULT 'pending',
  last_validated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user ON fixed_contacts(user_id);
CREATE TABLE IF NOT EXISTS broadcast_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  recipient_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  recipient_source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_broadcast_campaigns_user ON broadcast_campaigns(user_id);
ALTER TABLE email_logs ADD COLUMN broadcast_id INTEGER REFERENCES broadcast_campaigns(id) ON DELETE SET NULL;
ALTER TABLE user_configs ADD COLUMN email_opt_out INTEGER DEFAULT 0;
ALTER TABLE user_configs ADD COLUMN must_change_password INTEGER DEFAULT 0;`
    },
    {
      version: 19,
      name: 'webauthn_challenges_v19',
      sql: `CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
ALTER TABLE webauthn_credentials ADD COLUMN transports TEXT;
ALTER TABLE webauthn_credentials ADD COLUMN last_used_at TEXT;`
    },
    {
      version: 20,
      name: 'totp_enabled_flag_v20',
      sql: `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0;`,
      postMigrate: (db: any) => {
        try {
          db.exec(`UPDATE users SET totp_enabled = 1 WHERE totp_secret IS NOT NULL AND EXISTS (SELECT 1 FROM security_events se WHERE se.user_id = users.id AND se.event_type = 'totp_enabled')`);
          // 清理未完成 TOTP 半配置：仅 secret 非空且未启用
          db.exec(`UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE totp_secret IS NOT NULL AND COALESCE(totp_enabled, 0) = 0 AND NOT EXISTS (SELECT 1 FROM security_events se WHERE se.user_id = users.id AND se.event_type = 'totp_enabled')`);
          console.log('[DB] v20 totp_enabled migration done');
        } catch (e) {
          console.warn('[DB] v20 postMigrate skipped:', e);
        }
      },
    },
    {
      version: 21,
      name: 'notification_defaults_email_logs_v21',
      sql: `ALTER TABLE user_configs ADD COLUMN default_test_email TEXT;
ALTER TABLE email_logs ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE email_logs ADD COLUMN subject TEXT;
ALTER TABLE email_logs ADD COLUMN error_message TEXT;
ALTER TABLE email_logs ADD COLUMN channel_type TEXT DEFAULT 'email';
CREATE INDEX IF NOT EXISTS idx_email_logs_user_sent ON email_logs(user_id, sent_at);
ALTER TABLE notification_queue ADD COLUMN account_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_notification_queue_retry ON notification_queue(status, next_retry_at);`
    },
    {
      version: 22,
      name: 'integrations_v22',
      sql: `ALTER TABLE user_configs ADD COLUMN webhook_inbound_token TEXT;
ALTER TABLE user_configs ADD COLUMN webhook_inbound_secret TEXT;
ALTER TABLE user_configs ADD COLUMN calendar_feed_token TEXT;
ALTER TABLE user_configs ADD COLUMN external_calendar_urls TEXT DEFAULT '[]';
ALTER TABLE events ADD COLUMN timezone TEXT;
CREATE TABLE IF NOT EXISTS event_reminder_cache (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_event_reminder_cache_expires ON event_reminder_cache(expires_at);`,
      postMigrate: (db: any) => {
        try {
          const stmt = db.prepare('SELECT user_id FROM user_configs WHERE webhook_inbound_token IS NULL OR calendar_feed_token IS NULL');
          const rows: Array<{ user_id: number }> = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as any);
          stmt.free();
          for (const r of rows) {
            const webhookToken = randomBytes(24).toString('hex');
            const feedToken = randomBytes(24).toString('hex');
            const webhookSecret = randomBytes(32).toString('hex');
            db.run('UPDATE user_configs SET webhook_inbound_token = COALESCE(webhook_inbound_token, ?), calendar_feed_token = COALESCE(calendar_feed_token, ?), webhook_inbound_secret = COALESCE(webhook_inbound_secret, ?) WHERE user_id = ?', [webhookToken, feedToken, webhookSecret, r.user_id]);
          }
          if (rows.length) console.log(`[DB] v22 generated tokens for ${rows.length} user(s)`);
        } catch (e) {
          console.warn('[DB] v22 postMigrate skipped:', e);
        }
      },
    },
    {
      version: 23,
      name: 'inbox_messages_v23',
      sql: `CREATE TABLE IF NOT EXISTS inbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT,
  event_id INTEGER,
  sender_label TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_user_created ON inbox_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_user_unread ON inbox_messages(user_id, is_read);
ALTER TABLE user_configs ADD COLUMN inbox_receive_token TEXT;
ALTER TABLE user_configs ADD COLUMN inbox_receive_secret TEXT;`,
      postMigrate: (db: any) => {
        try {
          const stmt = db.prepare('SELECT user_id FROM user_configs WHERE inbox_receive_token IS NULL');
          const rows: Array<{ user_id: number }> = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as any);
          stmt.free();
          for (const r of rows) {
            const token = randomBytes(24).toString('hex');
            const secret = randomBytes(32).toString('hex');
            db.run('UPDATE user_configs SET inbox_receive_token = COALESCE(inbox_receive_token, ?), inbox_receive_secret = COALESCE(inbox_receive_secret, ?) WHERE user_id = ?', [token, secret, r.user_id]);
          }
          if (rows.length) console.log(`[DB] v23 generated inbox tokens for ${rows.length} user(s)`);
        } catch (e) {
          console.warn('[DB] v23 postMigrate skipped:', e);
        }
      },
    },
    {
      version: 24,
      name: 'optimizations_v24',
      sql: `CREATE TABLE IF NOT EXISTS webhook_idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  response_body TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_created ON webhook_idempotency_keys(created_at);
CREATE TABLE IF NOT EXISTS stats_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  stat_date TEXT NOT NULL,
  events_count INTEGER DEFAULT 0,
  triggers_total INTEGER DEFAULT 0,
  triggers_success INTEGER DEFAULT 0,
  triggers_failed INTEGER DEFAULT 0,
  UNIQUE(user_id, stat_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_dedup_success ON event_trigger_logs(event_id, trigger_date) WHERE status = 'success';
ALTER TABLE user_configs ADD COLUMN calendar_feed_tokens TEXT DEFAULT '[]';
ALTER TABLE user_configs ADD COLUMN external_calendar_sync_strategy TEXT DEFAULT 'add_only';
ALTER TABLE user_configs ADD COLUMN api_scopes TEXT DEFAULT 'read,write';
ALTER TABLE user_configs ADD COLUMN lunar_reminders_enabled INTEGER DEFAULT 0;
ALTER TABLE user_configs ADD COLUMN caldav_url TEXT;
ALTER TABLE user_configs ADD COLUMN caldav_username TEXT;
ALTER TABLE user_configs ADD COLUMN caldav_password_encrypted TEXT;
ALTER TABLE user_configs ADD COLUMN outbound_webhook_url TEXT;
ALTER TABLE user_configs ADD COLUMN resend_webhook_secret TEXT;
ALTER TABLE user_configs ADD COLUMN markdown_email_template TEXT;
ALTER TABLE user_configs ADD COLUMN notification_preset TEXT;`
    },
    {
      version: 25,
      name: 'features_v25',
      sql: `CREATE TABLE IF NOT EXISTS contact_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contact_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  UNIQUE(group_id, email)
);
CREATE TABLE IF NOT EXISTS conditional_reminder_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  days_before INTEGER NOT NULL,
  channels TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at);`
    },
    {
      version: 26,
      name: 'reminder_claims_v26',
      sql: `CREATE TABLE IF NOT EXISTS reminder_send_claims (
  event_id INTEGER NOT NULL,
  trigger_date TEXT NOT NULL,
  claimed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, trigger_date)
);
CREATE INDEX IF NOT EXISTS idx_reminder_claims_claimed ON reminder_send_claims(claimed_at);`
    },
    {
      version: 27,
      name: 'google_oauth_calendar_v27',
      sql: `ALTER TABLE user_configs ADD COLUMN google_oauth_refresh_token_encrypted TEXT;
ALTER TABLE user_configs ADD COLUMN google_oauth_email TEXT;
ALTER TABLE user_configs ADD COLUMN google_calendar_id TEXT DEFAULT 'primary';
ALTER TABLE user_configs ADD COLUMN google_oauth_connected_at TEXT;`
    },
    {
      version: 28,
      name: 'alert_settings_v28',
      sql: `ALTER TABLE user_configs ADD COLUMN alert_emails TEXT DEFAULT '[]';
ALTER TABLE user_configs ADD COLUMN alert_account_ids TEXT DEFAULT '[]';`
    },
    {
      version: 29,
      name: 'todo_completions_v29',
      sql: `CREATE TABLE IF NOT EXISTS todo_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  completed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, event_id, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_todo_completions_user ON todo_completions(user_id);`
    },
    {
      version: 30,
      name: 'contact_methods_v30',
      sql: `ALTER TABLE fixed_contacts ADD COLUMN contact_methods TEXT DEFAULT '{}';
-- 粗略移植 PG jsonb_build_object -> SQLite json_object/json_array，::jsonb 去除
UPDATE fixed_contacts SET contact_methods = json_object(
  'emails', CASE WHEN email IS NOT NULL AND email != '' THEN json_array(json_object('label', '默认', 'value', email)) ELSE json('[]') END,
  'phones', CASE WHEN phone IS NOT NULL AND phone != '' THEN json_array(json_object('label', '默认', 'value', phone)) ELSE json('[]') END,
  'telegrams', CASE WHEN telegram_chat_id IS NOT NULL AND telegram_chat_id != '' THEN json_array(json_object('label', '默认', 'value', telegram_chat_id)) ELSE json('[]') END,
  'qqs', CASE WHEN qq IS NOT NULL AND qq != '' THEN json_array(json_object('label', '默认', 'value', qq)) ELSE json('[]') END,
  'wxpusherUids', CASE WHEN wxpusher_uid IS NOT NULL AND wxpusher_uid != '' THEN json_array(json_object('label', '默认', 'value', wxpusher_uid)) ELSE json('[]') END
) WHERE contact_methods IS NULL OR contact_methods = '{}';`
    },
    {
      version: 31,
      name: 'contact_relationship_gender_v31',
      sql: `ALTER TABLE fixed_contacts ADD COLUMN relationship TEXT;
ALTER TABLE fixed_contacts ADD COLUMN gender TEXT DEFAULT 'unknown';`
    },
    {
      version: 32,
      name: 'session_data_text_v32',
      sql: `ALTER TABLE notification_accounts ADD COLUMN session_data_text TEXT;`,
      postMigrate: (db: any) => {
        // 粗略版：先新增 TEXT 列并拷贝数据；DROP COLUMN 在 SQLite 需重建表，此处仅尝试，不成功则留注释由后续完整迁移处理
        try {
          const stmt = db.prepare('SELECT id, session_data, session_data_text FROM notification_accounts WHERE session_data IS NOT NULL AND session_data_text IS NULL');
          const rows: Array<{ id: number; session_data: any }> = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as any);
          stmt.free();
          for (const row of rows) {
            let textValue: string | null = null;
            const raw: any = row.session_data;
            if (raw == null) textValue = null;
            else if (typeof raw === 'string') textValue = raw;
            else if (typeof raw === 'object') textValue = JSON.stringify(raw);
            if (textValue != null) db.run('UPDATE notification_accounts SET session_data_text = ? WHERE id = ?', [textValue, row.id]);
          }
          if (rows.length) console.log(`[DB] v32 copied session_data -> session_data_text for ${rows.length} row(s)`);
          // 尝试 SQLite DROP/COLUMN RENAME（新版 SQLite 支持，旧版会抛错则仅警告）
          try { db.exec('ALTER TABLE notification_accounts DROP COLUMN session_data;'); } catch { console.warn('[DB] v32 DROP COLUMN session_data skipped (需重建表，粗略版保留)'); }
          try { db.exec('ALTER TABLE notification_accounts RENAME COLUMN session_data_text TO session_data;'); } catch { console.warn('[DB] v32 RENAME COLUMN skipped'); }
          // TODO 完整重建表思路: CREATE TABLE notification_accounts_new (... session_data TEXT ...); INSERT INTO ... SELECT ...; DROP TABLE notification_accounts; ALTER TABLE ... RENAME TO ...
        } catch (e) {
          console.warn('[DB] v32 postMigrate skipped:', e);
        }
      },
    },
    {
      version: 33,
      name: 'session_refresh_token_rotation_v33',
      sql: `ALTER TABLE sessions ADD COLUMN refresh_token_id TEXT;`,
    },
    {
      // v34（vercel todo 44）: 到期项域 —— 订阅/账单/保险/域名/保修/自定义 + 续费审计历史
      // （expiry_history，todo 45 写入）。纯增量 + 幂等：全部 IF NOT EXISTS，不改不删既有对象。
      // SQLite 翻译：SERIAL→INTEGER AUTOINCREMENT、JSONB/DATE/TIMESTAMP→TEXT、BOOLEAN→INTEGER、
      // TEXT[] DEFAULT '{}'→TEXT DEFAULT '[]'、部分索引 TRUE→1；文末 PG trgm DO 块整条删除。
      version: 34,
      name: 'expiry_items_v34',
      sql: `CREATE TABLE IF NOT EXISTS expiry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'bill', 'insurance', 'domain', 'warranty', 'custom')),
  title TEXT NOT NULL,
  vendor TEXT,
  amount_cents BIGINT,
  currency TEXT NOT NULL DEFAULT 'CNY',
  cycle TEXT NOT NULL DEFAULT 'once' CHECK (cycle IN ('once', 'monthly', 'quarterly', 'yearly', 'custom')),
  cycle_days INTEGER,
  start_date TEXT,
  next_due_date TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  reminder_config TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_due ON expiry_items(user_id, next_due_date);
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_kind ON expiry_items(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_expiry_items_active_due ON expiry_items(user_id, next_due_date) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS expiry_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES expiry_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_date TEXT,
  to_date TEXT,
  amount_cents BIGINT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expiry_history_item ON expiry_history(item_id, created_at DESC);
-- pg_trgm 全文索引在 SQLite 上由 LIKE 回退（见 search.service.ts）`,
    },
    {
      // v35（vercel todo 49）: 库存域 —— 数量/低库存阈值/可选过期日。expires_at 有意可空：
      // 非消耗品不进 expiring 查询（该查询自带 expires_at IS NOT NULL 守卫）。
      // trgm DO 块删除（同 v34）。
      version: 35,
      name: 'inventory_items_v35',
      sql: `CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('food', 'medicine', 'supply', 'other')),
  quantity NUMERIC NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit TEXT,
  low_stock_threshold NUMERIC CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  purchased_at TEXT,
  expires_at TEXT,
  location TEXT,
  notes TEXT,
  reminder_config TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_expires ON inventory_items(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_category ON inventory_items(user_id, category);
CREATE INDEX IF NOT EXISTS idx_inventory_items_active_expires ON inventory_items(user_id, expires_at) WHERE is_active = 1;
-- pg_trgm 全文索引在 SQLite 上由 LIKE 回退（见 search.service.ts）`,
    },
    {
      // v36（vercel todo 50）: 保养计划 —— 日期区间（共享提醒引擎）和/或用量区间
      // （剩余 10% 时收件箱轻推）+ maintenance_logs 审计表。表级 CHECK 强制至少配置一个区间。
      version: 36,
      name: 'maintenance_plans_v36',
      sql: `CREATE TABLE IF NOT EXISTS maintenance_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  asset_name TEXT NOT NULL,
  asset_kind TEXT NOT NULL DEFAULT 'other' CHECK (asset_kind IN ('vehicle', 'appliance', 'device', 'other')),
  interval_days INTEGER CHECK (interval_days IS NULL OR interval_days > 0),
  interval_usage INTEGER CHECK (interval_usage IS NULL OR interval_usage > 0),
  usage_unit TEXT CHECK (usage_unit IS NULL OR usage_unit IN ('km', 'hours', 'cycles')),
  current_usage NUMERIC CHECK (current_usage IS NULL OR current_usage >= 0),
  last_done_at TEXT,
  next_due_at TEXT,
  next_due_usage NUMERIC CHECK (next_due_usage IS NULL OR next_due_usage >= 0),
  notes TEXT,
  reminder_config TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT maintenance_plans_interval_present CHECK (interval_days IS NOT NULL OR interval_usage IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_due ON maintenance_plans(user_id, next_due_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_kind ON maintenance_plans(user_id, asset_kind);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_active_due ON maintenance_plans(user_id, next_due_at) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES maintenance_plans(id) ON DELETE CASCADE,
  done_at TEXT NOT NULL,
  usage_at NUMERIC,
  cost_cents BIGINT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_plan ON maintenance_logs(plan_id, done_at DESC);`,
    },
    {
      // v37（vercel todo 52）: 附件元数据（D2 文档库）。字节存对象存储（docker 部署为本地
      // 存储实现），绝不入库。多态属主 (owner_type, owner_id)：两列作为整体成对可空
      // （CHECK 强制），支持"先挂在属主上、后解除关联而不删对象"。
      version: 37,
      name: 'attachments_v37',
      sql: `CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_type TEXT CHECK (owner_type IS NULL OR owner_type IN ('document', 'expiry', 'inventory', 'maintenance', 'event')),
  owner_id INTEGER,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT attachments_owner_pair CHECK ((owner_type IS NULL) = (owner_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_attachments_user_owner ON attachments(user_id, owner_type, owner_id);`,
    },
    {
      // v38（vercel todo 54）: 文档库（护照/身份证/驾照/签证/证书/保单/合同/其他）。
      // document_number_encrypted 存 AES-256-GCM 密文（同 MASTER_KEY 约定），列表接口
      // 永不返回，只回 numberConfigured 标志。trgm DO 块删除（同 v34）。
      version: 38,
      name: 'documents_v38',
      sql: `CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('passport', 'id_card', 'driver_license', 'visa', 'certificate', 'policy', 'contract', 'other')),
  title TEXT NOT NULL,
  issuer TEXT,
  document_number_encrypted TEXT,
  issued_at TEXT,
  expires_at TEXT,
  country TEXT,
  notes TEXT,
  reminder_config TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_user_expires ON documents(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_documents_user_kind ON documents(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_documents_active_expires ON documents(user_id, expires_at) WHERE is_active = 1;
-- pg_trgm 全文索引在 SQLite 上由 LIKE 回退（见 search.service.ts）`,
    },
    {
      // v39（vercel todo 60）: 个人 CRM 互动流水 + 联系频次（D4）。
      // interactions.user_id 从 fixed_contacts.user_id 反范式化：时间线索引即覆盖路径，
      // 且即使漏掉 JOIN 每个读取也保持 user 作用域。contact_methods(v30) 仍是联系方式唯一来源。
      // 三个 ADD COLUMN 在 SQLite 无 IF NOT EXISTS，走 postMigrate tryExec。
      version: 39,
      name: 'crm_interactions_cadence_v39',
      sql: `CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'message', 'meeting', 'meal', 'visit', 'gift', 'other')),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  summary TEXT,
  mood TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_interactions_user_contact_occurred ON interactions(user_id, contact_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS contact_promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  due_at TEXT,
  done_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_promises_contact ON contact_promises(contact_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gift_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES fixed_contacts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('given', 'received')),
  occasion TEXT,
  amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_DATE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gift_records_contact ON gift_records(contact_id, occurred_at DESC);`,
      postMigrate: async () => {
        // 一次性回填：锚点缺失时取最近一次互动；已有值或无互动的联系人不动，重跑为 no-op。
        await tryExec('v39 fixed_contacts.cadence_days', 'ALTER TABLE fixed_contacts ADD COLUMN cadence_days INTEGER');
        await tryExec('v39 fixed_contacts.last_contact_at', 'ALTER TABLE fixed_contacts ADD COLUMN last_contact_at TEXT');
        await tryExec('v39 fixed_contacts.cadence_enabled', 'ALTER TABLE fixed_contacts ADD COLUMN cadence_enabled INTEGER DEFAULT 0');
        // SQLite 3.33+ 支持 UPDATE...FROM（sql.js 内核 ≥3.45，探针实测），语义与 PG 版一致。
        const backfilled = await query(
          `UPDATE fixed_contacts AS fc
           SET last_contact_at = latest.max_occurred
           FROM (
             SELECT contact_id, MAX(occurred_at) AS max_occurred
             FROM interactions
             GROUP BY contact_id
           ) AS latest
           WHERE fc.id = latest.contact_id
             AND fc.last_contact_at IS NULL`,
        );
        if (backfilled.rowCount > 0) {
          console.log(`[DB] Backfilled last_contact_at for ${backfilled.rowCount} contact(s)`);
        }
      },
    },
    {
      // v40（vercel todo 64）: 习惯打卡（D6）habits + habit_logs。UNIQUE (habit_id, logged_on)
      // 使同日打卡成为 UPSERT（count += n），永不出第二行。与 todo_completions(v29) 是两个概念
      // （日/周周期、目标值、排期/提醒配置）。schedule_days/reminder_times 存 JSON 数组文本。
      version: 40,
      name: 'habits_v40',
      sql: `CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  name TEXT NOT NULL,
  icon TEXT,
  target_per_period INTEGER NOT NULL DEFAULT 1 CHECK (target_per_period >= 1),
  period TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day', 'week')),
  schedule_days TEXT,
  reminder_times TEXT,
  color TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
CREATE INDEX IF NOT EXISTS idx_habits_user_active ON habits(user_id) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_on TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (habit_id, logged_on)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_date ON habit_logs(habit_id, logged_on DESC);
CREATE INDEX IF NOT EXISTS idx_habit_logs_user_date ON habit_logs(user_id, logged_on DESC);`,
      postMigrate: async () => {
        await tryExec('v40 user_configs.habit_streak_nudge_hour', `ALTER TABLE user_configs ADD COLUMN habit_streak_nudge_hour TEXT DEFAULT '20:00'`);
      },
    },
    {
      // v41（vercel todo 68）: 家庭成员档案（D5）。个人家庭模型（self/family/pet）——
      // 无组织、无团队、无席位、无多租户。profile_id 全线可空（未来导入可缺省），
      // REFERENCES profiles ON DELETE SET NULL：删档案只是把行打回"未分配"，不删数据。
      // docker 链路差异：
      // - events/fixed_contacts 的 profile_id 由本迁移 postMigrate 补建（schema.sql 无此列，
      //   SQLite 无 ADD COLUMN IF NOT EXISTS 故逐条 try/catch）；
      // - expiry_items/inventory_items/maintenance_plans/documents/habits 在 v34-v40 建表时
      //   已带裸 profile_id，vercel 的「补 FK」DO 块删除——SQLite 无法事后 ADD CONSTRAINT，
      //   且新链路在 v41 回填前不存在任何 profile_id 值，无悬挂可能；
      // - medications 的守卫 DO 块删除：docker 链路 v42 建表时内联自带该列。
      version: 41,
      name: 'profiles_v41',
      sql: `CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT,
  kind TEXT NOT NULL DEFAULT 'family' CHECK (kind IN ('self', 'family', 'pet')),
  birth_date TEXT,
  lunar_birthday TEXT,
  avatar_emoji TEXT,
  timezone TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
-- 每用户恰好一个 self 档案（「我」默认档案）；family/pet 不限量。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_profiles_user_self ON profiles(user_id) WHERE kind = 'self';
-- (user_id, profile_id) 覆盖索引：profile 过滤可及的每张表（vercel todo 69）。
-- events/fixed_contacts 两表依赖 postMigrate 补建的列，其索引也在 postMigrate 创建。
CREATE INDEX IF NOT EXISTS idx_expiry_items_user_profile ON expiry_items(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_profile ON inventory_items(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_plans_user_profile ON maintenance_plans(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_profile ON documents(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_habits_user_profile ON habits(user_id, profile_id);`,
      postMigrate: async () => {
        await tryExec('v41 events.profile_id', 'ALTER TABLE events ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
        await tryExec('v41 fixed_contacts.profile_id', 'ALTER TABLE fixed_contacts ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
        await tryExec('v41 idx_events_user_profile', 'CREATE INDEX IF NOT EXISTS idx_events_user_profile ON events(user_id, profile_id)');
        await tryExec('v41 idx_fixed_contacts_user_profile', 'CREATE INDEX IF NOT EXISTS idx_fixed_contacts_user_profile ON fixed_contacts(user_id, profile_id)');
        // 每用户一条默认档案（「我」，kind='self'）。NOT EXISTS 守卫使重跑为 no-op，
        // 部分唯一索引在库层强制同一不变量——绝不出第二个「我」。
        const created = await query(
          `INSERT INTO profiles (user_id, name, kind)
           SELECT u.id, '我', 'self' FROM users u
           WHERE NOT EXISTS (
             SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.kind = 'self'
           )`,
        );
        if (created.rowCount && created.rowCount > 0) {
          console.log(`[DB] Created ${created.rowCount} default profile(s) 我`);
        }

        // 既有行回填到属主的默认档案。仅回填 NULL，重跑绝不覆盖显式指派。
        let backfilled = 0;
        for (const table of PROFILE_AWARE_TABLES) {
          const updated = await query(
            `UPDATE ${table} AS t SET profile_id = p.id
             FROM profiles AS p
             WHERE t.profile_id IS NULL AND p.user_id = t.user_id AND p.kind = 'self'`,
          );
          backfilled += updated.rowCount ?? 0;
        }
        if (backfilled > 0) {
          console.log(`[DB] Backfilled profile_id for ${backfilled} row(s)`);
        }
      },
    },
    {
      // v42（vercel todo 71）: 用药域（D3）medications + 服药记录。仅提醒与记录：
      // 无医疗建议、无药房集成、无 AI 特性（明确出圈）。schedule_times NOT NULL DEFAULT '[]'：
      // 空数组是合法的按需（PRN）方案，物化零次排程；NULL 会逼每个读取方特判。
      // UNIQUE (medication_id, scheduled_for) 使排程物化幂等。v42 建表时内联自带
      // profile_id（REFERENCES profiles），vercel 末尾的守卫 ALTER 在 docker 链路是纯冗余，删除。
      version: 42,
      name: 'medications_v42',
      sql: `CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  dosage TEXT,
  form TEXT NOT NULL DEFAULT 'tablet' CHECK (form IN ('tablet', 'capsule', 'liquid', 'injection', 'patch', 'drops', 'other')),
  schedule_times TEXT NOT NULL DEFAULT '[]',
  schedule_days TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT CHECK (end_date IS NULL OR end_date >= start_date),
  stock_quantity NUMERIC CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  stock_unit TEXT,
  units_per_dose NUMERIC NOT NULL DEFAULT 1 CHECK (units_per_dose > 0),
  refill_threshold NUMERIC CHECK (refill_threshold IS NULL OR refill_threshold >= 0),
  prescriber TEXT,
  pharmacy TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_critical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_medications_user_profile ON medications(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_medications_user_active ON medications(user_id) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS medication_doses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  logged_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('taken', 'skipped', 'missed', 'pending')),
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (medication_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_medication_doses_user_scheduled ON medication_doses(user_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_medication_doses_med_status ON medication_doses(medication_id, status);`,
    },
    {
      // v43（vercel todo 70）: 按档案的通知路由。join 表决定哪些通知账号接收某档案的提醒：
      // 有行 → 仅这些账号可路由（事件级 notification_account_ids 绑定仍最优先）；
      // 无行 → 回退全部启用账号（v43 前行为，存量用户无感）。两 FK 均 CASCADE；
      // 复合主键即去重；同用户属主校验由 API 层承担。
      version: 43,
      name: 'profile_channel_accounts_v43',
      sql: `CREATE TABLE IF NOT EXISTS profile_channel_accounts (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_channel_accounts_account ON profile_channel_accounts(account_id);`,
    },
    {
      // v44（vercel todo 81）: 个人目标 + 里程碑。current_value 存原始值（可超额 150/100），
      // 只有派生百分比被钳到 100；target_value 可空（纯里程碑目标）但非 0（分母无意义）。
      // milestones.goal_id CASCADE（删目标清清单）；event_id 可选挂接既有提醒引擎，SET NULL。
      version: 44,
      name: 'goals_milestones_v44',
      sql: `CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  target_value NUMERIC CHECK (target_value IS NULL OR target_value > 0),
  current_value NUMERIC NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  unit TEXT,
  start_date TEXT NOT NULL DEFAULT CURRENT_DATE,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'abandoned')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT goals_target_after_start CHECK (target_date IS NULL OR target_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_user_profile ON goals(user_id, profile_id);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TEXT,
  done_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_milestones_event ON milestones(event_id) WHERE event_id IS NOT NULL;`,
    },
    {
      // v45（vercel checkbox 78）: 节假日感知提醒 + 可选节气提醒。两个 user_configs 增量列，
      // 默认值保持 v45 前行为（keep + 空列表），存量行不动，用户从设置里显式开启。
      version: 45,
      name: 'holiday_jieqi_reminders_v45',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v45 user_configs.holiday_reminder_mode', `ALTER TABLE user_configs ADD COLUMN holiday_reminder_mode TEXT DEFAULT 'keep'`);
        await tryExec('v45 user_configs.jieqi_reminder_list', `ALTER TABLE user_configs ADD COLUMN jieqi_reminder_list TEXT DEFAULT '[]'`);
      },
    },
    {
      // v46（vercel checkbox 80）: 日报偏好 —— 开关/周期/收件人覆盖/包含哪些板块/走哪个
      // 邮件通道投递。默认值保持 v46 前行为：digest_enabled 默认 1（用户需显式退出，
      // checkbox-79 cron 曾向所有账号发月报）；digest_sections NULL = 全部板块；
      // digest_recipients 空列表 = 回退 resolveRecipientEmails。digest_channel_account_id
      // 有意不做 FK 约束（属主/邮件能力校验在 API 层）。
      version: 46,
      name: 'digest_preferences_v46',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v46 user_configs.digest_enabled', 'ALTER TABLE user_configs ADD COLUMN digest_enabled INTEGER NOT NULL DEFAULT 1');
        await tryExec('v46 user_configs.digest_period', `ALTER TABLE user_configs ADD COLUMN digest_period TEXT NOT NULL DEFAULT 'monthly'`);
        await tryExec('v46 user_configs.digest_recipients', `ALTER TABLE user_configs ADD COLUMN digest_recipients TEXT DEFAULT '[]'`);
        await tryExec('v46 user_configs.digest_sections', 'ALTER TABLE user_configs ADD COLUMN digest_sections TEXT');
        await tryExec('v46 user_configs.digest_channel_account_id', 'ALTER TABLE user_configs ADD COLUMN digest_channel_account_id INTEGER');
      },
    },
    {
      // v47（vercel checkbox 86）: 选择性加入的 CalDAV 写回。每用户开关（默认关）、写目标
      // 集合 URL（与只读导入的 caldav_url 分开存，写目标永不是导入源日历）、以及远端对象
      // 登记表（稳定 UID / 最近 ETag / 内容哈希，供 If-None-Match 创建、If-Match 更新/删除）。
      version: 47,
      name: 'caldav_writeback_v47',
      sql: `CREATE TABLE IF NOT EXISTS caldav_writeback_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('event', 'expiry_item')),
  entity_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  collection_url TEXT NOT NULL,
  etag TEXT,
  content_hash TEXT,
  last_pushed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_caldav_writeback_objects_user ON caldav_writeback_objects(user_id);`,
      postMigrate: async () => {
        await tryExec('v47 user_configs.caldav_writeback_enabled', 'ALTER TABLE user_configs ADD COLUMN caldav_writeback_enabled INTEGER NOT NULL DEFAULT 0');
        await tryExec('v47 user_configs.caldav_writeback_url', 'ALTER TABLE user_configs ADD COLUMN caldav_writeback_url TEXT');
      },
    },
    {
      // v48（vercel checkbox 89）: 选择性加入的公开 ICS 订阅源。每行是一个保存的过滤条件
      // + 公开 token 的 SHA-256 哈希（原文只展示一次，库泄露无法还原订阅 URL）。
      // revoked_at 软删：公开路由只服务 revoked_at IS NULL 的行，哈希永久保留，
      // 撤销的源不可能被 token 碰撞复活。
      version: 48,
      name: 'ics_feeds_v48',
      sql: `CREATE TABLE IF NOT EXISTS ics_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "filter" TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_access_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ics_feeds_token_hash ON ics_feeds(token_hash);
CREATE INDEX IF NOT EXISTS idx_ics_feeds_user ON ics_feeds(user_id);`,
    },
    {
      // v49（vercel checkbox 91, D7 Telegram bot）: bot_updates 是 Telegram webhook 去重台账。
      // Telegram 会重试未 ACK 的 update，处理前先 INSERT...ON CONFLICT DO NOTHING 认领
      // update_id：重试时直接 ACK 200 不再执行命令。
      version: 49,
      name: 'bot_updates_v49',
      sql: `CREATE TABLE IF NOT EXISTS bot_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_updates_received_at ON bot_updates(received_at);`,
    },
    {
      // v50（vercel checkbox 94, D7 Telegram bot）: 聊天<->用户/档案绑定 + 脱敏命令审计。
      // 绝不自动绑定：聊天只能消费设置页生成的 code 完成绑定（bot_link_codes），/unlink 置
      // revoked_at 软删。bot_link_codes 只存短时一次性 code 的 SHA-256 哈希；核销是
      // UPDATE...WHERE used_at IS NULL AND expires_at > CURRENT_TIMESTAMP 的原子 UPDATE。
      // bot_links UNIQUE (platform, chat_id) 使同聊天重复 /link 变 UPDATE 而非重复行。
      version: 50,
      name: 'bot_links_v50',
      sql: `CREATE TABLE IF NOT EXISTS bot_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT,
  active_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  linked_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  UNIQUE (platform, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_links_user ON bot_links(user_id);
CREATE TABLE IF NOT EXISTS bot_link_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_link_codes_code_hash ON bot_link_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_bot_link_codes_user ON bot_link_codes(user_id);
CREATE TABLE IF NOT EXISTS bot_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  command TEXT NOT NULL,
  args_redacted TEXT,
  result TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_user ON bot_audit_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_chat ON bot_audit_logs(platform, chat_id, created_at);`,
    },
    {
      // v51（vercel checkbox 97, defects D2/D5）: /snooze 持久化。events.next_occurrence 是
      // 日期语义，分钟级贪睡截止时刻需要独立的 snoozed_until 列；date/next_occurrence 保持
      // 正典不动（贪睡可逆）。vercel 版还把 event_trigger_logs.trigger_date 从 DATE 改 TEXT
      //（PG 下 DATE 吞掉去重 token 报 22007）——docker 链路该列本就是 TEXT（schema.sql），
      // ALTER COLUMN TYPE 无对应物也无需迁移。
      version: 51,
      name: 'event_snoozed_until_v51',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v51 events.snoozed_until', 'ALTER TABLE events ADD COLUMN snoozed_until TEXT');
      },
    },
    {
      // v52（vercel checkbox 105）: 确定性行为模式库。每 (user, kind, key) 一行，JSON 值 +
      // [0,1] 置信度 + 一致观测数。只由 services/patterns.service.ts 的每夜重计算写入
      // （数据全部来自库内行，无 LLM、无外呼）。key 是纯文本桶标签（如 08:00、d1、email、
      // 星期 3、联系人 id），重跑 UPSERT 同一行而非追加历史。置信度 <0.5 的行保留作证据，
      // API 过滤掉。
      version: 52,
      name: 'user_patterns_v52',
      sql: `CREATE TABLE IF NOT EXISTS user_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  computed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_user_patterns_user ON user_patterns(user_id);`,
    },
    {
      // v53（vercel checkbox 106）: vercel 版全量是 pg_trgm GIN 索引 + pgvector embeddings
      // DO 块。SQLite 翻译：trgm 索引整条删除（CJK 子串搜索由 LIKE 回退，见
      // search.service.ts）；pgvector 无 SQLite 对应物，embeddings 表不建（语义检索在
      // docker 部署不可用）。保留版本号占位，维持 v2→v81 链号连续。
      version: 53,
      name: 'search_trgm_embeddings_v53',
      sql: `SELECT 1;`,
    },
    {
      // v54（vercel checkbox 112, Wave 14）: 常驻 AI 的持久后台任务表族（非 Workflow 保留，
      // 是事实源）：agent_jobs 由 at-least-once runner 认领（lease_token + lease_expires_at
      // 可续租，租期到期按 attempts 回收），agent_job_events 追加式审计，agent_workers
      // worker 注册表，agent_routines 每用户排程。kind/status CHECK 收敛生命周期；
      // idempotency_key 的部分唯一索引只在有 key 时按用户幂等（NULL user_id 行互不碰撞）。
      // gen_random_uuid() → lower(hex(randomblob(16)))；行锁 FOR UPDATE SKIP LOCKED 在
      // 单连接内存库无意义，并发正确性由 lease_token 校验保证。
      version: 54,
      name: 'agent_jobs_v54',
      sql: `CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CONSTRAINT agent_jobs_kind_check CHECK (kind IN ('evening_review', 'hourly_triage', 'morning_brief', 'watchdog', 'weekly_review')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CONSTRAINT agent_jobs_status_check CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_heartbeat_at TEXT,
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  result TEXT,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_idempotency ON agent_jobs (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_jobs_claim ON agent_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_kind_status ON agent_jobs (kind, status);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_user_created ON agent_jobs (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_job_events_job ON agent_job_events (job_id, at);
CREATE TABLE IF NOT EXISTS agent_workers (
  id TEXT PRIMARY KEY,
  kind TEXT,
  last_seen_at TEXT,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS agent_routines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expr TEXT,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  last_run_at TEXT,
  tier TEXT,
  budget_per_day INTEGER,
  config TEXT NOT NULL DEFAULT '{}',
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_agent_routines_due ON agent_routines (enabled, next_run_at);`,
    },
    {
      // v55（vercel checkbox 101）: 作用域化、可撤销的 agent token + 审计。token 原文只展示
      // 一次，仅存 SHA-256 哈希；scopes 是粗粒度授权数组（read/write/admin），dispatcher 映射
      // 到各工具的 requiredScope；agent_audit_logs 记录每次授权决策（脱敏参数/结果/耗时）。
      // 撤销软删（revoked_at），审计链保留对 token 的引用。ARRAY['read'] → JSON '["read"]'。
      version: 55,
      name: 'agent_tokens_v55',
      sql: `CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["read"]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  args_redacted TEXT NOT NULL DEFAULT '{}',
  decision TEXT NOT NULL CONSTRAINT agent_audit_logs_decision_check CHECK (decision IN ('allowed', 'denied', 'confirm_required')),
  result TEXT CONSTRAINT agent_audit_logs_result_check CHECK (result IN ('ok', 'error')),
  error_code TEXT,
  duration_ms INTEGER,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_user ON agent_audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_token ON agent_audit_logs (token_id, created_at DESC);`,
    },
    {
      // v56（vercel checkbox 102）: agent 动作的两段式确认持久化。requiresConfirmation 工具
      // 不在第一步执行：先记录一条 pending 行返回 id，第二步原子认领（UPDATE...SET
      // status='consumed' WHERE status='pending' AND expires_at > CURRENT_TIMESTAMP）——
      // 单次有效性与 2 分钟 TTL 都在这条条件 UPDATE 里，并发双确认最多命中一行。
      // 持久化而非内存态：进程重启会丢掉所有待确认项。
      version: 56,
      name: 'agent_confirmations_v56',
      sql: `CREATE TABLE IF NOT EXISTS agent_confirmations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT agent_confirmations_status_check CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_confirmations_user ON agent_confirmations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_confirmations_pending ON agent_confirmations (status, expires_at);`,
    },
    {
      // v57（vercel checkbox 132）: vercel 版全量是为 v53 未覆盖实体补建的 pg_trgm GIN 索引
      // （inventory location/notes、maintenance asset_name/notes、habits name、goals
      // title/description、inbox title/body/sender_label）。SQLite 上整条删除（同 v53，
      // LIKE 回退）。保留版本号占位。
      version: 57,
      name: 'search_trgm_remaining_v57',
      sql: `SELECT 1;`,
    },
    {
      // v58（vercel checkbox 134）: 跨实体标签系统。tags 是每用户标签词表；tag_links 对八种
      // 实体（event/contact/document/expiry/inventory/maintenance/habit/goal）做多对多关联，
      // 与既有 events.tags JSON 列正交。tag_links.user_id 反范式化：列表过滤谓词对
      // (user_id, entity_type, entity_id) 逐行 EXISTS 时索引可直接命中，且一行用户永远看不到
      // 另一用户的 link。tag_id CASCADE：删标签清 link 但绝不动被关联实体；entity_id 是普通
      // 列（跨八表，不做多态 FK），服务层在每次插入前校验属主。
      version: 58,
      name: 'tags_tag_links_v58',
      sql: `CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags (user_id, name);
CREATE TABLE IF NOT EXISTS tag_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CONSTRAINT tag_links_entity_type_check CHECK (entity_type IN ('event', 'contact', 'document', 'expiry', 'inventory', 'maintenance', 'habit', 'goal')),
  entity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tag_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_links_entity ON tag_links (user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tag_links_tag ON tag_links (tag_id, entity_type);`,
    },
    {
      // v59（vercel checkbox 115-116）: 自续链调度器的出口台账 —— scheduler_runs（经部分
      // 唯一索引每链至多一个 live run）+ scheduler_ticks（每 tick 一行台账，due/ran/skipped/
      // error 计数 + 详情）。部分唯一索引是并发引导/交接的仲裁者：INSERT...ON CONFLICT
      // (chain_id) WHERE status='running' DO NOTHING（SQLite 3.35+ 支持，探针实测）。
      version: 59,
      name: 'scheduler_egress_v59',
      sql: `CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  chain_id TEXT NOT NULL DEFAULT 'default',
  parent_run_id TEXT REFERENCES scheduler_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'handed_off', 'stalled', 'stopped')),
  tick_interval_ms INTEGER NOT NULL DEFAULT 600000,
  step_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_tick_at TEXT,
  handed_off_at TEXT,
  ended_at TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);

-- 每链恰好一个 live run：并发引导/交接的仲裁者。
CREATE UNIQUE INDEX IF NOT EXISTS scheduler_runs_one_live_per_chain
  ON scheduler_runs (chain_id) WHERE status = 'running';

-- 链历史 / 状态读取。
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_chain
  ON scheduler_runs (chain_id, started_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_count INTEGER NOT NULL DEFAULT 0,
  ran_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}'
);

-- GET /api/agent/scheduler/status 与心跳轨迹的最近一次 tick 查询。
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_run_at
  ON scheduler_ticks (run_id, at DESC);`,
    },
    {
      // v60（vercel checkbox 118 + 121）: 主动通知预算/抑制/折叠内容台账。
      // agent_budget_usage：每用户每本地日的主动通知预算与抑制计数（day 是用户本地日历日，
      // 服务层以 Intl.DateTimeFormat 解析，计数在用户本地午夜归零；仅计主动发送）。
      // agent_notification_claims：发送认领台账（reminder_send_claims 的 agent 版），认领用
      // INSERT...ON CONFLICT DO NOTHING，重复认领命中 0 行即跳过；window_bucket =
      // floor(epochMs/windowMs)。agent_digest_folds：预算耗尽/静音时段时非紧急 routine 内容
      // 折叠于此，下次收件箱日报消费（consumed_at IS NULL），本表内容永不单独投递。
      // agent_neon_budget_alerts：vercel Neon CU-hour 告警台账（docker 部署无害保留）。
      version: 60,
      name: 'notification_budget_v60',
      sql: `CREATE TABLE IF NOT EXISTS agent_budget_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_agent_budget_usage_day ON agent_budget_usage (day);

CREATE TABLE IF NOT EXISTS agent_notification_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CONSTRAINT agent_notification_claims_scope_check CHECK (scope IN ('dedupe', 'routine_cooldown')),
  claim_key TEXT NOT NULL,
  window_bucket BIGINT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, scope, claim_key, window_bucket)
);
CREATE INDEX IF NOT EXISTS idx_agent_notification_claims_user ON agent_notification_claims (user_id, claimed_at DESC);

CREATE TABLE IF NOT EXISTS agent_digest_folds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id TEXT,
  notification_class TEXT NOT NULL DEFAULT 'routine',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_digest_folds_pending ON agent_digest_folds (user_id, created_at ASC) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_neon_budget_alerts (
  month TEXT NOT NULL,
  threshold_percent INTEGER NOT NULL,
  cu_hours DOUBLE PRECISION,
  alerted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (month, threshold_percent)
);`,
    },
    {
      // v61（vercel tasks 122-123）: routine 投递幂等 + 审计（agent_routine_artifacts）。
      // 每用户每天每 routine 一条：idempotency_key = '<routine>:<YYYY-MM-DD>'，
      // UNIQUE (user_id, idempotency_key) 是每日一次投递守卫。payload 存正文背后的结构化
      // 事实 + 叙述标志，回喂后续日报。partial index 服务"已认领未投递"的过期回收清扫。
      version: 61,
      name: 'routine_artifacts_v61',
      sql: `CREATE TABLE IF NOT EXISTS agent_routine_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- routine 种类（morning_brief / evening_review / ...），无 FK —— 种类即代码。
  routine TEXT NOT NULL,
  -- 该 artifact 覆盖的用户本地日历日（YYYY-MM-DD）。
  local_date TEXT NOT NULL,
  -- '<routine>:<YYYY-MM-DD>'，每用户唯一，即每日一次投递守卫。
  idempotency_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- 正文背后的结构化事实 + 叙述标志。
  payload TEXT NOT NULL DEFAULT '{}',
  delivered INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  channel TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_routine_artifacts_user_date
  ON agent_routine_artifacts (user_id, local_date DESC);

-- 过期回收清扫（已认领但从未投递）的部分索引。
CREATE INDEX IF NOT EXISTS idx_agent_routine_artifacts_pending
  ON agent_routine_artifacts (created_at) WHERE delivered = 0;`,
    },
    {
      // v62（vercel routines 122-125）: hourly-triage / weekly-review 的去重记忆
      // （agent_triage_state）。hourly triage 观察、weekly review 摘要，二者必须对"已经给
      // 用户看过什么"达成一致。每 (user, item fingerprint) 一行持久记忆：fingerprint 稳定键
      // （如 event:42），last_seen_at 保新鲜度，last_surfaced_at 是抑制锚点（去重窗口内跳过，
      // 除非重要度升级），surfaced_count 实际展示次数，digest_week 是最近一次进周报的 ISO 周
      // （NULL = 从未摘要，同周重跑产出同一份摘要）。
      version: 62,
      name: 'triage_state_v62',
      sql: `CREATE TABLE IF NOT EXISTS agent_triage_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  title TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  band TEXT NOT NULL DEFAULT 'fyi',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_surfaced_at TEXT,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  last_surface_kind TEXT,
  digest_week TEXT,
  UNIQUE (user_id, fingerprint)
);

-- 两个 routine 的扫描/查找支持（有界、索引友好读取）。
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_recent
  ON agent_triage_state (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_surfaced
  ON agent_triage_state (user_id, last_surfaced_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triage_state_week
  ON agent_triage_state (user_id, digest_week);`,
    },
    {
      // v63（vercel tasks 126/127）: agent 决策卡 + 持久反馈策略记忆。agent_decision_cards
      // 是 human-in-the-loop 提案（任务 126）：批准前绝不改用户数据，exactly-once 由单条原子
      // 认领保证（UPDATE...SET status='approved' WHERE status='pending'，输者更新 0 行，
      // API 回 409 already_decided）。agent_feedback 是持久记忆（任务 127）：每次批准/编辑/
      // 拒绝（含可选"为什么"）与每条纠错落库，并在 user_patterns（kind='decision_feedback'）
      // 派生一行提升挖掘器置信度。同一 subject 最近一行即生效策略；极性翻转记为 conflict。
      // 反馈记忆永不覆盖硬设置（静音时段、通知预算）——见 feedback.service.ts HARD_SETTING_SUBJECTS。
      version: 63,
      name: 'agent_feedback_v63',
      sql: `CREATE TABLE IF NOT EXISTS agent_decision_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 类型化 subject kind；只有出现在 DECISION_SUBJECT_KINDS 里的 kind 才有 resolver，
  -- 未知 kind 永远无法被执行（注入守卫）。
  subject_kind TEXT NOT NULL,
  -- 稳定的人机可读 subject，如 'contact:12+34'，是反馈记忆与策略摘要的抑制键。
  subject_ref TEXT,
  -- 创建时为 'propose'；保留成列以便未来动作种类（如 'question'）无需改表。
  action TEXT NOT NULL DEFAULT 'propose',
  summary TEXT NOT NULL DEFAULT '',
  -- 完整提案变更；批准时对照 resolver 白名单校验——绝不盲执行。
  payload TEXT NOT NULL DEFAULT '{}',
  -- 调用方提供的幂等键：重复提案同一变更返回既有卡片而不是再建（再通知）一张。
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'target_missing', 'expired')),
  -- 提问卡（agent 向用户提问）有独立每日上限，与通知预算分开。
  is_question INTEGER NOT NULL DEFAULT 0,
  -- 决定时记录的可选"为什么"备注。
  rationale TEXT,
  -- 编辑决策：用户调整后的 payload 合并到 payload 之上。
  edit_payload TEXT,
  -- resolver 运行结果：{ status, detail, applied_at }。
  resolution TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  UNIQUE (user_id, idempotency_key)
);

-- 待决卡片列表（API + bot）与提问卡日计数。
CREATE INDEX IF NOT EXISTS idx_agent_decision_cards_user_status
  ON agent_decision_cards (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decision_cards_user_question
  ON agent_decision_cards (user_id, is_question, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'decision'（卡片的批准/编辑/拒绝）| 'correction'（自由纠错）。
  kind TEXT NOT NULL,
  -- 反馈 subject；对应 agent_decision_cards.subject_ref（未给 ref 时为 subject kind）。抑制键。
  subject TEXT NOT NULL,
  -- 'approve' | 'edit' | 'reject' | 'correct'。
  action TEXT NOT NULL,
  -- 可选"为什么"备注，原样持久化（上游限长）。
  rationale TEXT,
  -- 产生该反馈的卡片（如适用）；仅审计用途。
  decision_card_id BIGINT REFERENCES agent_decision_cards(id) ON DELETE SET NULL,
  -- 机器细节（编辑后 payload、target_missing 标志、conflict_with、...）。
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 每 subject 最近一行查找（策略检查、摘要、冲突消解）。
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_subject
  ON agent_feedback (user_id, subject, created_at DESC);
-- 有界策略摘要的近期窗口扫描。
CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_created
  ON agent_feedback (user_id, created_at DESC);`,
    },
    {
      // v64（vercel tasks 135/142）: 去重候选 + 破坏性变更审计（带 TTL 的 exactly-once 撤销）。
      // audit_events：每次破坏性变更（delete/merge/bulk_edit/archive）一行，actor、脱敏的
      // 前后快照、撤销截止时刻；只经 audit.service.recordAudit() 写入（token/秘钥永不入库）。
      // audit_undo_snapshots：exactly-once 撤销。snapshot 存可恢复行组；undo_token 是暴露给
      // 用户/bot 的 TTL 令牌；consumed_at 即原子认领（UPDATE...WHERE consumed_at IS NULL AND
      // expires_at > CURRENT_TIMESTAMP），第二次撤销更新 0 行，API 回 409。撤销只写白名单表
      // （events、fixed_contacts、todo_completions、interactions）。任务 135 的去重扫描器只
      // "提案"合并（决策卡），本表族不触发任何删除。
      version: 64,
      name: 'dedupe_audit_v64',
      sql: `CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'delete' | 'merge' | 'bulk_edit' | 'archive'（AUDIT_ACTIONS）。
  action TEXT NOT NULL,
  -- 受影响行的域，如 'event' | 'contact' | 'todo'。
  entity_kind TEXT NOT NULL,
  -- 受影响实体的稳定 id（数字/字符串数组）。
  entity_ids TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  -- 变更归属的人类用户（agent/bot 代其行事）。
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'api' | 'bot' | 'agent' | 'decision_card' | ...
  actor_via TEXT NOT NULL DEFAULT 'api',
  -- 脱敏 payload 快照；绝无原始秘钥（见 redactForAudit）。
  before_snapshot TEXT NOT NULL DEFAULT '{}',
  after_snapshot TEXT NOT NULL DEFAULT '{}',
  -- 从快照行复制的截止时刻，列表视图单次扫描即可得。
  undo_expires_at TEXT,
  undone_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created
  ON audit_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_action
  ON audit_events (user_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_expiry
  ON audit_events (user_id, undo_expires_at);

CREATE TABLE IF NOT EXISTS audit_undo_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_event_id BIGINT NOT NULL REFERENCES audit_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- {version, truncated, groups:[{table, mode:'reinsert'|'revert', rows:[...]}]}
  snapshot TEXT NOT NULL DEFAULT '{"version":1,"truncated":false,"groups":[]}',
  -- 不透明 TTL 令牌（32 随机字节 base64url），每快照唯一。
  undo_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- 原子 exactly-once 认领；NULL = 撤销仍可用。
  consumed_at TEXT,
  -- 成功恢复的结果明细：{restored, groups:[...]}。
  restored TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (audit_event_id),
  UNIQUE (undo_token)
);

CREATE INDEX IF NOT EXISTS idx_audit_undo_snapshots_user_expiry
  ON audit_undo_snapshots (user_id, expires_at);`,
    },
    {
      // v65（vercel task 137）: 数据健康一键修复台账（data_health_repairs）。每次成功修复
      // 额外写一行（尽力而为），repaired_count 是修复触及的行数；confirmed 记录破坏性修复
      // 是否被调用方显式确认。修复幂等，对已干净数据集重跑会追加 repaired_count = 0 的行。
      version: 65,
      name: 'data_health_v65',
      sql: `CREATE TABLE IF NOT EXISTS data_health_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_data_health_repairs_user ON data_health_repairs (user_id, created_at DESC);`,
    },
    {
      // v67（vercel tasks 140-141）: 周期性 routine 模板 + 步骤 + 实例化认领。
      // routine_templates 是命名的 routine（每用户）；routine_template_steps 是有序步骤
      //（payload 存各 kind 选项）；routine_template_instances 兼做幂等与审计：
      // UNIQUE (user_id, template_id, slot_key) 使双击成为 no-op —— instantiate 先以
      // ON CONFLICT DO NOTHING 插入认发行，认领成功才创建条目，整个单元一个事务。
      version: 67,
      name: 'routine_templates_v67',
      sql: `CREATE TABLE IF NOT EXISTS routine_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- 内置预设（每周大扫除 / 旅行准备 / 月度报表）以 1 播种。
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_routine_templates_user
  ON routine_templates (user_id, name);

CREATE TABLE IF NOT EXISTS routine_template_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES routine_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  -- event | todo | habit | maintenance（todo 步骤底层就是 event：本应用可完成的 todo
  -- 就是其提醒窗口内的 event）。
  kind TEXT NOT NULL CONSTRAINT routine_template_steps_kind_check
    CHECK (kind IN ('event', 'todo', 'habit', 'maintenance')),
  title TEXT NOT NULL,
  -- 各 kind 选项：dateOffsetDays、eventType、reminder、recurring、habitId/habit、
  -- maintenancePlanId/maintenance、profileId。
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_routine_template_steps_template
  ON routine_template_steps (template_id, position, id);

CREATE TABLE IF NOT EXISTS routine_template_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES routine_templates(id) ON DELETE CASCADE,
  -- 槽位身份：调用方给的槽位，否则锚定日期（用户本地今天）。
  slot_key TEXT NOT NULL,
  anchor_date TEXT NOT NULL,
  -- 每条目创建报告（stepId -> 创建/关联实体），JSON 数组。
  report TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, template_id, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_routine_template_instances_user_template
  ON routine_template_instances (user_id, template_id, created_at DESC);`,
    },
    {
      // v69（vercel tasks 144/147）: 入站订阅源摄取（导出线不需要表）。
      // feed_sources 是入站源登记表（kind='ics' 为轮询外部日历 URL；kind='mail' 为入站
      // 邮箱）。注意与 ics_feeds(v48) 方向相反：那是出站公开订阅。trusted 是每源开关：
      // trusted 源可直接应用；untrusted（默认）只产提案。
      // feed_ingest_proposals 是 human-in-the-loop 队列：行翻到 accepted 前不创建任何
      // event/contact；accept 是单条原子认领（UPDATE...WHERE status='pending'，输者 0 行 → 409）。
      // (user_id, source_kind, dedupe_key) 唯一 = 重同步幂等。
      // feed_ingest_seen 是跨重启的去重记忆：ICS 以 UID + DTSTART 为契约 —— 全新
      // (uid, dtstart_key) 提案 event_new；已知 uid 配不同 dtstart_key 提案 event_changed；
      // 其余组合为重复跳过。mail 以 Message-ID + 候选序号为键。(source_id, dedupe_key) 唯一
      // = 重摄取幂等。
      version: 69,
      name: 'feeds_export_v69',
      sql: `CREATE TABLE IF NOT EXISTS feed_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'ics' = 轮询的外部日历 URL；'mail' = 入站 RFC822 邮箱。
  kind TEXT NOT NULL CHECK (kind IN ('ics', 'mail')),
  name TEXT NOT NULL DEFAULT '',
  -- 仅 ICS：外部源 URL（运营方须把主机加入 EGRESS_ALLOWED_HOSTS 才放行 fetch）。
  url TEXT,
  -- 仅 ICS：调度器重轮询间隔（分钟）。
  poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
  -- 仅 mail：该邮箱期望收件的地址（参考信息）。
  mail_address TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- trusted = 直接应用（仍记为已接受提案）；untrusted（默认）= 仅提案，绝不静默写用户数据。
  trusted INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feed_sources_user
  ON feed_sources (user_id, enabled, kind);

CREATE TABLE IF NOT EXISTS feed_ingest_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES feed_sources(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event_new', 'event_changed', 'contact_new')),
  -- ICS: UID|<DTSTART>；mail: Message-ID#<index>。
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  -- 接受时重新校验的类型化 payload（绝不盲执行）。
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  UNIQUE (user_id, source_kind, dedupe_key)
);

-- 待处理队列列表（新在前）+ 状态过滤。
CREATE INDEX IF NOT EXISTS idx_feed_ingest_proposals_user_status
  ON feed_ingest_proposals (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_ingest_seen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES feed_sources(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  -- ICS: VEVENT UID（跨重同步的稳定身份）。
  uid TEXT,
  -- ICS: DTSTART token（全天 'YYYYMMDD' 或 'YYYYMMDDTHHMMSSZ'）。
  dtstart_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, dedupe_key)
);

-- 变更检测：找出某 UID 已知的所有 DTSTART。
CREATE INDEX IF NOT EXISTS idx_feed_ingest_seen_source_uid
  ON feed_ingest_seen (source_id, uid);`,
    },
    {
      // v70（vercel tasks 146/148/149）: OCR 结果 + 家庭分享令牌 + 远端备份配置/记录。
      // ocr_results：可选 OCR，每次抽取尝试一行，挂到属主文档和/或源附件；原文有界存储
      // （excerpt）+ 结构化字段 JSON。OCR 默认关闭。
      // share_tokens：只读家庭分享，原文 token 只展示一次，仅存 SHA-256 哈希；scope 是
      // profile | tag | household_list 之一，可选口令同样存哈希；expires_at/revoked_at 管门禁。
      //   SQLite 差异：vercel 在 v73 才把 scope_type 的 CHECK 从 ('profile','tag') 扩容到含
      //   'household_list'（PG 可 DROP CONSTRAINT 再重加；SQLite 无法 DROP CONSTRAINT），
      //   docker 链路建表时即按终态写 CHECK（见 v73 注释），终态与 vercel 完全一致。
      // remote_backup_configs：WebDAV/S3 目标，每用户一行；凭据以共享 crypto 工具（MASTER_KEY）
      // 加密落库，明文不存不记日志。remote_backup_records：每次 backup/restore/list/prune
      // 的追加式尝试日志。
      version: 70,
      name: 'ocr_share_remote_backup_v70',
      sql: `CREATE TABLE IF NOT EXISTS ocr_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 属主文档（优先）—— 独立抽取时为 NULL。
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  -- 字节来自文档库时的源附件。
  attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  -- 产出该行的引擎（如 'tesseract'）；禁用时为 'none'。
  engine TEXT NOT NULL,
  -- 'extracted' | 'disabled' | 'failed'
  status TEXT NOT NULL,
  content_type TEXT,
  byte_size INTEGER,
  -- 有界文本节选；绝非完整文档正文。
  text_excerpt TEXT,
  -- 结构化字段：{ issuer, date, total, currency }（均可空）。
  fields TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ocr_results_user_document
  ON ocr_results (user_id, document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_results_user_created
  ON ocr_results (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS share_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 高熵原文 token 的 SHA-256 十六进制 —— 唯一持久化形态。
  token_hash TEXT NOT NULL UNIQUE,
  -- 'profile' | 'tag' | 'household_list'（household_list 为 v73 扩容，docker 建表即按终态）。
  scope_type TEXT NOT NULL CHECK (scope_type IN ('profile', 'tag', 'household_list')),
  -- scope_type = 'profile' 时出现（属主校验在服务层）。
  scope_profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  -- scope_type = 'tag' 时出现（events.tags / 联系人标签中的值）。
  scope_tag TEXT,
  label TEXT,
  -- 可选口令的 SHA-256 十六进制；NULL = 无需口令。
  passcode_hash TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_user_created
  ON share_tokens (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_backup_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- 'webdav' | 's3'
  target_type TEXT NOT NULL CHECK (target_type IN ('webdav', 's3')),
  -- WebDAV 基础 URL / S3 兼容端点。任何调用前其主机必须在出口允许清单上。
  endpoint TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '',
  -- 仅 S3。
  bucket TEXT,
  region TEXT,
  access_key_id TEXT,
  -- 仅 WebDAV。
  username TEXT,
  -- 加密的 WebDAV 密码 / S3 secret access key。绝不序列化进响应，绝不记日志。
  secret_encrypted TEXT,
  retention_count INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS remote_backup_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'backup' | 'restore' | 'list' | 'prune'
  kind TEXT NOT NULL,
  -- 'success' | 'dry_run' | 'failure'
  status TEXT NOT NULL,
  target_type TEXT,
  object_key TEXT,
  byte_size BIGINT,
  retention_deleted INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_remote_backup_records_user_created
  ON remote_backup_records (user_id, created_at DESC);`,
    },
    {
      // v71（vercel tasks 151/152）: 天气设置/跨实例缓存 + 包裹追踪。
      // user_weather_settings：用户存的天气位置（选择性加入），每用户一行；缺行 = 未配置，
      // 服务降级为"天气不可用"。weather_cache：Open-Meteo 的跨实例上游缓存；fetched_at 是
      // 载荷新鲜度时钟，attempted_at 是 5 分钟外呼下限（无论成败，前次尝试未过期就不再打上游，
      // 失败时以 stale 供旧载荷）。parcels：手动状态更新覆盖 status + last_event；追踪号是
      // 用户秘密，只经 maskTrackingNumber() 记日志。
      version: 71,
      name: 'weather_parcels_v71',
      sql: `CREATE TABLE IF NOT EXISTS user_weather_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  location_label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS weather_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parcels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered'
    CONSTRAINT parcels_status_check CHECK (status IN ('registered', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  last_event TEXT,
  last_event_at TEXT,
  eta TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, carrier, tracking_number)
);
CREATE INDEX IF NOT EXISTS idx_parcels_user_status ON parcels (user_id, status);`,
    },
    {
      // v72（vercel tasks 153/154/155）: 考勤/工时 + 儿童老人照护 + 宠物照护。
      // timesheet_sessions：一个工作时段一行，clock_out IS NULL 标记唯一进行中时段；
      // 部分唯一索引是重复打卡的硬保证（第二次打卡 409）。
      // timesheet_leaves：缺勤/请假记录。care_profiles + care_logs：照护对象与事件
      //（喂养/服药/体征/情绪/意外），刻意命名 care_logs 避免与用药域撞名。
      // pets + pet_logs：体重/喂养/就诊史。pet_schedules：疫苗/驱虫排程，一次性排程置
      // completed_at 退役；周期排程（interval_days 非空）完成时前滚 due_date。
      version: 72,
      name: 'timesheet_care_pets_v72',
      sql: `CREATE TABLE IF NOT EXISTS timesheet_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clock_out TEXT,
  note TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT timesheet_sessions_range_check CHECK (clock_out IS NULL OR clock_out > clock_in)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_timesheet_open_session
  ON timesheet_sessions (user_id) WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS idx_timesheet_sessions_user_clock_in
  ON timesheet_sessions (user_id, clock_in);

CREATE TABLE IF NOT EXISTS timesheet_leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'leave'
    CONSTRAINT timesheet_leaves_kind_check CHECK (kind IN ('absence', 'leave', 'sick', 'holiday', 'other')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT timesheet_leaves_range_check CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_timesheet_leaves_user_start
  ON timesheet_leaves (user_id, start_date);

CREATE TABLE IF NOT EXISTS care_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT '',
  date_of_birth TEXT,
  allergies TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_care_profiles_user ON care_profiles (user_id);

CREATE TABLE IF NOT EXISTS care_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES care_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT care_logs_kind_check CHECK (kind IN ('feeding', 'dose', 'vitals', 'mood', 'incident')),
  logged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  label TEXT NOT NULL DEFAULT '',
  value NUMERIC,
  unit TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_care_logs_profile_logged_at
  ON care_logs (profile_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_logs_user_kind_logged_at
  ON care_logs (user_id, kind, logged_at DESC);

CREATE TABLE IF NOT EXISTS pets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT '',
  breed TEXT NOT NULL DEFAULT '',
  birth_date TEXT,
  weight_kg NUMERIC(6, 2),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pets_user ON pets (user_id);

CREATE TABLE IF NOT EXISTS pet_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT pet_logs_kind_check CHECK (kind IN ('weight', 'feeding', 'vet')),
  logged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  weight_kg NUMERIC(6, 2),
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pet_logs_pet_kind_logged_at
  ON pet_logs (pet_id, kind, logged_at DESC);

CREATE TABLE IF NOT EXISTS pet_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT pet_schedules_kind_check CHECK (kind IN ('vaccination', 'deworming')),
  name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  interval_days INTEGER,
  reminder_days_before INTEGER NOT NULL DEFAULT 14,
  completed_at TEXT,
  last_completed_at TEXT,
  completion_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pet_schedules_interval_check CHECK (interval_days IS NULL OR interval_days > 0),
  CONSTRAINT pet_schedules_reminder_check CHECK (reminder_days_before >= 0)
);
CREATE INDEX IF NOT EXISTS idx_pet_schedules_user_due
  ON pet_schedules (user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_pet_schedules_pet_due
  ON pet_schedules (pet_id, due_date);`,
    },
    {
      // v73（vercel tasks 156/157/158）: 车辆油/保养台账 + 影音书游戏清单 + 家庭协作清单。
      // watchlist_items：release_date 在未来且状态 wanted/in_progress 的行喂给共享分钟级
      // cron 提醒迭代器，不加第二个调度器。household_lists 刻意独立于 inventory_items
      // 库存域（不同表名、不同生命周期）。
      // share_tokens 扩容：scope_list_id 列走 postMigrate tryExec；scope_type CHECK 的
      // 'household_list' 扩容已在 v70 建表时按终态写入（SQLite 无法 DROP CONSTRAINT，
      // vercel 的 DROP+ADD 约束循环无对应物，终态一致）。
      version: 73,
      name: 'vehicle_watchlist_household_v73',
      sql: `CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  year INTEGER CHECK (year IS NULL OR (year >= 1886 AND year <= 2100)),
  plate TEXT NOT NULL DEFAULT '',
  odometer INTEGER NOT NULL DEFAULT 0 CHECK (odometer >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS vehicle_fuel_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  recorded_on TEXT NOT NULL,
  energy_type TEXT NOT NULL DEFAULT 'fuel' CHECK (energy_type IN ('fuel', 'electric')),
  quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 3) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  total_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  odometer INTEGER NOT NULL CHECK (odometer >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_fuel_vehicle ON vehicle_fuel_records (vehicle_id, odometer DESC);

CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  serviced_on TEXT NOT NULL,
  odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
  cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  next_due_date TEXT,
  next_due_odometer INTEGER CHECK (next_due_odometer IS NULL OR next_due_odometer >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_vehicle
  ON vehicle_maintenance_records (vehicle_id, serviced_on DESC);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('film', 'series', 'book', 'game', 'other')),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'wanted' CHECK (status IN ('wanted', 'in_progress', 'done', 'dropped')),
  release_date TEXT,
  source TEXT,
  link TEXT,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  note TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  reminder_config TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_status ON watchlist_items (user_id, status);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_release ON watchlist_items (user_id, release_date);

CREATE TABLE IF NOT EXISTS household_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_household_lists_user ON household_lists (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS household_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES household_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  checked INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_household_list_items_list
  ON household_list_items (list_id, checked, created_at);`,
      postMigrate: async () => {
        // 每清单分享链接复用 share_tokens，新增清单引用列（CHECK 扩容见 v70/v73 注释）。
        await tryExec('v73 share_tokens.scope_list_id', 'ALTER TABLE share_tokens ADD COLUMN scope_list_id BIGINT');
      },
    },
    {
      // v74（vercel tasks 159/160）: 双向日历同步账号 + 单属主协作邀请。
      // calendar_sync_accounts：每用户外部日历目标（caldav / exchange 适配缝）；凭据以共享
      // crypto（MASTER_KEY）加密落库，密文不回显不记日志；direction 管 pull/push/both，
      // enabled 可暂停账号而不删除。
      // calendar_sync_events：幂等 + 冲突台账。UNIQUE (account_id, calendar_id, external_uid)
      // 使重拉为 no-op；external_version（ETag/changeKey）与 local_version（内容哈希）是上次
      // 同步两侧的版本；losing_version 记录被冲突策略丢弃的版本（默认 last-write-wins）。
      // collaboration_invites：单属主、仅限邀请的访客——只有一个 owner_user_id，访客是持有
      // token 的 email/link 而非账号；原文 token 只展示一次，仅存哈希；role 三级，
      // scope_* 圈定可见面。collaboration_activity：协作者变更的追加式动态，凭据与原文
      // token 永不入库。
      version: 74,
      name: 'calendar_sync_collaboration_v74',
      sql: `CREATE TABLE IF NOT EXISTS calendar_sync_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'caldav' | 'exchange'
  kind TEXT NOT NULL CHECK (kind IN ('caldav', 'exchange')),
  -- 外部日历集合/端点根。任何出站调用前其主机必须先过出口守卫。
  base_url TEXT NOT NULL,
  -- HTTP basic / CalDAV 登录名。非机密，但绝不与凭据一起回显。
  username TEXT,
  -- 加密的密码/应用密码/bearer token。目标无需凭据时为 NULL。
  credentials_encrypted TEXT,
  -- 远端日历/集合 id（CalDAV 集合路径或 Exchange 文件夹）。
  calendar_id TEXT NOT NULL DEFAULT 'default',
  -- 'pull' | 'push' | 'both'
  direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('pull', 'push', 'both')),
  -- 'last_write_wins'（默认）| 'local_wins' | 'remote_wins'
  conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
    CHECK (conflict_policy IN ('last_write_wins', 'local_wins', 'remote_wins')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_accounts_user
  ON calendar_sync_accounts (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS calendar_sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES calendar_sync_accounts(id) ON DELETE CASCADE,
  -- 稳定外部身份。重拉按 (account_id, calendar_id, external_uid) 去重。
  external_uid TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'default',
  -- 该外部对象映射的本地 event（导入前为 NULL）。
  local_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  -- 上次同步的远端版本：ETag / Exchange changeKey。
  external_version TEXT,
  -- 上次同步的本地内容哈希（name + date + type）。
  local_version TEXT,
  -- 被冲突策略丢弃的版本（审计轨迹）；无冲突时为 NULL。
  losing_version TEXT,
  last_direction TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, calendar_id, external_uid)
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_events_account
  ON calendar_sync_events (account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_events_local
  ON calendar_sync_events (user_id, local_event_id);

CREATE TABLE IF NOT EXISTS collaboration_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 全部数据的唯一属主。访客绝不是 users 表的行。
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_email TEXT,
  -- 'viewer' | 'commenter' | 'editor'
  role TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  -- 范围：profile、tag、实体类型的任意组合。空 scope_entity_types = 所选 profile/tag 的
  -- "全部受支持实体类型"；无 profile 且无 tag 时仅按实体类型圈界。
  scope_profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  scope_tag TEXT,
  scope_entity_types TEXT NOT NULL DEFAULT '[]',
  -- 高熵原文邀请 token 的 SHA-256 十六进制 —— 唯一持久化形态。
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  accepted_at TEXT,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_collaboration_invites_owner
  ON collaboration_invites (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'owner' | 'guest'
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'guest')),
  actor_label TEXT,
  invite_id INTEGER REFERENCES collaboration_invites(id) ON DELETE SET NULL,
  -- 'invite_created' | 'invite_revoked' | 'guest_viewed' | 'guest_commented'
  -- | 'guest_event_created' | 'guest_write_denied'
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_collaboration_activity_owner
  ON collaboration_activity (owner_user_id, created_at DESC, id DESC);`,
    },
    {
      // v75（vercel task 168）: 生日祝福链接 —— events.contact_id + fixed_contacts.greeting_opt_out。
      // SQLite 无 ADD COLUMN IF NOT EXISTS，走 postMigrate tryExec（列不在 schema.sql，新库必成）。
      version: 75,
      name: 'birthday_link_v75',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v75 events.contact_id', 'ALTER TABLE events ADD COLUMN contact_id INTEGER REFERENCES fixed_contacts(id) ON DELETE SET NULL');
        await tryExec('v75 fixed_contacts.greeting_opt_out', 'ALTER TABLE fixed_contacts ADD COLUMN greeting_opt_out INTEGER NOT NULL DEFAULT 0');
      },
    },
    {
      // v76: TOTP 恢复码。2FA 开启后登录硬性要求 TOTP 码且是单用户应用——
      // 丢失认证器意味着账号永久丢失。恢复码以 SHA-256 哈希存 JSON 数组。
      version: 76,
      name: 'totp_recovery_codes_v76',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v76 users.totp_recovery_codes', `ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT NOT NULL DEFAULT '[]'`);
      },
    },
    {
      // v77: 把遗留 'email' 渠道并入 'resend'。投递侧一直把两者同等对待，但 'email' 没有
      // UI 模板，导致 type='email' 的账号与事件选择"活跃却不可见"。改型后以零行为变化纳入
      // 'resend' 模板管理。历史触发日志不动（审计记录）。'email' 别名保留在派发链兜底
      // （覆盖代码先部署、迁移后执行的窗口行）。
      // 翻译：::text/::jsonb 去除；@> '["email"]' 包含判定 → json_each EXISTS，
      // 另加 json_valid 守卫防个别脏行使整条迁移失败。
      version: 77,
      name: 'fold_email_channel_v77',
      sql: `UPDATE notification_accounts SET type = 'resend' WHERE type = 'email';
UPDATE events SET notification_channels = REPLACE(notification_channels, '"email"', '"resend"')
  WHERE notification_channels IS NOT NULL AND json_valid(notification_channels)
    AND EXISTS (SELECT 1 FROM json_each(notification_channels) WHERE value = 'email');`,
    },
    {
      // v78: 通知可达性。连续 3 次失败不再硬禁用账号（那会把它从所有 resolver 静默摘掉），
      // 改为停机 24h 自动恢复；另有每用户提醒追赶窗口（分钟；NULL = env/10）与邮件模板风格。
      version: 78,
      name: 'notification_reachability_v78',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v78 notification_accounts.suspended_until', 'ALTER TABLE notification_accounts ADD COLUMN suspended_until TEXT');
        await tryExec('v78 user_configs.reminder_catchup_minutes', 'ALTER TABLE user_configs ADD COLUMN reminder_catchup_minutes INTEGER');
        await tryExec('v78 user_configs.email_template_style', `ALTER TABLE user_configs ADD COLUMN email_template_style TEXT NOT NULL DEFAULT 'classic'`);
        await tryExec('v78 user_configs.fallback_enabled', 'ALTER TABLE user_configs ADD COLUMN fallback_enabled INTEGER NOT NULL DEFAULT 1');
      },
    },
    {
      // v79: AI 生日祝福。每用户祝福模式（auto=当天发送，draft=暂存一键发送）与 AI 开关；
      // 联系人补 birth_date 使无关联生日事件的联系人也能祝福；greeting_history 按
      // 联系人/年份/渠道存最终成文（轮换依据 + 审计）。
      version: 79,
      name: 'ai_birthday_greetings_v79',
      sql: `CREATE TABLE IF NOT EXISTS greeting_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  contact_id INTEGER,
  event_id INTEGER,
  year TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL,
  subject TEXT,
  body_html TEXT,
  recipients TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_greeting_history_user_year ON greeting_history(user_id, year DESC);`,
      postMigrate: async () => {
        await tryExec('v79 user_configs.greeting_mode', `ALTER TABLE user_configs ADD COLUMN greeting_mode TEXT NOT NULL DEFAULT 'auto'`);
        await tryExec('v79 user_configs.greeting_ai_enabled', 'ALTER TABLE user_configs ADD COLUMN greeting_ai_enabled INTEGER NOT NULL DEFAULT 1');
        await tryExec('v79 fixed_contacts.birth_date', 'ALTER TABLE fixed_contacts ADD COLUMN birth_date TEXT');
      },
    },
    {
      // v80: 日志保留与有界 cron 状态。
      // - greeting_history 增 source（ai|composer）与 tone，供祝福 AI 预算闸与按草稿重生成；
      // - digest_archive 存 AI 月报叙述，使原始触发日志可 90 天过期而不丢历史（"AI 留下重要的"）；
      // - cron_job_status 每任务一行 UPSERT（最近结果），取代每分钟成功行；失败细节仍在
      //   cron_execution_logs（30 天）；
      // - 两条热路径索引：/api/health 的 cron 状态查询与触发日志列表排序。
      version: 80,
      name: 'log_retention_and_ai_greetings_v80',
      sql: `CREATE TABLE IF NOT EXISTS digest_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  narrative_md TEXT,
  stats_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_digest_archive_user_period ON digest_archive(user_id, period_start DESC);
CREATE TABLE IF NOT EXISTS cron_job_status (
  job_name TEXT PRIMARY KEY,
  last_status TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT,
  last_summary TEXT,
  last_duration_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cron_executed_at ON cron_execution_logs(executed_at);
CREATE INDEX IF NOT EXISTS idx_trigger_user_created ON event_trigger_logs(user_id, created_at);`,
      postMigrate: async () => {
        await tryExec('v80 greeting_history.source', `ALTER TABLE greeting_history ADD COLUMN source TEXT NOT NULL DEFAULT 'composer'`);
        await tryExec('v80 greeting_history.tone', 'ALTER TABLE greeting_history ADD COLUMN tone TEXT');
      },
    },
    {
      // v81（v2.30 方向 A）: AI 日报/周报自动化。每用户独立的日报/周报开关与投递时刻
      //（用户本地时区，由 /api/cron/digest?period=daily|weekly 端点内逐用户判断是否到点）；
      // 投递渠道复用既有 digest_channel_account_id，不新增列。防重走 digest_archive 查重。
      version: 81,
      name: 'digest_daily_weekly_schedule_v81',
      sql: `SELECT 1;`,
      postMigrate: async () => {
        await tryExec('v81 user_configs.digest_daily_enabled', 'ALTER TABLE user_configs ADD COLUMN digest_daily_enabled INTEGER NOT NULL DEFAULT 0');
        await tryExec('v81 user_configs.digest_daily_time', `ALTER TABLE user_configs ADD COLUMN digest_daily_time TEXT NOT NULL DEFAULT '21:00'`);
        await tryExec('v81 user_configs.digest_weekly_enabled', 'ALTER TABLE user_configs ADD COLUMN digest_weekly_enabled INTEGER NOT NULL DEFAULT 0');
        await tryExec('v81 user_configs.digest_weekly_day', 'ALTER TABLE user_configs ADD COLUMN digest_weekly_day INTEGER NOT NULL DEFAULT 1');
        await tryExec('v81 user_configs.digest_weekly_time', `ALTER TABLE user_configs ADD COLUMN digest_weekly_time TEXT NOT NULL DEFAULT '09:00'`);
      },
    },
    {
      // v82（本 fork 增补，非上游）: 证件类型放开 `bank_card`。
      //
      // 上游 documents.kind 的 CHECK 只有 8 个值，没有银行卡。SQLite 无法修改已有
      // CHECK 约束，只能重建表（官方 12-step 的简化版：建新表 → 显式列拷贝 → 删旧 →
      // 改名 → 重建索引）。显式列名而不是 `SELECT *`，避免列顺序漂移导致串列。
      //
      // 语义边界：本表只存卡号/发卡行/有效期等非密码信息，卡号仍走
      // document_number_encrypted（AES-256-GCM）。取款密码、CVV、网银密码一律归
      // KeePass，不写入本表。
      version: 82,
      name: 'documents_bank_card_v82',
      sql: `CREATE TABLE IF NOT EXISTS documents_v82 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('passport', 'id_card', 'driver_license', 'visa', 'certificate', 'policy', 'contract', 'other', 'bank_card')),
  title TEXT NOT NULL,
  issuer TEXT,
  document_number_encrypted TEXT,
  issued_at TEXT,
  expires_at TEXT,
  country TEXT,
  notes TEXT,
  reminder_config TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO documents_v82
  (id, user_id, profile_id, kind, title, issuer, document_number_encrypted,
   issued_at, expires_at, country, notes, reminder_config, is_active, created_at, updated_at)
SELECT id, user_id, profile_id, kind, title, issuer, document_number_encrypted,
       issued_at, expires_at, country, notes, reminder_config, is_active, created_at, updated_at
FROM documents;
DROP TABLE documents;
ALTER TABLE documents_v82 RENAME TO documents;
CREATE INDEX IF NOT EXISTS idx_documents_user_expires ON documents(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_documents_user_kind ON documents(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_documents_active_expires ON documents(user_id, expires_at) WHERE is_active = 1;`,
    },
  ];

  for (const migration of migrations) {
    if (fromVersion < migration.version) {
      try {
        console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
        db.exec(migration.sql);
        if (migration.postMigrate) {
          await migration.postMigrate(db);
        }
        db.run('INSERT OR REPLACE INTO schema_version (version) VALUES (?)', [migration.version]);
        console.log(`[DB] Migration v${migration.version} applied successfully`);
      } catch (error) {
        console.error(`[DB] Migration v${migration.version} failed:`, error);
      }
    }
  }
}

// The old hardcoded default key used before auto-generation was implemented.
const LEGACY_MASTER_KEY = 'timemark-default-master-key-change-in-production-2026';

/**
 * One-time migration: re-encrypt notification_accounts from legacy key to new key.
 * Runs on startup after schema migrations. Safe to run multiple times (idempotent).
 */
export async function migrateEncryptionKey(): Promise<void> {
  const currentKey = process.env.MASTER_KEY;
  if (!currentKey) {
    console.warn('[Migration] MASTER_KEY not set, skipping encryption migration');
    return;
  }

  // If the current key IS the legacy key, no migration needed
  if (currentKey === LEGACY_MASTER_KEY) {
    return;
  }

  const db = getDb();

  // Migrate notification_accounts
  const encryptedFields = ['webhook', 'token', 'secret', 'chat_id', 'session_data'];
  const stmt = db.prepare('SELECT id, webhook, token, secret, chat_id, session_data FROM notification_accounts');
  const rows: Array<{ id: number; [key: string]: any }> = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as any);
  }
  stmt.free();

  let migratedCount = 0;
  for (const row of rows) {
    const updates: string[] = [];
    const values: any[] = [];

    for (const field of encryptedFields) {
      let value = row[field];
      if (!value) continue;

      // v2.30 合入上游新增守卫：session_data 若被驱动解析成对象先归一化为字符串，
      // 非字符串一律跳过（SQLite 下该列恒为 TEXT，守卫不触发，仅保持与上游一致）。
      if (field === 'session_data' && typeof value === 'object' && value !== null) {
        value = JSON.stringify(value);
      }
      if (typeof value !== 'string') continue;

      // Try decrypting with current key - if it works, already migrated
      try {
        decrypt(value, currentKey);
        continue; // Already encrypted with current key
      } catch {
        // Current key failed
      }

      // Try legacy key
      try {
        const plaintext = decrypt(value, LEGACY_MASTER_KEY);
        const reEncrypted = encrypt(plaintext, currentKey);
        updates.push(`${field} = ?`);
        values.push(reEncrypted);
      } catch {
        // Both keys failed - might be plaintext or corrupted, skip
        continue;
      }
    }

    if (updates.length > 0) {
      values.push(row.id);
      db.run(`UPDATE notification_accounts SET ${updates.join(', ')} WHERE id = ?`, values);
      migratedCount++;
    }
  }

  if (migratedCount > 0) {
    console.log(`[Migration] Migrated ${migratedCount} notification account(s) from legacy key`);
  }

  // Migrate user_configs
  const configFields = [
    'encrypted_resend_key', 'encrypted_github_token', 'encrypted_feishu_webhook',
    'encrypted_wecom_webhook', 'encrypted_dingtalk_webhook', 'encrypted_dingtalk_secret',
    'encrypted_telegram_bot_token', 'encrypted_discord_webhook', 'encrypted_slack_webhook',
    'encrypted_wxpusher_app_token', 'encrypted_wxpusher_uid', 'encrypted_qmsg_key',
    'encrypted_qmsg_qq', 'encrypted_channel_webhooks'
  ];

  const configStmt = db.prepare(`SELECT user_id, ${configFields.join(', ')} FROM user_configs`);
  const configRows: Array<{ user_id: number; [key: string]: any }> = [];
  while (configStmt.step()) {
    configRows.push(configStmt.getAsObject() as any);
  }
  configStmt.free();

  let configMigratedCount = 0;
  for (const row of configRows) {
    const updates: string[] = [];
    const values: any[] = [];

    for (const field of configFields) {
      const value = row[field];
      if (!value) continue;

      // Try decrypting with current key
      try {
        decrypt(value, currentKey);
        continue; // Already encrypted with current key
      } catch {
        // Current key failed
      }

      // Try legacy key
      try {
        const plaintext = decrypt(value, LEGACY_MASTER_KEY);
        const reEncrypted = encrypt(plaintext, currentKey);
        updates.push(`${field} = ?`);
        values.push(reEncrypted);
      } catch {
        // Both keys failed, skip
        continue;
      }
    }

    if (updates.length > 0) {
      values.push(row.user_id);
      db.run(`UPDATE user_configs SET ${updates.join(', ')} WHERE user_id = ?`, values);
      configMigratedCount++;
    }
  }

  if (configMigratedCount > 0) {
    console.log(`[Migration] Migrated ${configMigratedCount} user config(s) from legacy key`);
  }

  if (migratedCount === 0 && configMigratedCount === 0) {
    console.log('[Migration] No legacy-encrypted data found, encryption migration complete');
  }
}
