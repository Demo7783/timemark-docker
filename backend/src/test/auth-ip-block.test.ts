import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, query: queryMock };
});

import { convertPgToSqliteInner } from '../db/index.js';
import { evaluateIpBlock } from '../services/auth.service.js';

let database: Database;

beforeAll(async () => {
  const SQL = await initSqlJs();
  database = new SQL.Database();
  database.run(`
    CREATE TABLE login_logs (
      ip_address TEXT,
      success BOOLEAN,
      failure_reason TEXT,
      login_time TEXT
    )
  `);
});

afterAll(() => database.close());

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    // v2.30 服务层 SQL 是 PG 方言（COUNT(*)::int / NOW() 等）——用生产同款转换器
    const statement = database.prepare(convertPgToSqliteInner(sql));
    statement.bind(params as any);
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    statement.free();
    return { rows, rowCount: rows.length };
  });
});

describe('evaluateIpBlock', () => {
  it('evaluates an IP with no failures using SQLite-compatible SQL', async () => {
    await expect(evaluateIpBlock('203.0.113.5')).resolves.toBeUndefined();
  });

  it('does not count IPv6 loopback login failures', async () => {
    await expect(evaluateIpBlock('::1')).resolves.toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('does not count IPv4-mapped IPv4 loopback login failures', async () => {
    await expect(evaluateIpBlock('::ffff:127.0.0.1')).resolves.toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
