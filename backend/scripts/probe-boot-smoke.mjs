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
    CRON_SECRET: 'smoke-cron-secret',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true, // Windows：pnpm 是 .cmd shim，无 shell 直接 spawn 会 ENOENT
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

function killTree(pid) {
  // Windows：shell:true 下 child.pid 是 cmd.exe，直接 kill 杀不掉 node 孙进程，
  // 会留下占端口的僵尸服务——必须 taskkill 整棵进程树。
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true });
  } else {
    child.kill('SIGKILL');
  }
}

try {
  const health = await waitHealthy();
  check('health ok', health?.status === 'ok', JSON.stringify(health));
  check('health version 2.30.0', health?.checks?.version === '2.30.0', String(health?.checks?.version));
  check('health db true', health?.checks?.database === true);

  // 登录（CSRF：同 Host Origin 即放行——docker LAN 语义）。
  // v2.30：authMode='cookie'，accessToken/refreshToken 走 HttpOnly Set-Cookie，不在 body。
  const ORIGIN = BASE;
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  const loginBody = await login.json();
  const setCookies = login.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies.map((sc) => sc.split(';')[0]).join('; ');
  check('login ok', login.ok && loginBody?.success === true && cookieHeader.length > 0, JSON.stringify(loginBody).slice(0, 160));
  const auth = { Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN };

  // 事件 CRUD（含 v2.30 字段）
  const created = await fetch(`${BASE}/api/events`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: '冒烟事件', type: 'other', date: '2026-12-01', calendarType: 'gregorian', reminderConfig: { enabled: false, daysBeforeList: [], emailRecipients: [], channels: [], accountIds: [] } }),
  });
  const createdBody = await created.json();
  check('create event', created.ok && createdBody?.data?.id, JSON.stringify(createdBody).slice(0, 200));
  const list = await fetch(`${BASE}/api/events?page=1&pageSize=5`, { headers: auth });
  const listBody = await list.json();
  // v2.30：列表直接返回数组（不再包 {events}）
  check('list events', list.ok && Array.isArray(listBody?.data), JSON.stringify(listBody).slice(0, 120));

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

  // digest cron：错误 token 拒绝（401）；未配 CRON_SECRET 时上游 fail-closed 返回 500
  const digest = await fetch(`${BASE}/api/cron/digest?period=daily`, {
    headers: { Authorization: 'Bearer wrong-secret' },
  });
  check('cron digest guarded', digest.status === 401 || digest.status === 403, String(digest.status));

  // 附件存储：本地模式冒烟（storage.local 日志在 server 输出中）
  check('storage.local logged', logbuf.includes('storage.local'), 'missing storage.local event');

  console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED: ${failures}`);
} catch (e) {
  console.error('SMOKE ERROR', e);
  failures++;
} finally {
  killTree(child.pid);
  await sleep(1500);
}
if (failures > 0) {
  console.error('---- server log tail ----');
  console.error(logbuf.slice(-2500));
}
process.exit(failures === 0 ? 0 : 1);
