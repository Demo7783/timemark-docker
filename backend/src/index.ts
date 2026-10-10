import { serve } from '@hono/node-server';
import 'dotenv/config';
import { createLogger } from './utils/logger.js';
import { waitForDb, query } from './db/index.js';
import { runMigrations, migrateEncryptionKey } from './db/migrate.js';
import { initSecretKeys } from './utils/secrets.js';
import { logStorageStartupStatus } from './services/storage.service.js';
import { migrateFieldEncryption } from './services/field-encryption.service.js';
import { ensureAdminUser } from './vercel-init.js';
import app from './app.js';

// docker 变基：本文件 = 启动引导（密钥/迁移/管理员/调度器/serve/进程守卫）；
// Hono 应用构造在 app.ts。docker 无 VERCEL 分支差异——恒走本地 bootstrap。

const log = createLogger('bootstrap');

async function bootstrap() {

  // 0. 初始化密钥（首次启动自动生成，后续启动从文件读取）
  log.info('Initializing secret keys...');
  initSecretKeys();
  log.info('Secret keys ready');

  // 0.5 附件存储模式：本地卷为 docker 默认生产形态；BLOB token 可切远程对象存储
  logStorageStartupStatus();

  // 1. 等待数据库就绪
  log.info('等待数据库初始化...');
  await waitForDb();
  log.info('数据库就绪');

  // 2. 执行 schema 迁移
  await runMigrations();

  // 2.5 迁移旧密钥加密的数据到新密钥
  await migrateEncryptionKey();

  // 2.6 字段级加密迁移（task 161；与 Vercel 冷启动 vercel-init.ts 保持一致）
  await migrateFieldEncryption();

  // 3. 初始化管理员用户（与 Vercel 冷启动共用同一个实现 vercel-init.ts）
  const userResult = await query('SELECT id FROM users LIMIT 1');
  if (userResult.rows.length === 0) {
    await ensureAdminUser();
  } else {
    log.info('数据库已初始化，已存在用户');
  }

  const port = parseInt(process.env.PORT || '3000');

  // 5. 启动定时任务（docker 常驻进程的职责：容器内置 croner 调度器，
  //    无需外部 cron。任务集 = sendReminders/备份/会话清理/通知重试/队列清理，
  //    与 vercel 的 /api/cron/* 外部触发保持同一批函数来源）。
  if (!process.env.VERCEL) {
    const { startScheduler } = await import('./queue/scheduler.js');
    startScheduler().catch((err: unknown) => log.error(err, 'Scheduler failed to start'));
  }

  // 6. 优雅关闭
  process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down...');
    if (!process.env.VERCEL) {
      const { stopScheduler } = await import('./queue/scheduler.js');
      await stopScheduler();
    }
    const { gracefulShutdown } = await import('./db/index.js');
    gracefulShutdown();
    process.exit(0);
  });

  log.info({ port }, 'Server running');
  serve({ fetch: app.fetch, port });
}

// v2.30 硬化（全链路实测踩坑）：渠道发送链出过一次 fromPromise unhandledRejection
// 直接击穿本地进程。进程级兜底只记日志不退出——单条通知的意外拒绝不该拖死
// 正在服务的其他请求；真正的缺陷仍要沿日志里的 event/stack 修。
process.on('unhandledRejection', (reason) => {
  log.error({ event: 'process.unhandled_rejection', err: reason }, 'Unhandled rejection (logged, process kept alive)');
});
process.on('uncaughtException', (err) => {
  log.fatal(err, 'Uncaught exception (logged, process kept alive)');
});

// Local/Docker: bootstrap the full app (DB init, scheduler, HTTP server)
if (!process.env.VERCEL) {
  bootstrap().catch((err) => {
    log.fatal(err, '启动失败');
    process.exit(1);
  });
}

// Vercel: export the Hono app as default for serverless Functions
export default app;
