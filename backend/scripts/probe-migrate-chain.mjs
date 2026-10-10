// 探针：全新 SQLite 库链式执行 schema.sql → v2..v81 全量迁移，并断言终态。
// 用法：cd backend && pnpm exec tsx scripts/probe-migrate-chain.mjs
// 每次运行先删除旧探针库，保证从零库冷启动。
process.env.DB_PATH = './data/probe-migrate.db';

import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = path.resolve('./data/probe-migrate.db');
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(DB_FILE + suffix, { force: true });
}

// 注意：src/db/index.js 在模块顶层读取 DB_PATH，静态 import 会被提升到赋值之前
// （从而指向真实库 timemark.db），必须用动态 import 保证 env 先行。
const { runMigrations } = await import('../src/db/migrate.js');
const { query } = await import('../src/db/index.js');

// 收集迁移失败日志：runner 对每条迁移 try/catch 后继续，MAX(version) 断言兜底静默失败，
// 这里再把 "Migration vNN failed" 全量捞出，确保修到零。
const migrationFailures = [];
const origError = console.error;
console.error = (...args) => {
  const line = args.map((a) => String(a)).join(' ');
  if (/Migration v\d+ failed/.test(line)) migrationFailures.push(line);
  origError(...args);
};

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + detail}`);
  if (!cond) failures++;
}

await runMigrations();
console.error = origError;

// 1. 版本断言：链必须走满 v81
const versionRes = await query('SELECT MAX(version) as version FROM schema_version');
const maxVersion = Number(versionRes.rows[0]?.version ?? 0);
check('schema_version MAX(version) === 81', maxVersion === 81, `got ${maxVersion}`);

// 2. 关键表存在性（sqlite_master）
const EXPECTED_TABLES = [
  'expiry_items',
  'inventory_items',
  'maintenance_plans',
  'documents',
  'habits',
  'goals',
  'profiles',
  'medications',
  'tags',
  'agent_jobs',
  'routine_templates',
  'digest_archive',
  'notification_queue',
  'cron_job_status',
];
const tableRes = await query(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${EXPECTED_TABLES.map(() => '?').join(',')})`,
  EXPECTED_TABLES,
);
const foundTables = new Set(tableRes.rows.map((r) => r.name));
for (const t of EXPECTED_TABLES) {
  check(`table ${t}`, foundTables.has(t));
}

// 3. 关键列存在性（PRAGMA table_info）
const usersCols = await query('PRAGMA table_info(users)');
check(
  'users.totp_recovery_codes',
  usersCols.rows.some((r) => r.name === 'totp_recovery_codes'),
  `users cols: ${usersCols.rows.map((r) => r.name).join(',')}`,
);
const configCols = await query('PRAGMA table_info(user_configs)');
check(
  'user_configs.digest_daily_enabled',
  configCols.rows.some((r) => r.name === 'digest_daily_enabled'),
  `user_configs cols: ${configCols.rows.map((r) => r.name).join(',')}`,
);

// 4. 迁移失败日志扫描（零容忍）
check('no "Migration vNN failed" in output', migrationFailures.length === 0, migrationFailures.join(' | '));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
