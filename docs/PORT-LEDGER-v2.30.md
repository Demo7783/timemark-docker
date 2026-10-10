# TimeMark Docker 变基账本：vercel v2.16.0 → v2.30.0

> 开工：2026-10-07。策略：**变基（rebase），不做 153 提交逐批 cherry-pick**。
> 以 timemark-vercel@v2.30.0（978d29b）三源码树为新基底，重新施加 docker 增量层
> （sql.js 适配 + 安全加固 + Docker 基建），逐阶段验证。

## 为什么变基而不是逐批移植

| 维度 | 逐批 cherry-pick | 变基 |
|---|---|---|
| 提交量 | 153 提交 / 14 版本 | 1 次树换装 + 增量层重施加 |
| 公共文件 | 220 个反复手工合并 | vercel 侧终态直接采用 |
| docker 修复 | 每批逐文件守护 | 72 文件补丁序列一次性重放 |
| 中间态 | v2.17…v2.29 无人需要 | 不存在 |

## 基线事实（2026-10-07 盘点）

- docker@6c14f3e（master）：源文件 260，路由 19，服务 31，渠道 38，迁移 v2→v33，Express
- vercel@978d29b（v2.30.0+3）：源文件 814，路由 84，服务 72，渠道 61，迁移 v2→v81，**Hono**
- vercel 仅在：594 文件；两边共有：220；docker 仅在：40
- docker 72 个文件带本地加固（f33fbac..HEAD），须重放
- vercel 测试 163 文件，绝大多数 vi.mock db 层 → 可随变基搬迁
- docker CI 门禁 = pnpm install + pnpm build（无测试）

## vercel 平台耦合点与 docker 处置

| vercel 侧 | 用途 | docker 处置 |
|---|---|---|
| `pg` Pool/PoolClient | db 客户端 | 保留 docker sql.js 适配层（接口已对齐），**补 `withTransaction`**；`import type {PoolClient}` 改本地类型 |
| `@vercel/blob`（put/get/del/presignUrl/issueSignedToken/BlobNotFoundError） | 附件存储 | 新建 `storage/blob-local.ts` 本地磁盘同接口实现，改 import |
| `@vercel/functions` `waitUntil` | 后台 promise | shim：`p.catch(()=>{})` |
| `resend` | 邮件 API | 保留依赖（普通 HTTP 客户端，docker 可用） |
| `build-vercel-api.mjs` / `vercel.json` / `api/` | serverless 构建入口 | 不搬（docker 用 tsc + node 直跑） |
| scheduler.vercel-stub 条件加载 | serverless 冷启动 | 不搬条件分支，docker 恒用真 scheduler（jobs/tasks.ts + queue/scheduler.ts 保留 docker 版） |

## docker 独有资产（40 文件）处置

- **保留**：`app.ts`（测试宿主，需挂 v2.30 路由）、`queue/scheduler.ts`、`types/sql.js.d.ts`、
  `utils/initial-admin.ts`、21 个 docker 测试、9 个渠道服务（bluebubbles/clawbot/nostr/qqbot/
  signal/wechat-openclaw/wechaty/whatsapp/zalo —— vercel v2.17 清理时删除，docker 自托管用户仍可用，阶段G对接新注册表）
- **弃用**（功能被 vercel 新结构取代）：`frontend/components/settings/*` 3 件套（v2.26 设置页重组）、
  `pages/Reminders.tsx`（v2.26 并入 /trigger-logs）、`shared/src/channels.ts`（被 channels.config.ts 取代）、
  `utils/safe-http.ts`（若 vercel 有等价物则以 vercel 为准，21 个测试中的 url-safety/safe-http 测试相应调整）

## 72 个本地加固文件的重放清单（阶段C逐文件核对）

