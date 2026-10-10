// docker 变基 · 升级路径实测：v2.16 形态旧库（schema.sql + v2..v33 + 种子数据）
// → 新链 runMigrations() → v81，验证数据保全与新增列。
// 用法：cd backend && pnpm exec tsx scripts/probe-upgrade-path.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';

process.env.DB_PATH = './data/probe-upgrade.db';

const SCRATCH_DIR = new URL('../.upgradeprobe/', import.meta.url);
const SCRATCH = SCRATCH_DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LEGACY_TS = SCRATCH + 'migrate-v216.ts';

// 1. 物化 v2.16 的旧 migrate.ts（import 路径改指 src/db）
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const legacySource = execFileSync('git', ['show', '6c14f3e:backend/src/db/migrate.ts'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
writeFileSync(LEGACY_TS, legacySource.replace(/from '\.\/index\.js'/g, "from '../src/db/index.js'"));

// 2. 全新 v2.16 形态库
rmSync('./data/probe-upgrade.db', { force: true });

const { waitForDb, query, getDb } = await import('../src/db/index.js');
const { readFileSync } = await import('node:fs');
const schemaSql = readFileSync(new URL('../../docker/schema.sql', import.meta.url), 'utf8');
await waitForDb();
getDb().exec(schemaSql);
console.log('[upgrade] base schema applied');

const legacy = await import(pathToFileURL(LEGACY_TS).href);
await legacy.runMigrations();
const v33 = await query('SELECT MAX(version) AS v FROM schema_version');
console.log('[upgrade] legacy chain done, version =', v33.rows[0].v);

// 3. 种子数据（v2.16 列形态）
const hash = bcrypt.hashSync('legacy-password-123', 10);
await query(`INSERT INTO users (username, password_hash, created_at) VALUES ('legacy-admin', ?, '2026-08-01 10:00:00')`, [hash]);
await query(`INSERT INTO user_configs (user_id, timezone, default_test_email) VALUES (1, 'Asia/Shanghai', 'legacy@example.com')`);
await query(`INSERT INTO events (user_id, name, type, date, calendar_type, reminder_config, created_at)
             VALUES (1, '旧库生日', 'birthday', '1970-05-05', 'solar', '{}', '2026-08-01 10:00:00')`);
await query(`INSERT INTO notification_accounts (user_id, type, name, token, chat_id, created_at)
             VALUES (1, 'telegram', '旧库TG', 'tok-legacy', 'chat-legacy', '2026-08-01 10:00:00')`);
await query(`INSERT INTO login_logs (user_id, username, ip_address, success, login_time) VALUES (1, 'legacy-admin', '10.0.0.9', 1, '2026-08-01 10:05:00')`);

// 4. 新链迁移到 v81
const modern = await import('../src/db/migrate.js');
await modern.runMigrations();

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + detail}`);
  if (!cond) failures++;
};

const ver = await query('SELECT MAX(version) AS v FROM schema_version');
check('version reaches 81', Number(ver.rows[0].v) === 81, String(ver.rows[0].v));

const user = await query(`SELECT * FROM users WHERE username = 'legacy-admin'`);
check('user preserved', user.rows.length === 1);
check('user password intact', user.rows[0]?.password_hash === hash);

const cfg = await query(`SELECT * FROM user_configs WHERE user_id = 1`);
check('user_configs preserved', cfg.rows.length === 1 && cfg.rows[0].timezone === 'Asia/Shanghai');
check('digest_daily_enabled column exists (v81)', 'digest_daily_enabled' in (cfg.rows[0] ?? {}));
check('digest settings defaulted', Number(cfg.rows[0]?.digest_daily_enabled ?? 0) === 0);

const ev = await query(`SELECT * FROM events WHERE name = '旧库生日'`);
check('event preserved', ev.rows.length === 1 && ev.rows[0].date === '1970-05-05');
check('events.profile_id column exists (v41)', 'profile_id' in (ev.rows[0] ?? {}));

const acct = await query(`SELECT * FROM notification_accounts WHERE name = '旧库TG'`);
check('notification account preserved', acct.rows.length === 1 && acct.rows[0].token === 'tok-legacy');

// v41 profiles 回填：应有每用户默认「我」profile，且旧事件挂到默认 profile
const profiles = await query(`SELECT * FROM profiles`);
check('default profile backfilled (v41)', profiles.rows.length === 1);

// v76 恢复码列
const pragma = await query(`PRAGMA table_info(users)`);
check('users.totp_recovery_codes exists (v76)', pragma.rows.some((c) => c.name === 'totp_recovery_codes'));

// v80 retention：cron_job_status 表存在
const cj = await query(`SELECT name FROM sqlite_master WHERE type='table' AND name='cron_job_status'`);
check('cron_job_status exists (v80)', cj.rows.length === 1);

console.log(failures === 0 ? 'UPGRADE PATH OK' : `UPGRADE PATH FAILED: ${failures}`);

// 自清理：物化的 v2.16 migrate.ts 副本是临时脚手架（Mimosa 会对磁盘上残留的
// 历史 SQL 代码误报「命令注入」——其 db.exec() 是 sql.js 的 SQLite 语句执行，
// 不是 shell；跑完即删，探针库一并清理保持工作区干净）
rmSync(SCRATCH, { recursive: true, force: true });
rmSync('./data/probe-upgrade.db', { force: true });
process.exit(failures === 0 ? 0 : 1);
