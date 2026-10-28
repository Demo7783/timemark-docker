import { query } from '../db/index.js';

/**
 * 10-char prefix invariant (migration 51): `event_trigger_logs.trigger_date` is TEXT.
 * A row's first 10 chars are a calendar day `YYYY-MM-DD` ONLY for legacy rows (exactly
 * 10 chars) and for normal dedup tokens `YYYY-MM-DD#d<n>#tHH:mm`. Namespaced keys such as
 * `snooze:event#<id>#<ISO>` (buildSnoozeSendKey -> recordEventTrigger at
 * `backend/src/jobs/tasks.ts`) carry NO leading date - `LEFT('snooze:event#...', 10)` is
 * `snooze:eve` - so they must be EXCLUDED by a truthful prefix comparison, never
 * truncated, never cast (`text = date` -> 42883; `::date` -> 22007 on any token row).
 * The equality below can only ever match a real `YYYY-MM-DD` prefix, so namespaced rows
 * are excluded by construction.
 *
 * The day is computed in SQL for BOTH the INSERT target and the comparison so an
 * off-schedule/manual run can never split one aggregation across two days when the host
 * clock and the DB clock disagree. A host-local `yesterdayYmd()` is not safe here: on a
 * UTC host it yields `CURRENT_DATE - 1` only after 00:00 UTC, so between 16:00-24:00 UTC
 * it aggregated the wrong day for a +08 user (`stat_date` vs the `trigger_date` prefix).
 * `(CURRENT_DATE - INTERVAL '1 day')::date` keeps `stat_date` a real DATE and
 * `::date::text` keeps the prefix comparison on the same DB-local day.
 */
export async function aggregateDailyStats(): Promise<number> {
  // SQLite 版：上游 PG 用 `LEFT JOIN LATERAL (...)` 为每个用户聚合昨天的触发日志。
  // 改成「先按 user_id 聚合再按 user_id 左连」的派生表（一次扫描，等价语义）。
  // CURRENT_DATE → date('now','localtime')：容器 TZ=Asia/Shanghai，与 PG 服务器本地日同口径。
  const result = await query(
    `INSERT INTO stats_daily (user_id, stat_date, events_count, triggers_total, triggers_success, triggers_failed)
     SELECT u.id,
            date('now', 'localtime', '-1 day'),
            (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id),
            COALESCE(t.total, 0),
            COALESCE(t.success, 0),
            COALESCE(t.failed, 0)
     FROM users u
     LEFT JOIN (
       SELECT user_id,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'success') AS success,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM event_trigger_logs
       WHERE substr(trigger_date, 1, 10) = date('now', 'localtime', '-1 day')
       GROUP BY user_id
     ) t ON t.user_id = u.id
     ON CONFLICT (user_id, stat_date) DO UPDATE SET
       events_count = EXCLUDED.events_count,
       triggers_total = EXCLUDED.triggers_total,
       triggers_success = EXCLUDED.triggers_success,
       triggers_failed = EXCLUDED.triggers_failed`,
  );
  return result.rowCount ?? 0;
}
