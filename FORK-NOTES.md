# 自维护 fork 说明(小言维护)

上游:`WXFffff666/timemark-docker`
本仓:`Demo7783/timemark-docker`
基线:v2.30.0(commit a0373d4)

## 为什么要 fork

上游 docker 版把 PostgreSQL 源码移植到 sql.js(SQLite),**方言适配层没做全**:
`backend/src/db/index.ts` 的 `convertPgToSqlite*` 只覆盖了 casts / now() /
make_interval(secs=>) / date_trunc / to_char / ILIKE / FOR UPDATE / jsonb_*,而线上
实际用到、却会直接抛 SQL 语法错的有三类:

| 缺口 | 上游用法 | 现象 |
|---|---|---|
| `expr ~ 'regex'` | 提醒历史 `trigger_date ~ '^[0-9]{4}-...'`、patterns 的 snooze 判定 | `near "~": syntax error` → `/api/events/reminder-logs` 500 |
| `to_char(expr,'fmt')` | 提醒历史的时间格式化 | **上游有翻译规则但判据写错**(`/[A-Z]/` 恒真,见下)→ `no such function: to_char` |
| `LEFT(x,n)` / `RIGHT(x,n)` | 提醒历史、stats-daily、features 路由的日期前缀截断 | `no such function: LEFT` |
| `make_interval(days\|mins\|… => x)` | cadence 提醒、job-hardening、run-observability | 只翻 secs,其他单位残留 PG 语法 |
| `LATERAL` | cadence 取最近一次互动、stats-daily、medication 的 `unnest`、todos 的 `generate_series` | `near "SELECT": syntax error`,cadence 提醒每轮报错 |
| `array_agg(x ORDER BY y)` | data-health 重名联系人分组 | `no such function: array_agg` |

靠 docker 只读挂载逐个补 dist 是打地鼠,所以改为 fork 自维护、自己出镜像。

## 我们的改动(全部在源码层,便于 rebase)

1. **`backend/src/db/index.ts`**
   - `initDatabase()` 注册 `regexp(pattern, value)` 自定义函数。SQLite 只有存在名为
     `regexp` 的函数时才认 `X REGEXP Y`;操作符按 (pattern, value) 顺序回传参数。
   - `convertPgToSqliteInner()` 新增:
     - `make_interval(<unit> => expr)` 全单位翻译(mins/minutes/hours/days/weeks/months/years)
     - `expr ~ 'p'` → `expr REGEXP 'p'`,`!~` → `NOT REGEXP`(先匹配 `!~`,否则被吃成 `!REGEXP`)
     - `LEFT(x,n)` → `substr(x,1,n)`、`RIGHT(x,n)` → `substr(x,-1*(n))`
     - `array_agg(x [ORDER BY y])` → `json_group_array(x)`
   - `convertPgFunctionToSqlite()` 的 `to_char` 判据修正:
     上游写 `if (/[A-Z]/.test(f)) return m`,但 strftime 指令本身就是 `%Y/%m/%d/%H`
     **大写**,判据恒真 → to_char 从来没被翻译过。改为先 `f.replace(/%[A-Za-z]/g,'')`
     再判残留字母。
   - 新增 PG 残留语法探测(只告警不改写):翻译后若仍含 `LATERAL` / `unnest(` /
     `generate_series(` / `make_interval(` / `::type` / ` ~ ` 等,按唯一 SQL 打一次
     `[db] 翻译后仍含 PG 专属语法`,下次缺口不用再翻 500 栈。
   - **配套**:`backend/src/types/sql.js.d.ts` 补 `create_function` 声明(官方 shim 缺)。

2. **`backend/src/jobs/tasks.ts`**(cadence)
   - `LEFT JOIN LATERAL (… LIMIT 1) latest ON TRUE` → CTE + `ROW_NUMBER() OVER
     (PARTITION BY user_id, contact_id ORDER BY occurred_at DESC)`,按 `rn = 1` 左连。
   - `COALESCE(...) + make_interval(days => fc.cadence_days)` →
     `datetime(COALESCE(...), '+' || fc.cadence_days || ' days')`。

3. **`backend/src/services/event.service.ts`**(农历)
   - 3 处 `JSON.parse(row.lunar_date)` 加类型守卫:sql.js 适配层的 `normalizeJsonOut()`
     已把 JSON 列解析成对象(node-pg 的 jsonb 语义),二次 parse 会抛错并被 catch 吞掉 →
     `lunarDate` 丢失 → 农历标签消失、编辑保存后 `next_occurrence` 按公历漂移。

