# Glossa — AI 领域知识与业务参谋工程规范 (AGENTS.md)

## 1. 产品定位与第一性原理

- **Glossa** 是连接「底层多仓源码事实」与「人类业务共同语言」的开源领域百科、端到端流程攻略（ASOP）与 AI 业务参谋引擎。
- **纯空壳引擎红线**：仓库代码中严禁硬编码任何单一业务项目的私有词条、表名或内部业务规则；所有项目特定知识一律通过 PostgreSQL 数据库、`GLOSSA_WORKSPACE_ROOT` 代码探针及快照文件（`pnpm data:import`）动态承载。
- **唯一事实源铁律（Single Source of Truth）**：
  - 在目标工作区（`GLOSSA_WORKSPACE_ROOT`）执行代码核验、词条编撰或业务参谋作答时，**只以真实业务源码（Controller / Service / Domain / Store / View / SQL Schema）为唯一事实源**。
  - **严禁采信目标仓内的 `docs/`、`docs-site/` 或历史 `.md` 设计文档**，防止过时 PRD 污染词条定义与参谋结论。
- **台前纯粹业务语言 + 幕后精准源码锚点**：
  - **台前展示（`definition` / `layman` / `summary` / `articleMarkdown` / `faqs`）**：必须使用业务、产品、运营与新入职研发可直观理解的业务语言，**严禁裸露代码文件名（`.java/.ts/.kt/.vue`）、类名、物理表字段或 `@commit` 哈希**。
  - **幕后锚点（`engineering.repos` / `engineering.pointers` / `engineering.dataMappings`）**：必须如实沉淀支撑该业务规则的源码文件、精确行号区间、Git Commit SHA 及核心表字段映射，供漂移巡检与业务参谋搭桥检索使用。

## 2. 词条与攻略编撰规范（V5「标准导读外壳 + 因词制宜自由表达内芯」）

1. **反八股文模具（拒绝千词一面）**：
   - 外壳导读保持统一结构（一句话业务定义、大白话类比、易混概念对照、至少 2~3 条高频排障 FAQ、双向血缘网络）。
   - 正文内芯（`articleMarkdown`）必须根据词条属性**因词制宜**选择最贴切的章节组织：
     - **架构/机制型词条**：聚焦「核心设计动机 $\rightarrow$ 运转闭环与关键判定条件 $\rightarrow$ 异常降级与边界保护」；
     - **单据/状态流转型词条**：聚焦「生命周期阶段表 $\rightarrow$ 合法流转路径与触发动作 $\rightarrow$ 逆向回退/冲正规则」；
     - **金额/核算口径型词条**：聚焦「计算公式与抵扣优先级 $\rightarrow$ 计入/剔除边界对照表 $\rightarrow$ 跨角色对账差异排查」；
     - **端到端流程攻略（`category === "asop"`）**：聚焦「跨角色协作泳道 $\rightarrow$ 分阶段业务动作与卡点清单 $\rightarrow$ 常见断流现场与人工应急」。
2. **去 AI 味与排版红线**：
   - 严禁使用「赋能、抓手、闭环生态、底层逻辑、组合拳」等空洞套话；每句话必须传递可验证的业务规则、判定阈值或流转结果。
   - 正文与标题中**严禁穿插装饰性 Emoji 图标**，保持专业、克制、高信息密度的百科质感。
   - 如使用 Mermaid 流程图，节点文本若包含括号 `()`、方括号 `[]`、斜杠 `/` 或空格，必须使用双引号包裹（如 `A["节点描述 (补充)"]`），严禁出现裸特殊字符导致渲染失败。
3. **分类精准归属与新芽准入过滤**：
   - `asop` 分类仅限端到端跨角色业务流程攻略；普通业务概念萌发（Sprout）必须按业务域语义归入对应领域分类，严禁盲目继承父词条的 `asop` 分类。
   - 严禁将表格列名/动作短语（如「填报角色」「操作步骤」「处理动作」）或纯技术基础设施名词（如 `Redis`、`TDMQ`、`Controller`、`分布式锁`）作为领域词条入库。

## 3. Agent Harness 标准作业闭环（SOP）

维护或扩充词库时，必须通过内置 Harness 工具链闭环执行，严禁绕过引擎手工拼接残缺 JSON：

1. **检索对齐与盘点**：`pnpm glossa list` / `pnpm glossa lookup "<关键词>"` — 检查既有词条、分类与血缘关系，避免同义词重复建档；
2. **冷启动建词与源码举证**：`pnpm glossa generate "<词条或攻略名称>" [--category core|asop|...] [--context "<代码标识符>"] [--publish]` — 新项目冷启动或新增独立概念时，自动检索 `GLOSSA_WORKSPACE_ROOT` 源码并沉淀指针生成词条；
3. **概念解剖**：`pnpm glossa dissect <termId>`（或 `pnpm glossa dissect --text "<种子文本>" --title "<来源标题>"`）— 扫描词条正文并经噪音/技术词过滤器提炼候选新芽（Sprouts）；
4. **触手决议与波次裂变**：`pnpm glossa resolve <sproutId>` 或 `pnpm glossa run-wave <termId>` — 自动联动 `grepPrdCode` + `readPrdFile` 提取真实源码指针，生成词条并建立父子双向血缘；
5. **业务参谋实证推演**：`pnpm glossa consult "<业务问题>" [--skill troubleshooting|solution-design|metrics-analytics|jargon-demystify]` — 词典召回 + 源码探针搭桥 + 参谋技能作答；
6. **词库健康巡检与自愈**：`pnpm glossa audit --fix`（或 `POST /api/harness/audit`）— 自动扫描并修复正文中残留的代码文件名/Commit 泄露、错误分类归属、单向断链血缘及正文中已提及却未绑定 `relations` 的孤岛词条；
7. **代码漂移巡检**：`pnpm glossa drift` — 核验各词条 `engineering.pointers` 关联的 Git Commit 与源码行是否发生变更。

## 4. 核心架构约束

1. **单语句原子快照与乐观并发锁**：
   - 任何词条新建、编辑、发布与回滚操作必须通过 `lexiconStore.saveTermAsync` 原子写入 `lexicon_terms` 与 `lexicon_term_revisions`，并校验 `expectedRevision` 防止并发覆写。
2. **双模参谋驾驭（Business Advisor & Skills）**：
   - **多轮指代继承**：连续追问时自动继承前序轮次的领域词条与核心主语，确保省略主语的追问（如「那怎么改配置？」）仍能精准命中词条与源码。
   - **词条指针与表字段搭桥**：参谋检索源码时，自动将命中词条的 `engineering.pointers` 与 `engineering.dataMappings`（表名/字段名）注入源码探针查询并赋予高优先级权重。
   - **双模执行**：模式 A（秒级响应：词库召回 + 源码探针 + 大模型综合）与模式 B（深度沙箱：`codex exec --sandbox read-only` 只读核验源码并忽略 `docs/*.md`）。
3. **安全基线**：
   - AI Base URL 严格执行 HTTPS 与域名白名单校验（防 SSRF）。
   - 源码探针严格执行 `validateRepoAndRelativePath`（防路径穿越）。
   - 大模型 API Key 采用 `GLOSSA_MASTER_KEY` 派生的 AES-256-GCM 密文存储。

## 5. 自检命令

- 全量类型检查：`pnpm typecheck`
- 后端与存储集成测试：`pnpm test`
- 词库质量审计：`pnpm glossa audit`
- 生产构建验证：`pnpm build`
