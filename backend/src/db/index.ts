import fs from 'fs';
import path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

export type QueryResult = {
  rows: any[];
  rowCount: number;
  lastInsertRowid?: number;
};

export type QueryStatement = { text: string; params?: any[] };

const DB_PATH = process.env.DB_PATH || './data/timemark.db';
const resolvedDbPath = path.resolve(DB_PATH);
const dataDir = path.dirname(resolvedDbPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// In-memory database instance
let db: SqlJsDatabase | null = null;
let dbReady = false;
let initPromise: Promise<SqlJsDatabase> | null = null;

// Initialize database
async function initDatabase(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  
  // Load existing database if exists
  if (fs.existsSync(resolvedDbPath)) {
    const fileBuffer = fs.readFileSync(resolvedDbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  
  // Register PostgreSQL-style REGEXP support.
  //
  // Upstream SQL uses the PG operator `expr ~ 'pattern'` in several places
  // (event trigger_date prefix guards, patterns.service snooze detection).
  // SQLite parses `X REGEXP Y` only when a function named `regexp` exists;
  // the operator hands the arguments to it as (pattern, value) — Y first.
  // convertPgToSqlite() rewrites `~` into `REGEXP`, so this closure is what
  // actually runs. Invalid patterns degrade to "no match" instead of throwing,
  // matching PG's ERROR-free behaviour for these guarded prefix checks.
  db.create_function('regexp', (pattern: string, value: string | null) => {
    if (value === null || value === undefined || pattern === null) return 0;
    try {
      return new RegExp(String(pattern)).test(String(value)) ? 1 : 0;
    } catch {
      return 0;
    }
  });

  dbReady = true;
  startAutoSave();
  return db;
}

// Get database instance
export function getDb(): SqlJsDatabase {
  if (!db || !dbReady) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// Save database to file
function saveDatabase(): void {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(resolvedDbPath, buffer);
  }
}

// Wait for database initialization (lazy singleton - no race condition)
export async function waitForDb(): Promise<SqlJsDatabase> {
  if (!initPromise) {
    initPromise = initDatabase();
  }
  await initPromise;
  return getDb();
}

// Periodic auto-save (every 5 minutes) as safety net for crash recovery
const SAVE_INTERVAL = 5 * 60 * 1000;
let saveTimer: ReturnType<typeof setInterval> | null = null;
let isDirty = false;

// Debounced save - delays file write by 2 seconds after last write operation
const DEBOUNCE_SAVE_MS = 2000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function markDirty(): void {
  isDirty = true;
}

function debouncedSave(): void {
  markDirty();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveDatabase();
    isDirty = false;
    debounceTimer = null;
  }, DEBOUNCE_SAVE_MS);
}

function startAutoSave(): void {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    if (isDirty && db) {
      saveDatabase();
      isDirty = false;
    }
  }, SAVE_INTERVAL);
  // Don't prevent process exit
  if (saveTimer.unref) saveTimer.unref();
}

// Graceful shutdown - exported for unified handler in index.ts
export function gracefulShutdown(): void {
  // Cancel pending debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (db) {
    console.log('[DB] Saving database before shutdown...');
    saveDatabase();
    console.log('[DB] Database saved.');
  }
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

const LOG_QUERIES = process.env.LOG_QUERIES === 'true';

