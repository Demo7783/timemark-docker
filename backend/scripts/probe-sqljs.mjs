// sql.js 方言能力探针：确定 vercel PG SQL 哪些写法在 SQLite 上原生可用
import initSqlJs from 'sql.js';

const SQL = await initSqlJs();
const db = new SQL.Database();

const probes = [
  ['json ->>', `SELECT '{"a":{"b":"x"}}' ->> 'a'`, null],
  ['json ->', `SELECT '{"a":{"b":"x"}}' -> 'a'`, null],
  ['json_extract', `SELECT json_extract('{"a":"x"}', '$.a')`, null],
  ['FILTER aggregate', `SELECT COUNT(*) FILTER (WHERE 1=1) AS c FROM (SELECT 1)`, null],
  ['CAST', `SELECT CAST('5' AS INTEGER) + 1`, null],
  ['datetime now -1day', `SELECT datetime('now', '-1 day')`, null],
  ['RETURNING', `CREATE TABLE t1(id INTEGER PRIMARY KEY, v TEXT)`, null],
  ['INSERT RETURNING', `INSERT INTO t1(v) VALUES ('a') RETURNING id`, null],
  ['ON CONFLICT DO UPDATE', `INSERT INTO t1(id, v) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET v = excluded.v`, null],
  ['LIKE case-insensitive', `SELECT CASE WHEN 'ABC' LIKE 'a%' THEN 1 ELSE 0 END`, null],
  ['ILIKE', `SELECT 'ABC' ILIKE 'a%'`, 'EXPECTED_FAIL'],
  ['NOW()', `SELECT NOW()`, 'EXPECTED_FAIL'],
  ['INTERVAL', `SELECT NOW() - INTERVAL '1 day'`, 'EXPECTED_FAIL'],
  ['::cast', `SELECT 1::int`, 'EXPECTED_FAIL'],
  ['date_trunc', `SELECT date_trunc('day', NOW())`, 'EXPECTED_FAIL'],
  ['string_agg', `SELECT string_agg(v, ',') FROM (SELECT 'a' v UNION SELECT 'b')`, 'EXPECTED_FAIL'],
  ['group_concat', `SELECT group_concat(v, ',') FROM (SELECT 'a' v UNION SELECT 'b')`, null],
  ['DISTINCT ON', `SELECT DISTINCT ON (v) v FROM (SELECT 'a' v) `, 'EXPECTED_FAIL'],
  ['FOR UPDATE', `SELECT * FROM t1 FOR UPDATE`, 'EXPECTED_FAIL'],
  ['gen_random_uuid', `SELECT gen_random_uuid()`, 'EXPECTED_FAIL'],
  ['SIMILARITY', `SELECT similarity('a','b')`, 'EXPECTED_FAIL'],
  ['array_agg', `SELECT array_agg(v) FROM (SELECT 'a' v)`, 'EXPECTED_FAIL'],
  ['json_group_array', `SELECT json_group_array(v) FROM (SELECT 'a' v)`, null],
  ['to_char', `SELECT to_char(now(), 'YYYY')`, 'EXPECTED_FAIL'],
  ['strftime', `SELECT strftime('%Y', 'now')`, null],
  ['unixepoch', `SELECT strftime('%s','now')`, null],
  ['COALESCE param IS NULL', `SELECT CASE WHEN ?1 IS NULL THEN 1 ELSE 0 END`, null],
];

for (const [name, sql, expect] of probes) {
  let outcome = 'OK';
  let detail = '';
  try {
    const stmt = db.prepare(sql);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    detail = JSON.stringify(rows[0] ?? {});
  } catch (err) {
    outcome = 'FAIL';
    detail = String(err).slice(0, 80);
  }
  const flag = expect === 'EXPECTED_FAIL' ? (outcome === 'FAIL' ? '[as-expected]' : '[STILL-WORKS?!]') : (outcome === 'OK' ? '[ok]' : '[BROKEN]');
  console.log(`${flag} ${name}: ${outcome} ${detail}`);
}
db.close();
