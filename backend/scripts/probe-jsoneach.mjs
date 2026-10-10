import initSqlJs from 'sql.js';
const SQL = await initSqlJs();
const db = new SQL.Database();
const tests = [
  [`SELECT value FROM json_each('["a","b"]')`, null],
  [`SELECT * FROM json_each('{"a":1}')`, null],
  [`SELECT json_array_length('["a","b"]')`, null],
  [`CREATE TABLE t(id TEXT)`, null],
  [`INSERT INTO t VALUES ('x1'),('x2')`, null],
  [`SELECT id FROM t WHERE id IN (SELECT value FROM json_each(?))`, ['["x1"]']],
  [`SELECT id FROM t WHERE id = ANY(?)`, ['["x1"]']],
];
for (const [sql, params] of tests) {
  try {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const rows = []; while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    console.log('OK  ', sql.slice(0, 60), JSON.stringify(rows));
  } catch (e) { console.log('FAIL', sql.slice(0, 60), String(e).slice(0, 70)); }
}