/**
 * PG→SQLite 集中式方言转换（v2.30 变基引入）。
 *
 * vercel 上游 594 个新文件的 SQL 是 PG 方言；与其逐文件改写，把可机械变换的
 * 模式集中在这里处理（v2.16 时代是逐文件适配，这里补齐中心化能力）：
 *
 * 1. `$n` 占位符 → `?`
 * 2. `?::数值类型` → `CAST(? AS type)`；`?::文本类类型`（text/jsonb/timestamptz/uuid…）
 *    → 直接丢弃 cast。SQLite 对不认识的类型名套 NUMERIC affinity，会把
 *    '2026-10-07 …' 截成 2026（探针实测），文本参数必须原样保留。
 * 3. `= ANY($n)` → `IN (SELECT value FROM json_each(?))`（配合数组参数 JSON 化）
 * 4. `NOW()` → `CURRENT_TIMESTAMP`
 * 5. `<expr> ± INTERVAL 'N unit'` → `datetime(<expr>, '±N unit')`——NOW()/CURRENT_TIMESTAMP
 *    专属规则先行，通用规则兜底 `?::timestamptz - INTERVAL '6 hours'` 这类参数/列运算
 *    （v2.30 用药剂量查询，冒烟实测漏网）
 * 6. `ILIKE` → `LIKE`（SQLite LIKE 对 ASCII 默认不区分大小写，语义一致）
 * 7. `date_trunc('unit', expr)` / `to_char(expr, 'YYYY-MM-DD')` → strftime 系列
 *
 * 探针实测（backend/scripts/probe-sqljs.mjs）确认原生支持无需改写：
 * `->>`/`->`/json_extract/FILTER/RETURNING/ON CONFLICT DO UPDATE/string_agg/group_concat。
 * 无法机械覆盖的（DISTINCT ON、FOR UPDATE、gen_random_uuid、similarity、array_agg）
 * 由调用方按文件改写（见 docs/PORT-LEDGER-v2.30.md）。
 */
const PG_CAST_TYPES = String.raw`int|integer|bigint|smallint|text|boolean|bool|jsonb|json|timestamptz|timestamp(?:\s+with\s+time\s+zone)?|date|uuid|numeric|real|double\s+precision|regclass|vector`;
/** 这些类型套 SQLite CAST 会走 NUMERIC affinity 把时间/JSON 字符串截成数字，必须丢弃 cast */
const PG_TEXTISH_CAST_TYPES = String.raw`text|boolean|bool|jsonb|json|timestamptz|timestamp(?:\s+with\s+time\s+zone)?|date|uuid|regclass|vector`;

