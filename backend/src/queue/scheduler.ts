import { Cron } from 'croner';
import { sendReminders, githubBackup, archiveLoginHistory, cleanupSessions } from '../jobs/tasks.js';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { purgeOldTodoCompletions } from '../services/todo.service.js';
import { processNotificationRetries, purgeOldQueueEntries } from '../services/notification-retry.service.js';
import { sendDigestsForAllUsers, type DigestPeriod } from '../services/digest.service.js';
import { pumpSchedulerChain } from '../services/agent/scheduler.workflow.js';

const log = createLogger('scheduler');

let jobs: Cron[] = [];

// Health tracking state
interface SchedulerState {
  lastRun: Date | null;
  lastResult: 'success' | 'error' | null;
  consecutiveFailures: number;
  totalRuns: number;
  startedAt: Date | null;
}

const schedulerState: SchedulerState = {
  lastRun: null,
  lastResult: null,
  consecutiveFailures: 0,
  totalRuns: 0,
  startedAt: null,
};

export function getSchedulerStatus() {
  return {
    ...schedulerState,
    jobCount: jobs.length,
    isRunning: jobs.length > 0,
  };
}

async function runJob(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    log.info({ job: name }, 'Running job');
    await fn();
    schedulerState.lastRun = new Date();
    schedulerState.lastResult = 'success';
    schedulerState.consecutiveFailures = 0;
    schedulerState.totalRuns++;
  } catch (error) {
    schedulerState.lastRun = new Date();
    schedulerState.lastResult = 'error';
    schedulerState.consecutiveFailures++;
    schedulerState.totalRuns++;
    log.error({ job: name, err: error }, 'Job failed');
  }
}

export async function startScheduler(): Promise<void> {
  schedulerState.startedAt = new Date();

  // 每分钟运行一次提醒检查（北京时间）
  // 使用15分钟窗口匹配，确保不会错过提醒时间
  jobs.push(new Cron('* * * * *', { timezone: 'Asia/Shanghai', name: 'reminder-check' }, async () => {
    await runJob('reminder-check', sendReminders);
  }));

  // 每天凌晨2点备份邮件日志（北京时间）
  jobs.push(new Cron('0 2 * * *', { timezone: 'Asia/Shanghai', name: 'daily-email-backup' }, async () => {
    await runJob('daily-email-backup', githubBackup);
  }));

  // 每天凌晨3点归档登录历史（北京时间）
  jobs.push(new Cron('0 3 * * *', { timezone: 'Asia/Shanghai', name: 'daily-login-backup' }, async () => {
    await runJob('daily-login-backup', archiveLoginHistory);
  }));

  // 每小时清理过期会话（北京时间）
  jobs.push(new Cron('0 * * * *', { timezone: 'Asia/Shanghai', name: 'hourly-cleanup' }, async () => {
    await runJob('hourly-cleanup', cleanupSessions);
  }));

  // 每小时清理过期插件会话（北京时间）
  jobs.push(new Cron('30 * * * *', { timezone: 'Asia/Shanghai', name: 'plugin-session-cleanup' }, async () => {
    await runJob('plugin-session-cleanup', async () => {
      const result = await query("DELETE FROM plugin_sessions WHERE expires_at < datetime('now')");
      log.info({ count: result.rowCount ?? 0 }, 'Cleaned up expired plugin sessions');
    });
  }));

  // 每天凌晨 4 点清理 365 天前的 todo 完成记录（北京时间）
  jobs.push(new Cron('0 4 * * *', { timezone: 'Asia/Shanghai', name: 'daily-todo-purge' }, async () => {
    await runJob('daily-todo-purge', async () => {
      const count = await purgeOldTodoCompletions(365);
      log.info({ count }, 'Purged old todo completions');
    });
  }));

  // 每 5 分钟处理通知重试队列（指数退避由队列的 next_retry_at 控制）
  jobs.push(new Cron('*/5 * * * *', { timezone: 'Asia/Shanghai', name: 'notification-retry' }, async () => {
    await runJob('notification-retry', async () => {
      const r = await processNotificationRetries();
      log.info({ processed: r.processed, succeeded: r.succeeded }, 'Processed notification retries');
    });
  }));

  // 每天凌晨 5 点清理 30 天前的通知队列记录
  jobs.push(new Cron('0 5 * * *', { timezone: 'Asia/Shanghai', name: 'notification-queue-purge' }, async () => {
    await runJob('notification-queue-purge', async () => {
      const count = await purgeOldQueueEntries();
      log.info({ count }, 'Purged old notification queue entries');
    });
  }));

  // v2.30 方向 A：AI 日报/周报。每 15 分钟探测一次到点情况——sendDigestsForAllUsers
  // 内部按用户本地时区判断 daily/weekly 是否到点（isDigestDue）+ digest_archive 同期号
  // 查重，未到点/已发送都是 no-op，所以高频探测是安全幂等的。
  // vercel 上由外部 cron 打 /api/cron/digest?period=…；docker 由常驻调度器内化。
  for (const period of ['daily', 'weekly'] as const) {
    jobs.push(new Cron('*/15 * * * *', { timezone: 'Asia/Shanghai', name: `digest-${period}` }, async () => {
      await runJob(`digest-${period}`, async () => {
        const stats = await sendDigestsForAllUsers(period as DigestPeriod);
        if (stats.sent > 0) {
          log.info({ period, sent: stats.sent, skipped: stats.skipped }, 'Digest sent');
        }
      });
    }));
  }

  // v2.21 后台 AI 调度链：单 tick 推进（CAS on last_tick_at + 幂等键去重，天然防重）。
  // vercel 由外部 cron 每 10 分钟打 /api/agent/scheduler/start；docker 内化同职责。
  // 后台 AI 默认关闭（AGENT_* 未配置时 pumpSchedulerChain 为 no-op），开启用户零配置生效。
  jobs.push(new Cron('*/10 * * * *', { timezone: 'Asia/Shanghai', name: 'agent-scheduler-tick' }, async () => {
    await runJob('agent-scheduler-tick', async () => {
      const result = await pumpSchedulerChain();
      if (result && result.ticked) {
        log.info({ result }, 'Agent scheduler tick');
      }
    });
  }));

  log.info({ jobCount: jobs.length, timezone: 'Asia/Shanghai' }, 'Scheduler started');
}

export async function stopScheduler(): Promise<void> {
  for (const job of jobs) {
    job.stop();
  }
  jobs = [];
  schedulerState.startedAt = null;
  log.info('Scheduler stopped');
}
