# timemark-docker v2.30 品质打磨计划（POLISH-PLAN）

> 2026-10-07。变基战役已完成并推送（远端树一致，CI 双绿）。本计划按「调研→探索→计划→迭代→评分」循环打磨至成品，至少三轮，每轮必须含真功能/真优化，全程配全链路检查与安全审查。

## 评分模型（S = Σ 加权，10 分制）

| 维度 | 权重 | 评分依据 |
|---|---|---|
| 功能完整性 | 20% | 变基功能面（69 渠道/迁移 v81/日报周报/API 门户/插件渠道）可用且可配置 |
| 质量门禁 | 25% | 后端+前端 vitest 全绿、tsc 0、三端 build 绿、探针全过、无 skip 掩盖的失败 |
| 安全 | 20% | 无可达 critical/high 漏洞、Mimosa 扫描结论、docker 加固存活性、密钥卫生 |
| 部署体验 | 15% | .env 完整性、compose 变量面、CI/镜像、升级路径验证、模型拉取 |
| 文档准确性 | 10% | README/DEPLOYMENT/CHANNEL_MATRIX/OPTIONAL_FEATURES 与现实一致（数字口径） |
| 可观测性/运维 | 10% | health 面、调度器状态、日志事件、附件/降级语义 |

**达标线：S ≥ 9.0 且（无可达 critical/high 漏洞）且（全部门禁绿）且（全链路真发真收通过）。未达标继续迭代。**

## 迭代主题

- **I1 部署体验与文档准确性**：.env.example（docker 化）；compose 补全新功能可选变量；CHANNEL_MATRIX 再生（69/v81）；DEPLOYMENT 环境变量表对齐；gen-channel-matrix 校验。
- **I2 依赖安全与升级路径**：pnpm overrides 修可达漏洞（form-data critical 等）；升级路径实测——构造 v2.16 形态旧库→迁移到 v81（唯一未验证的路径）；audit 复跑归零可达面。
- **I3 全链路真发真收**：移植 vercel 的 FULLCHAIN harness（dev-webhook-receiver + dev-smtp-sink + e2e/fullchain.spec），真后端真渠道真收发；抓到即修。
- **I4 安全审查与终评**：Mimosa deep scan + 处置；docker 加固存活性复核；总体打分；达标则发版 tag v2.30.0 + push。

## 门禁基线（开工时实测）

- CI 双绿（d24cb4c，镜像构建成功）；本地后端 1680/1681 + 前端 319/319 + tsc 0
- 已知缺口：.env.example 缺失；CHANNEL_MATRIX 口径 61/v80 过期；audit 58 项（1c/22h，多为可选依赖树）；旧库升级路径未实测；FULLCHAIN 未跑

## 迭代记录（每轮：改动清单 → 验证 → 打分）
