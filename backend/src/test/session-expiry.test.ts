import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, query: mocks.query };
});

import { convertPgToSqliteInner } from '../db/index.js';
import { getSessionByToken } from '../services/session.service.js';

describe('session expiry checks', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('rejects an expired ISO timestamp even when it expired earlier today', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      token TEXT,
      device_fingerprint TEXT,
      is_trusted INTEGER,
      expires_at TEXT,
      refresh_token_id TEXT
    )`);
    db.run(
      'INSERT INTO sessions (user_id, token, device_fingerprint, is_trusted, expires_at, refresh_token_id) VALUES (?, ?, ?, ?, ?, ?)',
      // expires_at 走 db 层生产同款空格格式（UTC）：raw db.run 不经过 query() 的
      // 参数归一化，插 ISO-T 会因 'T' > ' ' 在字典序上永不过期
      [7, 'expired-session', 'device', 0, new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').replace(/Z$/, ''), 'refresh-current'],
    );

    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      // v2.30 服务层 SQL 是 PG 方言（NOW() 等）——mock 用与生产一致的中心转换器
      const sqliteSql = convertPgToSqliteInner(sql);
      if (/^\s*SELECT\b/i.test(sql)) {
        const statement = db.prepare(sqliteSql);
        statement.bind(params);
        const rows: Record<string, unknown>[] = [];
        while (statement.step()) rows.push(statement.getAsObject());
        statement.free();
        return { rows, rowCount: rows.length };
      }
      db.run(sqliteSql, params);
      return { rows: [], rowCount: db.getRowsModified() };
    });

    // v2.30 起刷新轮换改为 renewRememberedSession 机制，rotate 断言随旧 API 退役；
    // 「过期会话必须被拒」这条行为保留。
    await expect(getSessionByToken('expired-session')).resolves.toBeNull();
    db.close();
  });
});
