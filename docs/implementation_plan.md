# Glossa · 系统架构与模块实施方案 (Implementation Plan)

## 1. 模块划分

### 1.1 `@glossa/schema` (`packages/schema/src/index.ts`)
- 定义前后端共享的 Zod 契约：
  - `CategoryIdSchema`：支持任意项目自定义分类标识（`string`）。
  - `TermEntrySchema`：词条核心结构（`id`, `title`, `category`, `aliases`, `summary`, `layman`, `articleMarkdown`, `engineering`, `relations`, `faqs`, `meta`）。
  - `ExpansionRunSchema` / `ExpansionCandidateSchema`：触手裂变批次与候选词三路决议契约。

### 1.2 `@glossa/api` (`apps/api/src/`)
- `db/schema.ts` & `services/pg-database.ts`：
  - 基于 Drizzle ORM + `pg.Pool` 的 PostgreSQL 存储层，支持通过 `GLOSSA_DB_SCHEMA` 自定义数据库 Schema，内置 `.env` 自动加载与 AES-256-GCM 密钥加解密。
- `services/stores/`：
  - `db-bootstrap.ts`：纯空壳幂等建表（含 `lexicon_categories`、`lexicon_terms`、`lexicon_term_revisions` 等 15 张表）。
  - `auth-and-ops-store.ts`：会话鉴权、AI 配置管理、源码快照存储与内网 Worker 任务队列。
  - `concept-matcher.ts`：概念归一化、精确/别名查重与 Top-5 相似词召回。
  - `harness-memory-store.ts`：触手裂变批次统计、候选词原子入队与进程内/跨进程并发防重锁。
- `services/codebase-probe.ts`：
  - 动态扫描 `GLOSSA_WORKSPACE_ROOT` 下的单仓或多仓 Git 目录，提供带路径越界防护（`validateRepoAndRelativePath`）的 `grepPrdCode`、`readPrdFile` 与 `inspectTermsDrift`。
- `services/advisor-skills.ts`：
  - 业务参谋四大技能路由、动态领域词锚点提取、多轮会话上下文继承、源码切片预取与 Codex CLI 沙箱调度。
- `services/sprout-engine.ts` & `services/term-synthesis.ts`：
  - 词条自动考据合成、顺藤摸瓜触手剖析与多波次 BFS 裂变引擎。

### 1.3 `@glossa/web` (`apps/web/src/`)
- `components/WorkbenchShells.tsx`：顶栏分段导航、左侧全高可折叠分类目录树、移动端自适应抽屉与登录门禁。
- `components/TermArticleView.tsx`：词条双卡片导读、富文本正文、Mermaid + Panzoom 交互式流程图与本词条 FAQ 折叠区。
- `components/FaqAndDecoderViews.tsx`：业务参谋多轮连续咨询工作台（含技能切换、执行引擎切换、AI 问 AI 接口契约）与排障 FAQ 检索中心。
- `components/RelationCompareWorkspace.tsx`：零画布关联导览与任意双词条并排对比工作台。
- `components/RightCompanionDrawer.tsx`：按需滑出的右侧词条速览（支持面包屑多级回退）与伴读问答抽屉。

---

## 2. 跨项目迁移与备份机制

- **导出知识库快照**：`pnpm data:export ./snapshot.json`
- **导入知识库快照**：`pnpm data:import ./snapshot.json`
- **空库引导**：当连接的 PostgreSQL 数据库尚无词条时，Web 端自动展示「欢迎使用 Glossa · 播种首个词条」引导卡片。