4. **`frontend/src/components/layout/PageHeader.tsx`**
   - `<header>` 加 `mt-6`:原布局里 header 是 `sticky top-6` 但流内盒在 y=0,
     视觉下移 24px 压住了紧邻内容,导致页面头部胶囊与首屏卡片间距为 0。加 mt-6 后
     静态位置与吸附位置一致,下方内容自然让出 24px。

5. **`Dockerfile.our`**
   - `NPM_REGISTRY` 构建参数(默认 npmmirror,容器内直连 npmjs 会超时)
   - apk 源换 aliyun(`dl-cdn.alpinelinux.org` 在本机 TLS 不通)
   - 补 `addgroup -S app && adduser -S app -G app`(上游有,漏写则 chown 失败)
   - CMD 修正:`./backend/dist/backend/src/index.js`(不存在)→ `./backend/dist/index.js`

6. **`backend/src/services/stats-daily.service.ts`**
   - `LEFT JOIN LATERAL (...)` → 先按 `user_id` 聚合的派生表 + `ON t.user_id = u.id`；
     `CURRENT_DATE` → `date('now','localtime')`，`LEFT(trigger_date,10)` → `substr(...)`。

7. **`backend/src/routes/todos.ts`**
   - `CROSS JOIN LATERAL generate_series(..., INTERVAL '1 day')` → 递归 CTE `days(d)`；
     `d::date`/`e.date::date` → `days.d` / `date(e.date)`；
     `->> 'enabled'::boolean IS TRUE` → `json_extract(e.recurring_config,'$.enabled') = 1`。

8. **`backend/src/services/medication.service.ts`**
   - 三个物化/补记函数 + 两个依从性查询全部去掉 PG-only 语法：
     `CROSS JOIN LATERAL unnest(schedule_times)`、`generate_series`、`AT TIME ZONE`、
     `array_length`、`ANY(schedule_days)`、`to_char(... AT TIME ZONE ...)`。
   - 新增 `zonedOffsetMs()` / `wallClockToInstant()` / `localDow()`：用 Intl 反解时区偏移，
     把「本地墙钟 + tz」换成绝对时刻（等价 PG `AT TIME ZONE`）；展开在 JS 完成，
     幂等仍靠 `UNIQUE(medication_id, scheduled_for)`。
   - 依从性的「所属本地日」也在 JS 归算（SQLite 无法在 SQL 内做时区归日）。

## 构建与部署

```sh
# 1. 装依赖(容器内 build 时直连 npmjs 会超时,走镜像源)
cd /opt/data/tasks/timemark-src
PATH=/opt/data/tools/bin:$PATH pnpm install --frozen-lockfile --ignore-scripts \
  --config.registry=https://registry.npmmirror.com

#    --ignore-scripts 是必须的:onnxruntime-node 的 postinstall 会外网拉二进制失败
#    本项目构建只需要 tsc / vite,不依赖那些 postinstall

# 2. 本地构建产物(Dockerfile 里前端 dist 是 COPY 进去的,不会自己编)
pnpm build:shared && pnpm build:frontend && pnpm build:backend

# 3. 出镜像
docker build -f Dockerfile.our -t timemark-our:2.30.0-p1 .
```

部署栈在 `/nas/docker/timemark/`(compose 用 `timemark-our:2.30.0-p1`,数据卷不变)。

## 跟上游同步

```sh
git fetch upstream
git rebase upstream/master      # 上游默认分支是 master
# 冲突只可能落在上面 4 个文件/3 处 SQL;按本文件描述重打即可
```

**上游若已把某处修好**,对应改动直接丢弃(取 upstream 版本),别重复修。

## 已知仍未修的 PG-only 语法(上游遗留,不影响核心链路)

| 位置 | 语法 |
|---|---|
| `services/medication.service.ts` | `CROSS JOIN LATERAL unnest(m.schedule_times)` |
| `services/stats-daily.service.ts` | `LEFT JOIN LATERAL (...)` |
| `routes/todos.ts` | `CROSS JOIN LATERAL generate_series(...)` |

用药计划、每日统计、循环待办会命中。要用到这些功能时按 cadence 的 CTE 写法改。