function convertPgIntervalToSqlite(sql: string): string {
  // NOW() / CURRENT_TIMESTAMP ± INTERVAL 'N unit' → datetime('now', '±N unit')
  let out = sql.replace(
    /(?:NOW\(\)|CURRENT_TIMESTAMP)\s*(-|\+)\s*INTERVAL\s+'(\d+)\s*(second|minute|hour|day|week|month|year)s?'/gi,
    (_m, sign: string, n: string, unit: string) =>
      `datetime('now', '${sign === '-' ? '-' : '+'}${n} ${unit.toLowerCase()}${Number(n) === 1 ? '' : 's'}')`,
  );

  // 通用兜底：参数/列 ± INTERVAL（如 `?::timestamptz - interval '6 hours'`——cast 已在
  // 前面被剥成 ?）。expr 只匹配单 token 形态（?、col、tbl.col）；复杂表达式需手工改写。
  out = out.replace(
    /(\?|[\w."]+(?:\(\))?)\s*(-|\+)\s*INTERVAL\s+'(\d+)\s*(second|minute|hour|day|week|month|year)s?'/gi,
    (_m, expr: string, sign: string, n: string, unit: string) =>
      `datetime(${expr}, '${sign === '-' ? '-' : '+'}${n} ${unit.toLowerCase()}${Number(n) === 1 ? '' : 's'}')`,
  );
  return out;
}

/**
 * 函数级改写必须先于 make_interval 独立规则：
 * `now() ± make_interval(...)` 组合若被独立规则先吃掉 make_interval，会残留
 * `CURRENT_TIMESTAMP + datetime(...)`（文本+文本 = 数值加法 0，探针实测）。
 */
function convertPgToSqliteFunctionsFirst(sql: string): string {
  return convertPgFunctionToSqlite(sql);
}

function convertPgFunctionToSqlite(sql: string): string {
  let out = sql;

  // now() ± make_interval(secs => x) 必须先于裸 now() 处理：
  // `CURRENT_TIMESTAMP + datetime(...)` 是文本+文本的数值加法 = 0（探针实测）
  out = out.replace(
    /now\(\)\s*(-|\+)\s*make_interval\s*\(\s*secs\s*=>\s*([^)]+)\)/gi,
    (_m, sign: string, expr: string) =>
      `datetime('now', '${sign === '-' ? '-' : '+'}' || ((${expr.trim()}) ) || ' seconds')`,
  );
  out = out.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');

  // date_trunc('unit', expr) → strftime，仅覆盖无嵌套括号的简单表达式
  const truncUnit: Record<string, string> = {
    day: '%Y-%m-%d',
    month: '%Y-%m',
    year: '%Y',
    hour: '%Y-%m-%d %H:00:00',
    week: '%Y-%W',
  };
  out = out.replace(/date_trunc\s*\(\s*'(\w+)'\s*,\s*([^()]+?)\s*\)/gi, (m, unit: string, expr: string) => {
    const fmt = truncUnit[unit.toLowerCase()];
    if (!fmt) return m;
    return `strftime('${fmt}', ${expr.trim()})`;
  });

  // to_char(expr, 'PG fmt') → strftime(expr, 'strftime fmt')，逐 token 翻译常用格式
  const fmtToken: Array<[RegExp, string]> = [
    [/YYYY/g, '%Y'], [/MM\b/g, '%m'], [/DD\b/g, '%d'], [/HH24\b/g, '%H'], [/MI\b/g, '%M'], [/SS\b/g, '%S'],
  ];
  out = out.replace(/to_char\s*\(\s*([^,()]+?)\s*,\s*'([^']+)'\s*\)/gi, (m, expr: string, fmt: string) => {
    let f = fmt;
    for (const [re, rep] of fmtToken) f = f.replace(re, rep);
    // 上游此处写的是 `/[A-Z]/.test(f)` —— 而 strftime 的指令本身就是大写(%Y/%m/%H/%M/%S),
    // 于是「已翻译」的结果永远被判成「有未翻译 token」,to_char 从来没真正生效过
    // (提醒历史页 500 = no such function: to_char 的根因)。改为先剥掉 %X 指令再找残留字母。
    const leftover = f.replace(/%[A-Za-z]/g, '');
    if (/[A-Za-z]/.test(leftover)) return m; // 有未翻译的 PG 格式 token，留给调用方
    return `strftime('${f}', ${expr.trim()})`;
  });

  return out;
}

function convertPgToSqlite(text: string): string {
  // 诊断导出别名（见文件底部）
  return convertPgToSqliteInner(text);
}