要点修复（f33fbac..HEAD，非 vercel 上游）：
1. `8303612` 全量 PG→SQLite 方言（提醒引擎/会话清理/Passkey/统计/日历/收件箱）
2. `be6d720` Cookie 回退与会话吊销校验
3. `1d0b136` JWT 弱密钥硬失败、X-API-Key CSRF bypass 移除、同 Host 来源、Cookie Secure/CSP 按协议
4. `27cea7c` 登录限流共享桶、geoip 缓存上限
5. `a38cfdf` scheduler 通知重试接线（docker scheduler.ts 保留即自带）
6. `a8f13d0` auth.service 登录锁定 SQLite 适配
7. `6d5b4cd` Telegram MarkdownV2 动态字段转义（核对 vercel v2.30 是否已有）
8. `6c14f3e` auth/origins/calendar-imports 加固（核对 vercel 是否已有等价）

方法：对每个文件 `git diff f33fbac..HEAD -- <file>` 提取 docker 侧 hunk，与 vercel@v2.30 终态对照，
上游已有→跳过；上游没有→重放。**迁移文件 migrate.ts 例外**：docker v2→v33 已是 SQLite 方言版，
保留 docker 主体，仅吸收 vercel 侧 v34→v81（阶段D）。

## 阶段门禁

- [x] A 账本 + 分支（注：分支乌龙——并行调用 cwd 竞争把 checkout -b 开到了 vercel 仓库，docker 的提交实际落在 master，ahead 3；工作内容无损，保持 master 线）
- [x] B 树换装：vercel@v2.30 三树覆盖 + 33 独有文件回植 + package.json 四件合并（**保留** @vercel/blob、@vercel/functions——纯 JS 包 docker 可用且 blob 模式对自托管多实例有用；剔除 pg/@types/pg）+ .gitignore 关键 un-ignore（shared/src/data 中文日数据集、PWA sw.js/install-prompt.js）+ pnpm-lock 重生成 + React19/Tailwind4/Vite8 配置换装
- [x] C 编译归零：
  - db/index.ts：恢复 sql.js 适配层 + `withTransaction`（txDepth 防事务中途落盘）+ **中心方言转换器**（$n乱序重排 / 数值cast保留+文本类cast丢弃 / = ANY→json_each / NOW()、INTERVAL、make_interval→datetime / ILIKE→LIKE / date_trunc、to_char→strftime / FOR UPDATE 剥离 / 数组参数 JSON 化 / 布尔→0/1 / **读取侧 space→ISO-Z 归一化**防 8 小时偏移）
  - 转换器经 backend/scripts/probe-queue-sql.mjs 全链路探针验证（agent_jobs 入队/幂等/认领/续租/完成/重试/回收，仓库最难的 PG SQL）——踩雷三连：`CAST('2026…' AS TIMESTAMPTZ)` 被截成 2026（文本类 cast 必须丢弃）；`ON CONFLICT (cols) WHERE … DO` 在 SQLite 3.35+ 合法勿剥离；`now()+make_interval` 组合被独立规则拆开后残留文本+文本=0（lease 算到公元 4052 年）→ 规则顺序=函数组最先
  - index.ts 拆分：app.ts（Hono 应用构造 + createApp() 工厂，docker 测试宿主惯例）+ index.ts（密钥/迁移/管理员/调度器/serve/进程守卫）；scheduler 接真版 croner 调度器（vercel 的 stub 路径保留未用）
  - storage.service：本地磁盘升格为 docker 合法生产形态（ATTACHMENT_REQUIRE_BLOB=1 可恢复 vercel 语义）
  - 强制保留的 docker 加固：url-safety（DNS 钉扎版 SSRF 守卫，vercel 版有 TOCTOU 窗口）、client-ip（TRUSTED_PROXIES CIDR 校验版，vercel 版无条件信任 cf-connecting-ip 可被伪造绕过 IP 封禁）、auth-cookies（secure 按请求协议判定，NAS/LAN 明文部署不炸登录）——三者均已验证与 v2.30 调用方接口兼容
  - vercel 平台件：vercel-init.ts 整体保留（ensureAdminUser 密码策略上游更严，docker 采用）；`import type {PoolClient} from 'pg'` 3 处 → DbClient 别名；stats.ts /scheduler 端点恢复（docker 有真调度器）
  - docker 独有测试 6 处适配：app-http（createApp 工厂）、jwt（typ 闸门新断言）、session-expiry（rotate 机制随上游退役）、https-enforcement（cookie TTL 参数）、client-ip（旧 API 名随 master 版 client-ip 恢复而复活）、telegram-escape（**退役**——6d5b4cd 的 MarkdownV2 转义修复已被上游独立吸收，内联于 telegram.service.ts）
  - scheduler.ts 新增：digest daily/weekly（每 15 分钟探测，isDigestDue+同期号查重幂等）+ agent-scheduler-tick（每 10 分钟，CAS+幂等键防重）——vercel 外部 cron 职责内化；agent worker drain 留 HTTP 端点（无独立服务函数，避免改上游路由文件）
  - 三端 build 全绿（shared tsc / frontend vite 2.27s / backend tsc）
