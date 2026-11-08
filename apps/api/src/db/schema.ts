import '../services/load-dotenv.js';
import {
  pgSchema,
  varchar,
  text,
  boolean,
  integer,
  unique,
} from 'drizzle-orm/pg-core';

const activePgSchemaName =
  process.env.GLOSSA_DB_SCHEMA || process.env.PG_SCHEMA || 'glossa';
export const glossaSchema = pgSchema(activePgSchemaName);

/**
 * 0. 领域分类配置表 (lexicon_categories)
 */
export const lexiconCategories = glossaSchema.table('lexicon_categories', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(100),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});

/**
 * 1. 内部鉴权用户表 (lexicon_users)
 */
export const lexiconUsers = glossaSchema.table('lexicon_users', {
  id: varchar('id', { length: 64 }).primaryKey(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 32 }).notNull().default('admin'),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 2. 服务端登录会话表 (lexicon_sessions)
 */
export const lexiconSessions = glossaSchema.table('lexicon_sessions', {
  tokenHash: varchar('token_hash', { length: 128 }).primaryKey(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  username: varchar('username', { length: 64 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(),
  expiresAt: varchar('expires_at', { length: 32 }).notNull(),
  revokedAt: varchar('revoked_at', { length: 32 }),
  userAgent: text('user_agent'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});

/**
 * 3. 全局受控 AI Provider 配置表 (lexicon_ai_configs)
 * API Key 采用 AES-256-GCM 密文存储，前端仅可见脱敏掩码
 */
export const lexiconAiConfigs = glossaSchema.table('lexicon_ai_configs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  protocol: varchar('protocol', { length: 32 }).notNull().default('openai-compatible'),
  baseUrl: varchar('base_url', { length: 256 }).notNull().default('https://api.deepseek.com'),
  model: varchar('model', { length: 128 }).notNull().default('deepseek-chat'),
  apiKeyCipher: text('api_key_cipher').notNull().default(''),
  apiKeyIv: varchar('api_key_iv', { length: 64 }).notNull().default(''),
  apiKeyTag: varchar('api_key_tag', { length: 64 }).notNull().default(''),
  maskedKey: varchar('masked_key', { length: 64 }).notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  updatedBy: varchar('updated_by', { length: 64 }).notNull().default('system'),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 4. 领域词条主表 (lexicon_terms)
 */
export const lexiconTerms = glossaSchema.table('lexicon_terms', {
  id: varchar('id', { length: 64 }).primaryKey(),
  title: varchar('title', { length: 128 }).notNull(),
  subtitle: varchar('subtitle', { length: 256 }),
  pinyin: varchar('pinyin', { length: 128 }).notNull(),
  category: varchar('category', { length: 32 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('PUBLISHED'),
  revision: integer('revision').notNull().default(1),
  summary: text('summary').notNull(),
  laymanAnalogy: text('layman_analogy').notNull(),
  laymanPlain: text('layman_plain').notNull(),
  articleMarkdown: text('article_markdown').notNull(),
  aliasesJson: text('aliases_json').notNull().default('[]'),
  relationsJson: text('relations_json').notNull().default('[]'),
  faqsJson: text('faqs_json').notNull().default('[]'),
  engineeringJson: text('engineering_json').notNull().default('{}'),
  extJson: text('ext_json'),
  sourceCommitBatchId: varchar('source_commit_batch_id', { length: 64 }),
  maintainedBy: varchar('maintained_by', { length: 64 }).notNull().default('antigravity-v5'),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 5. 词条历史版本审计快照表 (lexicon_term_revisions)
 */
export const lexiconTermRevisions = glossaSchema.table(
  'lexicon_term_revisions',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    termId: varchar('term_id', { length: 64 }).notNull(),
    revision: integer('revision').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('PUBLISHED'),
    reason: text('reason').notNull(),
    operator: varchar('operator', { length: 64 }).notNull().default('antigravity-v5'),
    termSnapshotJson: text('term_snapshot_json').notNull(),
    pointersSnapshotJson: text('pointers_snapshot_json').notNull().default('[]'),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
  },
  (t) => [unique('lexicon_term_revisions_term_rev_uniq').on(t.termId, t.revision)]
);

/**
 * 6. 生产分支源码锚点快照表 (lexicon_code_snapshots)
 */
export const lexiconCodeSnapshots = glossaSchema.table('lexicon_code_snapshots', {
  id: varchar('id', { length: 256 }).primaryKey(),
  repo: varchar('repo', { length: 96 }).notNull(),
  branch: varchar('branch', { length: 64 }).notNull().default('prd'),
  commitSha: varchar('commit_sha', { length: 64 }).notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull(),
  lineRange: varchar('line_range', { length: 64 }).notNull(),
  content: text('content').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  indexedAt: varchar('indexed_at', { length: 32 }).notNull(),
});

/**
 * 7. 月度 PRD Commit 漂移巡检记录表 (lexicon_drift_tasks)
 */
export const lexiconDriftTasks = glossaSchema.table('lexicon_drift_tasks', {
  id: varchar('id', { length: 128 }).primaryKey(),
  termId: varchar('term_id', { length: 64 }).notNull(),
  repo: varchar('repo', { length: 96 }).notNull(),
  path: varchar('path', { length: 512 }).notNull(),
  recordedCommit: varchar('recorded_commit', { length: 64 }).notNull(),
  headCommit: varchar('head_commit', { length: 64 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('DRIFT_DETECTED'),
  diffStat: text('diff_stat'),
  resolutionNote: text('resolution_note'),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 8. 缺词雷达与划词纠错反馈工单表 (lexicon_feedback_tickets)
 */
export const lexiconFeedbackTickets = glossaSchema.table('lexicon_feedback_tickets', {
  id: varchar('id', { length: 128 }).primaryKey(),
  dedupKey: varchar('dedup_key', { length: 256 }).notNull().unique(),
  type: varchar('type', { length: 32 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('OPEN'),
  termId: varchar('term_id', { length: 64 }),
  termRevision: integer('term_revision'),
  queryOrSelection: text('query_or_selection').notNull(),
  comment: text('comment'),
  resolutionTermId: varchar('resolution_term_id', { length: 64 }),
  resolutionNote: text('resolution_note'),
  resolvedBy: varchar('resolved_by', { length: 64 }),
  reporter: varchar('reporter', { length: 64 }).notNull().default('anonymous'),
  hitCount: integer('hit_count').notNull().default(1),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 9. AI 伴读会话表 (lexicon_chat_sessions)
 */
export const lexiconChatSessions = glossaSchema.table('lexicon_chat_sessions', {
  id: varchar('id', { length: 96 }).primaryKey(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  title: varchar('title', { length: 256 }).notNull(),
  activeTermId: varchar('active_term_id', { length: 64 }),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 10. AI 伴读消息记录表 (lexicon_chat_messages)
 */
export const lexiconChatMessages = glossaSchema.table('lexicon_chat_messages', {
  id: varchar('id', { length: 96 }).primaryKey(),
  sessionId: varchar('session_id', { length: 96 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(),
  content: text('content').notNull(),
  traceJson: text('trace_json').notNull().default('[]'),
  referencedCommitsJson: text('referenced_commits_json').notNull().default('[]'),
  mode: varchar('mode', { length: 32 }).notNull().default('llm-tool-loop'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});

/**
 * 11. 方案 A：内网源码探针 Worker 节点心跳注册表 (lexicon_worker_nodes)
 * 记录挂载了 38 个 .codebase-prd 子仓的内网机器在线状态、主机名与最新同步时间
 */
export const lexiconWorkerNodes = glossaSchema.table('lexicon_worker_nodes', {
  workerId: varchar('worker_id', { length: 96 }).primaryKey(),
  hostname: varchar('hostname', { length: 128 }).notNull(),
  codebaseRoot: varchar('codebase_root', { length: 512 }).notNull(),
  repoCount: integer('repo_count').notNull().default(0),
  status: varchar('status', { length: 32 }).notNull().default('ONLINE'),
  lastHeartbeatAt: varchar('last_heartbeat_at', { length: 32 }).notNull(),
  startedAt: varchar('started_at', { length: 32 }).notNull(),
});

/**
 * 12. 方案 A：公网 Web <-> 内网源码探针 Worker 异步任务队列表 (lexicon_worker_tasks)
 * 当公网云函数无本地 .codebase-prd 时，将实时源码检索 (GREP_CODE)、按行读取并同步快照 (READ_FILE)、
 * Commit 漂移巡检 (INSPECT_DRIFT) 任务写入此表，由内网 Worker 消费后写回结果与源码快照。
 */
export const lexiconWorkerTasks = glossaSchema.table('lexicon_worker_tasks', {
  id: varchar('id', { length: 128 }).primaryKey(),
  taskType: varchar('task_type', { length: 32 }).notNull(), // 'GREP_CODE' | 'READ_FILE' | 'INSPECT_DRIFT'
  status: varchar('status', { length: 32 }).notNull().default('PENDING'), // 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  payloadJson: text('payload_json').notNull().default('{}'),
  resultJson: text('result_json'),
  errorMessage: text('error_message'),
  workerId: varchar('worker_id', { length: 96 }),
  requester: varchar('requester', { length: 64 }).notNull().default('cloud-api'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  completedAt: varchar('completed_at', { length: 32 }),
});

/**
 * 13. AI Agent Harness 触手裂变批次与全局记忆表 (lexicon_expansion_runs)
 */
export const lexiconExpansionRuns = glossaSchema.table('lexicon_expansion_runs', {
  id: varchar('id', { length: 96 }).primaryKey(),
  rootSeedType: varchar('root_seed_type', { length: 32 }).notNull().default('term'),
  rootSeedRef: varchar('root_seed_ref', { length: 128 }).notNull(),
  title: varchar('title', { length: 256 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('RUNNING'),
  maxDepth: integer('max_depth').notNull().default(2),
  maxDrafts: integer('max_drafts').notNull().default(20),
  generatedCount: integer('generated_count').notNull().default(0),
  mergedAliasCount: integer('merged_alias_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),
  memorySummary: text('memory_summary').notNull().default(''),
  operator: varchar('operator', { length: 64 }).notNull().default('antigravity-harness'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

/**
 * 14. AI Agent Harness 触手分叉与决策记忆账本 (lexicon_expansion_candidates)
 */
export const lexiconExpansionCandidates = glossaSchema.table('lexicon_expansion_candidates', {
  id: varchar('id', { length: 128 }).primaryKey(),
  runId: varchar('run_id', { length: 96 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  normalizedName: varchar('normalized_name', { length: 128 }).notNull().unique(),
  category: varchar('category', { length: 32 }).notNull().default('general'),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'),
  depth: integer('depth').notNull().default(1),
  originsJson: text('origins_json').notNull().default('[]'),
  recommendedAction: varchar('recommended_action', { length: 32 }).notNull().default('GENERATE_TERM'),
  recommendedTargetTermId: varchar('recommended_target_term_id', { length: 64 }),
  recommendedTargetTermTitle: varchar('recommended_target_term_title', { length: 128 }),
  recommendationReason: text('recommendation_reason').notNull().default(''),
  decisionAction: varchar('decision_action', { length: 32 }),
  decisionNote: text('decision_note'),
  targetTermId: varchar('target_term_id', { length: 64 }),
  operator: varchar('operator', { length: 64 }).notNull().default('antigravity-harness'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});
