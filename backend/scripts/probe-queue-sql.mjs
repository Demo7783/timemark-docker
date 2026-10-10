// agent queue SQL 在 sql.js + 中心方言转换器上的端到端冒烟
process.env.DB_PATH = './data/probe-queue.db';

import { waitForDb, query } from '../src/db/index.js';
import { createAgentQueue } from '../src/services/agent/queue.service.js';

await waitForDb();
await query('DROP TABLE IF EXISTS agent_jobs');
await query(`CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id INTEGER,
  kind TEXT,
  payload TEXT,
  priority INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  idempotency_key TEXT,
  run_at TEXT,
  status TEXT DEFAULT 'queued',
  attempt INTEGER DEFAULT 0,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  last_heartbeat_at TEXT,
  result TEXT,
  cost_tokens INTEGER,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT
)`);
await query(`CREATE UNIQUE INDEX agent_jobs_idem ON agent_jobs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

const queue = createAgentQueue({ workerId: 'probe-worker' });

// 1. enqueue（$3::jsonb、$7::timestamptz、部分索引 ON CONFLICT、RETURNING、幂等）
const first = await queue.enqueue('reminder.send', { eventId: 42 }, { userId: 7, priority: 5, idempotencyKey: 'idem-1', runAt: Date.now() - 1000 });
console.log('enqueue#1', JSON.stringify(first));
const dup = await queue.enqueue('reminder.send', { eventId: 42 }, { userId: 7, priority: 5, idempotencyKey: 'idem-1' });
console.log('enqueue#dup(expected created:false, same id)', JSON.stringify(dup));
if (dup.created || dup.id !== first.id) throw new Error('幂等入队失败');

// 2. claimBatch（FOR UPDATE SKIP LOCKED 剥离、ANY($1::uuid[])乱序参数 → json_each、make_interval、withTransaction）
const batch = await queue.claimBatch(3, 60);
console.log('claimBatch', JSON.stringify(batch.map(j => ({ id: j.id.slice(0, 8), leaseExpiresAt: j.leaseExpiresAt }))));
if (batch.length !== 1) throw new Error('claimBatch 应认领 1 个任务');

// 3. heartbeat（now() + make_interval、乱序参数、lease_token 校验）
await queue.heartbeat(batch[0].id, batch[0].leaseToken, 60);

// 4. complete（RETURNING finished_at；读取侧应归一化为 ISO-Z）
const done = await queue.complete(batch[0].id, batch[0].leaseToken, { ok: true }, 123);
console.log('complete', JSON.stringify(done));

// 5. 失败重试路径：入队 → 认领 → fail(retry)
const job2 = await queue.enqueue('digest.build', {}, { userId: 7, runAt: Date.now() - 500 });
const batch2 = await queue.claimBatch(3, 60);
const target = batch2.find(j => j.id === job2.id);
if (!target) throw new Error('第二个任务未被认领');
await queue.fail(target.id, target.leaseToken, 'TRANSIENT', 'boom', 60);
const afterFail = await query('SELECT status, attempt, error_code FROM agent_jobs WHERE id = ?', [job2.id]);
console.log('afterFail', JSON.stringify(afterFail.rows));
if (afterFail.rows[0].status !== 'queued' || afterFail.rows[0].attempt !== 1) throw new Error('失败重试状态错误');

// 6. reclaimExpiredLeases（CASE WHEN + now() + 乱序）
const reclaim = await queue.reclaimExpiredLeases();
console.log('reclaim', JSON.stringify(reclaim));

// 7. 时间读回格式（读取侧 UTC 归一化 = ISO-Z）
const raw = await query('SELECT finished_at, updated_at FROM agent_jobs WHERE id = ?', [batch[0].id]);
console.log('timestamps', JSON.stringify(raw.rows[0]));
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw.rows[0].finished_at)) throw new Error('时间读回未归一化为 ISO-Z');

console.log('PROBE OK — queue SQL 全链路通过');
process.exit(0);