- [x] D 迁移 v34→v81 SQLite 化 ✅（代理第三次执行成功）：migrate.ts 重写 2608 行（docker 旧结构 + v2→v33 原样 + 48 条翻译 + tryExec 辅助 + PROFILE_AWARE_TABLES）；probe-migrate-chain.mjs **首轮 ALL PASS**（MAX=81、14 关键表、totp_recovery_codes/digest_daily_enabled 列、零 "Migration failed"）；tsc 0 错误。关键翻译决策：`UPDATE...FROM`（SQLite 3.33+ 原生）、v41 补 FK 以「新链路无悬挂值+回填」等价、v53/57 pg_trgm+pgvector 整条删（占位保链号）、v54 行锁剥除（单连接，lease_token 保并发）、v70 CHECK 建表即终态（SQLite 无 DROP CONSTRAINT）、migrateEncryptionKey 合入上游 session_data 守卫。**附带修复**：v4/v5/v10 裸 ALTER 在新库必 duplicate column（旧文件一直失败但无实害）照 v32 先例移 tryExec。**退役 26 个 migration-vNN 测试**（vercel PG 方言静态标记断言，对 SQLite 翻译不适用；探针=真引擎真链路端到端，覆盖更强）。**适配 4 个**：migration-chain（78 版/缺口 66/68/v15 已分配）、migration-selfcheck（同上）、search-semantic（钉 v53 占位+无 vector_dims）、trigger-log-persistence（钉 v51 占位+无 ALTER COLUMN TYPE）
- [x] E 测试语料分诊 ✅ **最终：后端 1680/1681（0 失败，含 1 skipped）+ 前端 319/319 + tsc 0**：
  - **前端 319/319 全绿**（零修复，React19/Tailwind4 换装成立）
  - 后端首轮 1749/1813（96.5%）——mock 层语料基本直接可用
  - 修复：db 层补**非参数位 cast**（`COUNT(*)::int`/`col::text`）与 **jsonb_*→json_*** 转换；db 层补**读取侧 JSON 自动解析**（PG jsonb 经 node-pg 自动 parse，sql.js 返回 TEXT——v2.30 服务直接 Array.isArray 会拿不到数组，calendar-sync 等 35 个失败同根因）
  - auth-ip-block/session-expiry 的测试 harness 改用生产同款 convertPgToSqliteInner；storage-service 测试改到 docker 语义（本地盘=合法生产形态/REQUIRE_BLOB=1 恢复拒写）；calendar-sync/ics-parser/calendar-import/caldav-sync 4 文件 53 用例由子代理全量适配 v2.30 契约（桩点迁到 url-safety+fetch）
  - 退役 3 个断言旧轮换机制的测试（session-refresh/auth-refresh-cookie/auth-middleware-token-type）——v2.30 刷新机制重构（typ 闸门+renewRememberedSession），上游 session-renewal/jwt-token-type 测试已覆盖新契约
  - docker 加固在 v2.30 的存活性核对：originMatchesHost（LAN 同 Host）上游已有；allowed-origins 恢复 docker 清洗语义（含 `*` 条目剔除，v2.30 会把混合列表变凭据全放行）；https-enforcement/webauthn-config/security-headers 恢复 docker 版（v2.30 直连 HTTP 放行/转发头不校验/HSTS 无协议门控会复现 LAN 白屏）；app.ts httpsEnforcement 改回全局挂载；evaluateIpBlock 补 ::1/::ffff:127.0.0.1 回环族短路（v2.30 只认字面 127.0.0.1）
  - **子代理发现的疑似上游 bug**：①CalDAV 接受 3xx 响应体（已修：>=300 continue，恢复 v2.16 拒绝重定向）②URL userinfo 凭据可能进 errors/日志（v2.30 isSafePublicUrl 不查 userinfo，暂记账）③parseIcsEvents 接受不可能日期 20260230（上游宽容设计，暂记账）
