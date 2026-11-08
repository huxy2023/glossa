# Glossa — AI 领域知识与业务参谋工程规范 (AGENTS.md)

## 1. 产品定位与第一性原理

- **Glossa** 是连接「底层多仓源码事实」与「人类业务共同语言」的开源领域百科、端到端流程攻略（ASOP）与 AI 业务参谋引擎。
- **纯空壳引擎红线**：仓库代码中严禁硬编码任何单一业务项目的私有词条、表名或内部业务规则；所有项目特定知识一律通过 PostgreSQL 数据库、`GLOSSA_WORKSPACE_ROOT` 代码探针及快照文件（`pnpm data:import`）动态承载。
- **纯粹业务语言**：面向读者展示的词条正文、业务说明、直观类比与排障 FAQ 必须使用业务、产品、运营可直观理解的语言，严禁在正文中裸露底层代码类名、物理表名或 Git Commit 哈希（代码指针统一收拢在 `engineering` 元数据层供溯源探针内部使用）。

## 2. 核心架构约束

1. **单语句原子快照与乐观并发锁**：
   - 任何词条新建、编辑、发布与回滚操作必须通过 `lexiconStore.saveTermAsync` 原子写入 `lexicon_terms` 与 `lexicon_term_revisions`，并校验 `expectedRevision` 防止并发覆写。
2. **双模参谋驾驭（Business Advisor & Skills）**：
   - 模式 A（秒级响应）：通过 `lexiconStore` 语义短语召回 + `grepPrdCode` 源码检索 + `readPrdFile` 上下文切片精读，注入大模型按四大技能契约（排障、方案推演、统计口径、潜台词拆解）输出实证报告。
   - 模式 B（深度沙箱）：调度本机或内网 Worker 上的 `codex exec --sandbox read-only` 在 `GLOSSA_WORKSPACE_ROOT` 执行只读源码核验。
3. **安全基线**：
   - AI Base URL 严格执行 HTTPS 与域名白名单校验（防 SSRF）。
   - 源码探针严格执行 `validateRepoAndRelativePath`（防路径穿越）。
   - 大模型 API Key 采用 `GLOSSA_MASTER_KEY` 派生的 AES-256-GCM 密文存储。

## 3. 自检命令

- 全量类型检查：`pnpm typecheck`
- 后端与存储集成测试：`pnpm test`
- 生产构建验证：`pnpm build`