export function convertPgToSqliteInner(text: string): string {
  let sql = text.replace(/\$\d+/g, '?');

  // 数组参数断言：?::uuid[] / ?::text[] 等配合 json_each，必须在通用 cast 之前处理
  sql = sql.replace(
    /(=|<>|!=)\s*ANY\s*\(\s*\?\s*::\s*(uuid|int|integer|bigint|text)\s*\[\]\s*\)/gi,
    (_m, op: string) => op === '='
      ? 'IN (SELECT value FROM json_each(?))'
      : 'NOT IN (SELECT value FROM json_each(?))',
  );

  // 文本类类型断言：丢弃 cast（保留裸 ?），原因见 PG_TEXTISH_CAST_TYPES 注释
  sql = sql.replace(new RegExp(String.raw`\?::\s*(` + PG_TEXTISH_CAST_TYPES + String.raw`)\b`, 'gi'), '?');

  // 数值类类型断言：?::type → CAST(? AS TYPE)
  sql = sql.replace(new RegExp(String.raw`\?::\s*(` + PG_CAST_TYPES + String.raw`)\b`, 'gi'),
    (_m, t: string) => `CAST(? AS ${t.toUpperCase()})`);

  // 非参数位 cast（COUNT(*)::int、fn(col)::text、col::text 等）。
  // 文本类类型直接剥掉，数值类包 CAST——与参数位规则同一套语义。
  // 表达式尾部三种形态：聚合/函数调用（含 COUNT(*)）、点路径/下标、裸标识符。
  const exprTail = String.raw`\w+\([^()]*\)|[\w."]+\]|[\w."]+`;
  sql = sql.replace(new RegExp(String.raw`(` + exprTail + String.raw`)\s*::\s*(` + PG_TEXTISH_CAST_TYPES + String.raw`)\b`, 'gi'),
    (_m, expr: string) => expr);
  sql = sql.replace(new RegExp(String.raw`(` + exprTail + String.raw`)\s*::\s*(` + PG_CAST_TYPES + String.raw`)\b`, 'gi'),
    (_m, expr: string, t: string) => `CAST(${expr} AS ${t.toUpperCase()})`);

  // = ANY(?) / <> ANY(?) / != ANY(?) → IN / NOT IN (SELECT value FROM json_each(?))
  sql = sql.replace(/(=|<>|!=)\s*ANY\s*\(\s*(\?)\s*\)/gi, (m, op: string, ph: string) => {
    if (op === '=') return `IN (SELECT value FROM json_each(${ph}))`;
    return `NOT IN (SELECT value FROM json_each(${ph}))`;
  });

  // 函数组（含 now() ± make_interval 组合）必须先于独立 make_interval 规则，
  // 否则组合式被拆开后残留 `CURRENT_TIMESTAMP + datetime(...)` —— 文本+文本
  // 在 SQLite 是数值加法（'2026…' 截成 2026），lease 到期时间会算到公元 4052 年。
  sql = convertPgFunctionToSqlite(sql);

  // make_interval(secs|mins|minutes|hours|days|weeks|months|years => expr)
  // → datetime('now', '+' || (expr) || ' <unit>')
  // 上游 docker 版多处用非 secs 单位（cadence 用 days、job-hardening 用 mins、
  // run-observability/feedback 用 days），只翻 secs 会残留 PG 语法直接炸查询。
  sql = sql.replace(/make_interval\s*\(\s*secs\s*=>\s*([^)]+)\)/gi,
    (_m, expr: string) => `datetime('now', '+' || (${expr.trim()}) || ' seconds')`);
  sql = sql.replace(/make_interval\s*\(\s*(mins|minutes|hours|days|weeks|months|years)\s*=>\s*([^)]+)\)/gi,
    (_m, unit: string, expr: string) => {
      const u = unit.toLowerCase();
      const norm = u === 'mins' || u === 'minutes' ? 'minutes' : u;
      return `datetime('now', '+' || (${expr.trim()}) || ' ${norm}')`;
    });

  // PG 正则操作符 → REGEXP（sql.js 侧由 initDatabase() 注册的 regexp() 实现，
  // 参数顺序是 (pattern, value)，SQLite 的 `X REGEXP Y` 会按此调用）。
  // 顺序：先匹配带 ^ 前缀的锚定形态与 !~（否定），再兜通用形态，避免 `!~` 被吃成 `!REGEXP`。
  sql = sql.replace(/([\w."]+(?:\([^()]*\))?)\s*!~\s*'((?:[^']|'')*)'/g,
    (_m, expr: string, pat: string) => `${expr} NOT REGEXP '${pat}'`);
  sql = sql.replace(/([\w."]+(?:\([^()]*\))?)\s*~\s*'((?:[^']|'')*)'/g,
    (_m, expr: string, pat: string) => `${expr} REGEXP '${pat}'`);

  // 注：PG 部分唯一索引的 `ON CONFLICT (cols) WHERE col IS NOT NULL DO ...` 在
  // SQLite 3.35+ 是合法语法（UPSERT conflict target 支持 WHERE），且 sql.js 1.14
  // 内核 ≥3.45，原文保留即可——探针实测过剥离反而匹配不到部分索引。

  // 行锁在单连接内存库上没有意义（无第二个连接可竞争），剥掉锁子句。
  // 并发正确性由调用方的 lease_token 校验保证（agent queue 的设计即如此）。
  sql = sql.replace(/\s*FOR\s+UPDATE(\s+SKIP\s+LOCKED)?/gi, '');

  sql = convertPgToSqliteFunctionsFirst(sql);
  sql = convertPgIntervalToSqlite(sql);

  // ILIKE → LIKE（SQLite 默认 ASCII 大小写不敏感）
  sql = sql.replace(/\bILIKE\b/g, 'LIKE');

  // PG 字符串截断函数 → SQLite substr（SQLite 没有 LEFT/RIGHT）。
  // 注意不能误伤 `LEFT JOIN`：规则要求函数名后紧跟 `(`，且 JOIN 后不会接括号表达式。
  sql = sql.replace(/\bLEFT\s*\(\s*([\w."]+)\s*,\s*([^(),]+?)\s*\)/gi,
    (_m, expr: string, n: string) => `substr(${expr}, 1, ${n})`);
  sql = sql.replace(/\bRIGHT\s*\(\s*([\w."]+)\s*,\s*([^(),]+?)\s*\)/gi,
    (_m, expr: string, n: string) => `substr(${expr}, -1 * (${n}))`);

  // array_agg(x [ORDER BY y]) → json_group_array(x)
  // （data-health 的重名联系人分组用；SQLite 的 group_concat 不支持 ORDER BY，
  //  这里取 json_group_array，调用方按 JSON 数组消费）
  sql = sql.replace(/\barray_agg\s*\(\s*([\w."]+)(?:\s+ORDER\s+BY\s+[^)]+)?\s*\)/gi,
    (_m, expr: string) => `json_group_array(${expr})`);

  // jsonb_* 函数族 → json_*（jsonb_array_length/jsonb_extract 等；SQLite json1 同名无 b）
  sql = sql.replace(/\bjsonb_(array_length|extract|each|set|insert|object|agg|tuple)\b/gi, 'json_$1');

  // EXTRACT(unit FROM expr) → CAST(strftime('%Y|%m|%d', expr) AS INTEGER)
  // （stats/on-this-day 的「N 年前的今天」用 EXTRACT(YEAR FROM date)::int）
  const extractMap: Record<string, string> = { year: '%Y', month: '%m', day: '%d', hour: '%H', minute: '%M' };
  sql = sql.replace(/\bEXTRACT\s*\(\s*(\w+)\s+FROM\s+([^()]+?)\s*\)/gi,
    (_m, unit: string, expr: string) => {
      const fmt = extractMap[unit.toLowerCase()];
      if (!fmt) return _m; // 未支持的单位原样保留,交给残留探测告警
      return `CAST(strftime('${fmt}', ${expr.trim()}) AS INTEGER)`;
    });

  // CURRENT_DATE ± (expr * INTERVAL '1 day') → date(CURRENT_DATE, '±' || (expr) || ' days')
  // （inventory 的「N 天内到期」用 CURRENT_DATE + ($2::int * INTERVAL '1 day')；cast 会先被
  //  前面的规则翻成 CAST(? AS INT)，所以 expr 段必须允许一层嵌套括号）
  sql = sql.replace(
    /CURRENT_DATE\s*([+-])\s*\(\s*((?:CAST\([^()]*\)|[^()])+?)\s*\*\s*INTERVAL\s*'1\s*(second|minute|hour|day|week|month|year)'\s*\)/gi,
    (_m, sign: string, expr: string, unit: string) =>
      `date(CURRENT_DATE, '${sign === '-' ? '-' : '+'}' || (${expr.trim()}) || ' ${unit.toLowerCase()}s')`,
  );

  // 兜底体检：翻译后仍残留的 PG 专属语法。不阻断执行（交给 sqlite 自己报错），
  // 但把 SQL 打到日志里，让下一次「方言缺口」在日志里就能看到原文，
  // 不用再靠 500 + 翻栈定位。每条唯一 SQL 只告警一次。
  // 注意：必须放在所有改写规则之后，否则会把「即将被翻译」的语法误报成残留。
  if (PG_RESIDUAL_PATTERN.test(sql)) {
    const key = sql.slice(0, 400);
    if (!warnedResidualSql.has(key)) {
      warnedResidualSql.add(key);
      console.warn('[db] 翻译后仍含 PG 专属语法，SQLite 可能报错：', key.replace(/\s+/g, ' '));
    }
  }

  return sql;
}

/** PG 专属语法残留探测（仅用于日志体检，不改写 SQL）。 */
const PG_RESIDUAL_PATTERN = new RegExp(
  String.raw`\bLATERAL\b|\bunnest\s*\(|\bgenerate_series\s*\(|\bmake_interval\s*\(|\barray_agg\s*\(|\bstring_agg\s*\(|\bjson_agg\s*\(|\bLEFT\s*\(|\bRIGHT\s*\(|\bEXTRACT\s*\(|\bINTERVAL\s*'|::\s*\w+|\s~\s`,
  'i',
);
const warnedResidualSql = new Set<string>();

/**
 * 参数归一化：
 * - boolean → 0/1（sql.js 不绑 JS boolean，SQLite 亦无布尔类型）
 * - Date → 'YYYY-MM-DD HH:MM:SS'（UTC，与 CURRENT_TIMESTAMP 存储格式一致）
 * - ISO 带 T 的字符串 → 空格分隔（CURRENT_TIMESTAMP 列上的字典序比较才正确）
 * - 数组 → JSON 字符串（配合 `IN (SELECT value FROM json_each(?))`）
 */
function normalizeSqliteParam(p: unknown): unknown {
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (p instanceof Date) {
    return p.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }
  if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p)) {
    return p.replace('T', ' ').replace(/Z$/, '');
  }
  if (Array.isArray(p)) return JSON.stringify(p);
  // 普通 object → JSON 文本（对齐 node-pg prepareValue 语义：TEXT 列存 JSON 字符串，
  // 读回是字符串。缺这条时 sql.js 把对象按未知类型处理，读回形状与 vercel 不一致——
  // fullchain 实测在 error_details 上炸了 React 渲染）
  if (p !== null && typeof p === 'object') return JSON.stringify(p);
  return p;
}

function isRowReturningQuery(sql: string): boolean {
  const normalized = sql.trim();
  const isSelectLike = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(normalized);
  const hasReturning = /\bRETURNING\b/i.test(normalized);
  return isSelectLike || hasReturning;
}

/**
 * 读取侧时间归一化（v2.30 全链路「8 小时偏移」教训的系统级修复）：
 * DB 侧 now()/datetime() 写入的是 'YYYY-MM-DD HH:MM:SS'（UTC 无时区标记），
 * JS `new Date('...')` 会按本地时区解析（UTC+8 偏 8 小时）。统一在读出时
 * 转成带 Z 的 ISO，让上游拿到时区无歧义的值。
 */
function normalizeTimestampOut(value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
    return `${value.replace(' ', 'T')}Z`;
  }
  return value;
}

/**
 * 读取侧 JSON 自动解析（PG jsonb 语义补齐）：
 * node-pg 会把 jsonb/json 列自动 parse 成 JS 对象/数组，sql.js 只返回原始 TEXT。
 * v2.30 服务层大量直接 `Array.isArray(row.col)` / `row.col.map(...)`，不补这一层
 * 会把 JSON 字符串当标量用（探针外最隐蔽的一类运行时崩坏）。
 * 策略：形如 { 或 [ 开头且 JSON.parse 成功的字符串才解析，失败原样返回。
 */
function normalizeJsonOut(value: unknown): unknown {
  if (typeof value === 'string') {
    const head = value[0];
    if ((head === '{' || head === '[') && value.length > 1) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = normalizeTimestampOut(row[key]);
    row[key] = normalizeJsonOut(v);
  }
  return row;
}

/**
 * v2.30 上游大量使用乱序命名参数（如 `WHERE id = $3 AND x = $1` 的书写顺序里
 * $2/$3 先于 $1 出现）。$n→? 的文本替换保持出现顺序，因此绑定参数必须按
 * 占位符出现顺序重排，否则数组会绑到错误的位置（探针实测踩雷）。
 * 返回 null 表示本来就是顺序参数，无需重排。
 */
function extractPlaceholderOrder(text: string): number[] | null {
  const order: number[] = [];
  for (const m of text.matchAll(/\$(\d+)/g)) order.push(Number(m[1]));
  if (order.length === 0) return null;
  const sequential = order.every((v, i) => v === i + 1);
  return sequential ? null : order;
}

export async function query(text: string, params: any[] = []): Promise<QueryResult> {
  const start = Date.now();
  const sqliteText = convertPgToSqlite(text);
  const order = extractPlaceholderOrder(text);
  const sqliteParams = (order ? order.map((n) => params[n - 1]) : params).map(normalizeSqliteParam);

  // Ensure database is ready
  await waitForDb();

  try {
    const database = getDb();

    if (isRowReturningQuery(sqliteText)) {
      const stmt = database.prepare(sqliteText);
      stmt.bind(sqliteParams);

      const rows: any[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        rows.push(normalizeRow(row));
      }
      stmt.free();

      const duration = Date.now() - start;

      if (LOG_QUERIES) {
        console.log('Executed query', { text, duration, rows: rows.length });
      }

      return {
        rows,
        rowCount: rows.length,
      };
    }

    database.run(sqliteText, sqliteParams);

    const lastId = database.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0];
    const changes = database.getRowsModified();

    const duration = Date.now() - start;

    if (LOG_QUERIES) {
      console.log('Executed query', { text, duration, rows: changes });
    }

    // Debounced save after writes (2-second delay, batches rapid writes).
    // Skipped inside an open withTransaction block — the save happens after COMMIT
    // so an export never captures uncommitted pages.
    if (txDepth === 0) {
      debouncedSave();
    }

    return {
      rows: [],
      rowCount: changes,
      lastInsertRowid: typeof lastId === 'number' ? lastId : undefined,
    };
  } catch (error) {
    if (LOG_QUERIES) {
      console.error('Query failed', { text, params, error });
    }
    throw error;
  }
}

/** Execute mutation statements atomically against the SQLite database. */
export async function queryTransaction(statements: QueryStatement[]): Promise<QueryResult[]> {
  await waitForDb();
  if (statements.length === 0) return [];

  const database = getDb();
  database.exec('BEGIN TRANSACTION');
  try {
    const results = statements.map(({ text, params = [] }) => {
      const sqliteText = convertPgToSqlite(text);
      if (isRowReturningQuery(sqliteText)) {
        throw new Error('queryTransaction only supports mutation statements');
      }
      const order = extractPlaceholderOrder(text);
      const bound = (order ? order.map((n) => params[n - 1]) : params).map(normalizeSqliteParam);
      database.run(sqliteText, bound);
      return { rows: [], rowCount: database.getRowsModified() };
    });

    database.exec('COMMIT');
    debouncedSave();
    return results;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original statement/commit error.
    }
    throw error;
  }
}

export function getClient(): SqlJsDatabase {
  return getDb();
}

/**
 * Transaction-scoped client, shape-compatible with vercel 侧 `withTransaction` 的
 * PoolClient 用法（调用方只对 client 调 `.query()`）。sql.js 是单连接内存库，
 * BEGIN/COMMIT 作用于整个连接，因此嵌套调用共享同一事务。
 */
export type DbClient = {
  query: (text: string, params?: any[]) => Promise<QueryResult>;
};

let txDepth = 0;

/** Run `fn` with a client inside BEGIN…COMMIT; rolls back on throw (matches upstream semantics). */
export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  await waitForDb();
  const database = getDb();
  if (txDepth === 0) {
    database.exec('BEGIN TRANSACTION');
  }
  txDepth += 1;
  const client: DbClient = {
    query: (text: string, params: any[] = []) => query(text, params),
  };
  try {
    const result = await fn(client);
    txDepth -= 1;
    if (txDepth === 0) {
      database.exec('COMMIT');
      debouncedSave();
    }
    return result;
  } catch (error) {
    txDepth -= 1;
    if (txDepth === 0) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  }
}

export default { query, db: { getClient }, waitForDb, withTransaction, queryTransaction };