- [x] F 新 SQLite 库 boot 冒烟 ✅（backend/scripts/probe-boot-smoke.mjs **12/12 PASS**）：冷启动迁移链到 v81、health version 2.30.0、管理员创建、Cookie 登录（v2.30 authMode='cookie'，token 走 HttpOnly Set-Cookie）、事件 CRUD（列表直接返回数组）、渠道目录 69 含 whatsapp/nostr、/api/v1 坏 token 401、digest cron 守卫 401、storage.local 日志、调度器 11 任务。**冒烟抓到一个转换器真 bug**：`<param> ± INTERVAL` 通用形式漏网（用药剂量 `?::timestamptz - interval '6 hours'` 语法错）→ 加通用兜底规则（NOW 专属规则先行），队列探针回归通过。**脚本侧教训**：Windows shell:true 下 kill 只杀 cmd.exe 不杀 node 孙进程——8791 残留旧服制造假 500/假缺日志，必须 taskkill /T /F 杀进程树。
- [x] G 渠道资产：8 个 docker 独有渠道接入 v2.30 注册表（nostr 复用上游保留条目 + 7 插件渠道回植，wechats-openclaw 维持休眠）；**isSupportedChannel 运行时区分**（isServerlessRuntime() 动态判断，VERCEL 才过滤插件渠道）；test-connection 补 imessage（BlueBubbles /api/v1/server/info）；channel-integrity 测试 (d)/(f) 改运行时感知（69=61+8）
- [x] H 版本 2.30.0 + CHANGELOG + README + DEPLOYMENT ✅（Docker 镜像构建待 CI；push 见下）

## 决策记录

- 2026-10-07 定策略变基。渠道数以 vercel 61 + docker 独有 9 = 目标 70 为上限，至少保 61。
- 2026-10-07 vercel `->>` 运算符 SQLite 3.38+ 原生支持（sql.js 1.11 为 3.45+），方言面主敌是 `::cast` 与 INTERVAL/NOW()/gen_random_uuid。
- 2026-10-07 模板串编辑一律走 Edit/Write 工具（heredoc 吃 \n 的教训）。
- 2026-10-07 **探针三课**：①文本类 `::cast` 必须丢弃（NUMERIC affinity 截断）；②PG 部分索引 conflict target 的 `ON CONFLICT (cols) WHERE … DO` SQLite 3.35+ 原生支持，剥离反而坏；③`now()+make_interval` 与裸函数改写的规则顺序——函数组最先，否则文本+文本=0。
- 2026-10-07 **读取侧 UTC 归一化**进 db 层：DB 写 'YYYY-MM-DD HH:MM:SS'，JS new Date 按本地时区解析——v2.30 全链路 8 小时偏移 bug 的系统级修复（v2.27 同类教训：改 SQL 端 epoch；本次选读出侧转 ISO-Z）。
- 2026-10-07 vercel 测试语料绝大多数 vi.mock db 层，可随变基直接搬迁；docker CI 门禁维持 install+build，测试为本地质量门。
- 2026-10-07 vercel 仓库 master 有 10 个未推送提交（push-via-api 时代的分叉），已原样保留勿动；误开的 port/vercel-v2.30 分支残留其中（与 master 同指针，无害）。
