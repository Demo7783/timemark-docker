// docker 变基 · 阶段 F 启动冒烟：全新 SQLite 库冷启动 + 关键端点实测
// 用法：cd backend && pnpm exec tsx scripts/probe-boot-smoke.mjs
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'smoke-admin-password-1';

rmSync('./data/probe-smoke.db', { force: true });
rmSync('./data/probe-smoke.db.bak', { force: true });

const child = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: './data/probe-smoke.db',
    DEFAULT_ADMIN_PASSWORD: ADMIN_PASSWORD,
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logbuf = '';
child.stdout.on('data', (d) => { logbuf += d; });
child.stderr.on('data', (d) => { logbuf += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('server not healthy in time\n' + logbuf.slice(-3000));
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + detail}`);
  if (!cond) failures++;
}

try {
  const health = await waitHealthy();
  check('health ok', health?.status === 'ok', JSON.stringify(health));
  check('health version 2.30.0', health?.checks?.version === '2.30.0', String(health?.checks?.version));
  check('health db true', health?.checks?.database === true);

  // 登录
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  const loginBody = await login.json();
  check('login ok', login.ok && loginBody?.data?.accessToken, JSON.stringify(loginBody).slice(0, 200));
  const auth = { Authorization: `Bearer ${loginBody?.data?.accessToken}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

  // 事件 CRUD（含 v2.30 字段）
  const created = await fetch(`${BASE}/api/events`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: '冒烟事件', type: 'other', date: '2026-12-01', calendarType: 'gregorian', reminderConfig: { enabled: false, daysBeforeList: [], emailRecipients: [], channels: [], accountIds: [] } }),
  });
  const createdBody = await created.json();
  check('create event', created.ok && createdBody?.data?.id, JSON.stringify(createdBody).slice(0, 200));
  const list = await fetch(`${BASE}/api/events?page=1&pageSize=5`, { headers: auth });
  const listBody = await list.json();
  check('list events', list.ok && Array.isArray(listBody?.data?.events), JSON.stringify(listBody).slice(0, 120));

  // 渠道目录（docker 69）
  const templates = await fetch(`${BASE}/api/channels/templates`, { headers: auth });
  const templatesBody = await templates.json();
  const count = templatesBody?.data?.length;
  check('templates 69', templates.ok && count === 69, String(count));
  check('plugin channel present (whatsapp)', Array.isArray(templatesBody?.data) && templatesBody.data.some((t) => t.id === 'whatsapp'));
  check('nostr present', Array.isArray(templatesBody?.data) && templatesBody.data.some((t) => t.id === 'nostr'));

  // 对外 API 门户：无 token 401
  const v1 = await fetch(`${BASE}/api/v1/events`, { headers: { Authorization: 'Bearer tmt_not-a-token' } });
  check('api/v1 rejects bad token', v1.status === 401 || v1.status === 403, String(v1.status));

  // digest cron：无 CRON_SECRET 拒绝
  const digest = await fetch(`${BASE}/api/cron/digest?period=daily`);
  check('cron digest guarded', digest.status === 401 || digest.status === 403, String(digest.status));

  // 附件存储：本地模式冒烟（storage.local 日志在 server 输出中）
  check('storage.local logged', logbuf.includes('storage.local'), 'missing storage.local event');

  console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${failures}`);
} catch (e) {
  console.error('SMOKE ERROR', e);
  failures++;
} finally {
  child.kill('SIGTERM');
  await sleep(1500);
  child.kill('SIGKILL');
}
process.exit(failures === 0 ? 0 : 1);
