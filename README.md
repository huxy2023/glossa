# Glossa · 从真实代码底座生长出来的领域百科、业务攻略与 AI 参谋引擎

> *Glossa* (`/ˈɡlɒs.ə/`)，源自古希腊语与中世纪手稿学中「智者在法典页边写下的精辟注解与暗语破译」，也是现代英语 *Glossary*（词典）的词源。

**Glossa** 是一套**纯空壳、零项目硬编码**的开源领域知识与业务参谋工作台。它直接连接你的本地/内网多仓源码库（Single-Repo 或 Multi-Repo）与 PostgreSQL 数据库，把晦涩分散的底层代码实证，转化为业务、产品、运营与研发团队全员同频的**交互式领域百科、端到端业务流程攻略（ASOP）与多轮 AI 业务参谋**。

---

## 核心特性

1. **纯空壳引擎 + 数据库自洽架构（Zero Domain Hardcoding）**：
   - 引擎代码仓不内置任何特定企业的私有业务词条或硬编码分类；所有领域分类（`lexicon_categories`）、词条（`lexicon_terms`）、历史版本快照（`lexicon_term_revisions`）与裂变记忆完全存储于 PostgreSQL。
   - 支持任意项目通过 `.env` 配置 `GLOSSA_WORKSPACE_ROOT` 指向自己的代码仓目录，并通过 `pnpm data:export` / `pnpm data:import` 一键备份或迁移整座领域知识库。
2. **统一结构导读 + 因词制宜的正文表达**：
   - **顶部导读卡**：每个词条统一提供分类标签、标准别名、一句话定义，以及左右并排的 **【直观类比 | 业务说明】** 双卡片，零行业背景即可快速建立直觉。
   - **自由富文本正文 (`articleMarkdown`)**：根据概念特性灵活呈现业务对比表、Mermaid + Panzoom 交互式流程图、角色协同关系与异常处理边界。
   - **全自动双链与渐进式阅读**：正文与表格中出现的领域术语及同义别名自动生成双链（`.term-link`），支持鼠标悬停预览与右侧抽屉连续下钻。
3. **四大核心工作台视图（顶栏分段切换，与左侧目录树联动）**：
   - **词典与攻略 (`article`)**：核心领域词条与端到端业务流程攻略（ASOP）。
   - **业务参谋 (`decoder`)**：内置四大参谋技能（**现场疑难排障、需求方案推演、统计口径分析、术语潜台词拆解**），支持多轮连续追问会话、双模执行驾驭（秒级「词典+源码探针」与「Codex CLI 只读沙箱深潜」），并提供外部 Agent「AI 问 AI」标准接口 `/api/agent/consult`。
   - **排障 FAQ (`faq-hub`)**：高频业务疑难问答检索，支持按「当前词条及上下游 / 当前分类 / 全库」切换范围。
   - **关联与对比 (`graph`)**：展示当前词条参与的业务流程与直接上下游关联，支持任意两词条并排对比与最短关联路径推导。
4. **双入口触手裂变与同义归并引擎（AI Agent Harness）**：
   - 支持通过 CLI（`pnpm glossa`）或 Web 端「触手裂变」面板驱动多层级顺藤摸瓜剖析、数据库查重与三路自动分流（`MERGE_AS_ALIAS` 同义别名归并、`GENERATE_TERM` 独立新词生成、`REJECT` 噪音剔除记忆）。

---

## 目录结构

```text
glossa/
├── .env.example               # 环境变量模板（数据库连接、源码仓路径、加密主密钥）
├── AGENTS.md                  # AI 协作与词条维护规范
├── README.md                  # 项目说明与快速启动指南
├── docker-compose.yml         # 本地 PostgreSQL 17 容器编排
├── docs/
│   ├── BLUEPRINT.md           # 产品与系统架构蓝图
│   └── implementation_plan.md # 系统架构与模块实施方案
├── packages/
│   └── schema/                # 前后端共享的 Zod 数据契约 (@glossa/schema)
├── apps/
│   ├── api/                   # Hono + Drizzle ORM + PostgreSQL 后端服务 (@glossa/api, 端口 8790)
│   └── web/                   # React + Vite 双端自适应前端工作台 (@glossa/web, 端口 5180)
└── scripts/
    ├── harness-cli.ts         # 本地管理端触手裂变与同义归并 CLI
    ├── data-snapshot.ts       # 知识库 JSON 快照导出与导入工具
    └── schema.sql             # PostgreSQL 表结构定义
```

---

## 快速开始

```bash
# 1. 复制环境变量配置并按需修改 GLOSSA_WORKSPACE_ROOT 等参数
cp .env.example .env

# 2. 启动本地 PostgreSQL 数据库（若使用已有数据库可跳过）
docker compose up -d

# 3. 安装依赖并启动前后端开发服务 (Web: http://localhost:5180, API: http://localhost:8790)
pnpm install
pnpm dev

# 4. AI Agent Harness 触手裂变 CLI
pnpm glossa status
pnpm glossa lookup "核心概念名"
pnpm glossa dissect <termId>
pnpm glossa run-wave <seedTermId> --depth 2 --max-drafts 10

# 5. 导出或导入领域知识库快照
pnpm data:export ./my-domain-snapshot.json
pnpm data:import ./my-domain-snapshot.json

# 6. 类型检查、自动化测试与生产构建
pnpm typecheck
pnpm test
pnpm build
```
