import { z } from 'zod';

/**
 * 领域分类 ID 契约：支持任意项目自定义领域分类（如 core / workflow / policy / asop 等）
 */
export const CategoryIdSchema = z.string().min(1).default('general');

export type CategoryId = z.infer<typeof CategoryIdSchema>;

/**
 * 演进留白 1：词条生命周期状态枚举（严禁使用 is_published 单一布尔值）
 * 支持未来从 Git JSON 平滑演进至在线多人编审工作流：
 * DRAFT (AI/人工草稿) -> PENDING_REVIEW (待领域专家复核) -> PUBLISHED (正式发布) -> DEPRECATED / ARCHIVED (废弃归档)
 */
export const TermLifecycleStatusSchema = z.enum([
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'DEPRECATED',
  'ARCHIVED',
]);

export type TermLifecycleStatus = z.infer<typeof TermLifecycleStatusSchema>;

/**
 * 演进留白 2：月度 PRD Commit 漂移巡检工单状态机（严禁使用 is_synced 单一布尔值）
 */
export const DriftTaskStatusSchema = z.enum([
  'SYNCED',
  'DRIFT_DETECTED',
  'AI_DRAFT_READY',
  'APPLIED',
  'DISMISSED_NO_SEMANTIC_CHANGE',
]);

export type DriftTaskStatus = z.infer<typeof DriftTaskStatusSchema>;

/**
 * 演进留白 3：全员共创反馈与搜索缺词雷达工单类型与状态机
 */
export const FeedbackTicketTypeSchema = z.enum([
  'MISSING_TERM',
  'CONTENT_CORRECTION',
  'COMMIT_OUTDATED',
  'QUESTION_ARCHIVE',
]);

export type FeedbackTicketType = z.infer<typeof FeedbackTicketTypeSchema>;

export const FeedbackTicketStatusSchema = z.enum([
  'OPEN',
  'TRIAGING',
  'RESOLVED_UPDATED',
  'REJECTED',
]);

export type FeedbackTicketStatus = z.infer<typeof FeedbackTicketStatusSchema>;

export const CodePointerSchema = z.object({
  repo: z.string(),
  branch: z.string().default('prd'),
  commit: z.string(),
  path: z.string(),
  lines: z.string().optional(),
  symbol: z.string().optional(),
  desc: z.string(),
});

export type CodePointer = z.infer<typeof CodePointerSchema>;

export const DataMappingSchema = z.object({
  db: z.string(),
  table: z.string(),
  field: z.string(),
  rule: z.string(),
});

export type DataMapping = z.infer<typeof DataMappingSchema>;

/**
 * V5 词条「最小机器外壳 + Commit 溯源」契约
 * 仅约束保证 UI 交互（目录、自动双链、悬停卡片、顶部比喻/白话双卡）正常运转的最小外壳；
 * 正文 articleMarkdown 完全自由表达，不设固定八股文模板限制。
 */
export const TermEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  pinyin: z.string(),
  category: CategoryIdSchema,
  aliases: z.array(z.string()).default([]),
  summary: z.string(),
  layman: z.object({
    analogy: z.string(),
    plain: z.string(),
  }),
  articleMarkdown: z.string(),
  engineering: z
    .object({
      repos: z.array(z.string()).default([]),
      pointers: z.array(CodePointerSchema).default([]),
      dataMappings: z.array(DataMappingSchema).default([]),
    })
    .optional(),
  relations: z
    .array(
      z.object({
        target: z.string(),
        label: z.string(),
      })
    )
    .default([]),
  faqs: z
    .array(
      z.object({
        q: z.string(),
        a: z.string(),
      })
    )
    .default([]),
  meta: z
    .object({
      updatedAt: z.string().default('2026-11-06'),
      maintainedBy: z.string().default('antigravity-v5'),
      status: TermLifecycleStatusSchema.default('PUBLISHED'),
      revision: z.number().int().min(1).default(1),
      sourceCommitBatchId: z.string().optional(),
      ext: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type TermEntry = z.infer<typeof TermEntrySchema>;

/**
 * 演进留白 4：词条历史版本快照审计记录 (对应未来数据库 lexicon_term_revisions 表)
 * 记录每次因 PRD Commit 升级或人工/AI 修订产生的历史快照，确保随时可追溯、可回滚。
 */
export const TermRevisionRecordSchema = z.object({
  id: z.string(),
  termId: z.string(),
  revision: z.number().int().min(1),
  status: TermLifecycleStatusSchema.default('PUBLISHED'),
  reason: z.string(),
  operator: z.string().default('antigravity-v5'),
  termSnapshot: TermEntrySchema.optional(),
  pointersSnapshot: z.array(CodePointerSchema).default([]),
  createdAt: z.string(),
});

export type TermRevisionRecord = z.infer<typeof TermRevisionRecordSchema>;

/**
 * 演进留白 5：月度 PRD Commit 增量漂移巡检任务记录 (对应未来数据库 lexicon_drift_tasks 表)
 */
export const DriftTaskRecordSchema = z.object({
  id: z.string(),
  termId: z.string(),
  repo: z.string(),
  path: z.string(),
  recordedCommit: z.string(),
  headCommit: z.string(),
  status: DriftTaskStatusSchema.default('DRIFT_DETECTED'),
  diffStat: z.string().optional(),
  resolutionNote: z.string().optional(),
  updatedAt: z.string(),
});

export type DriftTaskRecord = z.infer<typeof DriftTaskRecordSchema>;

/**
 * 演进留白 6：全员搜索零命中缺词雷达与划词纠错工单 (对应未来数据库 lexicon_feedback_tickets 表)
 */
export const FeedbackTicketSchema = z.object({
  id: z.string(),
  type: FeedbackTicketTypeSchema,
  status: FeedbackTicketStatusSchema.default('OPEN'),
  termId: z.string().optional(),
  termRevision: z.number().int().optional(),
  queryOrSelection: z.string(),
  comment: z.string().optional(),
  resolutionTermId: z.string().optional(),
  resolutionNote: z.string().optional(),
  resolvedBy: z.string().optional(),
  reporter: z.string().default('anonymous'),
  hitCount: z.number().int().min(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FeedbackTicket = z.infer<typeof FeedbackTicketSchema>;

export const AIConfigSchema = z.object({
  protocol: z.enum(['openai-compatible', 'anthropic-messages']).default('openai-compatible'),
  baseUrl: z.string().default('https://api.deepseek.com'),
  model: z.string().default('deepseek-chat'),
  apiKey: z.string().default(''),
});

export type AIConfig = z.infer<typeof AIConfigSchema>;

export interface AgentTraceStep {
  tool: string;
  summary: string;
  detail?: string;
}

/**
 * 演进留白 7：「抓到触手，引爆全场，处处生花」AI Agent Harness 触手裂变与繁衍记忆契约
 */
export const CandidateActionSchema = z.enum([
  'GENERATE_TERM',
  'MERGE_AS_ALIAS',
  'LINK_EXISTING',
  'REJECT',
]);

export type CandidateAction = z.infer<typeof CandidateActionSchema>;

export const CandidateStatusSchema = z.enum([
  'PENDING',
  'GENERATED',
  'MERGED_ALIAS',
  'LINKED_EXISTING',
  'REJECTED',
]);

export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const CandidateOriginSchema = z.object({
  sourceTermId: z.string(),
  sourceTermTitle: z.string(),
  quote: z.string(),
  relationLabel: z.string().default('核心关联概念'),
  whyItMatters: z.string(),
});

export type CandidateOrigin = z.infer<typeof CandidateOriginSchema>;

export const ExpansionCandidateSchema = z.object({
  id: z.string(),
  runId: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  category: CategoryIdSchema.default('general'),
  status: CandidateStatusSchema.default('PENDING'),
  depth: z.number().int().min(1).default(1),
  origins: z.array(CandidateOriginSchema).default([]),
  recommendedAction: CandidateActionSchema.default('GENERATE_TERM'),
  recommendedTargetTermId: z.string().optional(),
  recommendedTargetTermTitle: z.string().optional(),
  recommendationReason: z.string().default(''),
  decisionAction: CandidateActionSchema.optional(),
  decisionNote: z.string().optional(),
  targetTermId: z.string().optional(),
  operator: z.string().default('antigravity-harness'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ExpansionCandidate = z.infer<typeof ExpansionCandidateSchema>;

export const ExpansionRunStatusSchema = z.enum(['RUNNING', 'PAUSED', 'COMPLETED']);

export type ExpansionRunStatus = z.infer<typeof ExpansionRunStatusSchema>;

export const ExpansionRunSchema = z.object({
  id: z.string(),
  rootSeedType: z.enum(['term', 'text']).default('term'),
  rootSeedRef: z.string(),
  title: z.string(),
  status: ExpansionRunStatusSchema.default('RUNNING'),
  maxDepth: z.number().int().min(1).default(2),
  maxDrafts: z.number().int().min(1).default(20),
  generatedCount: z.number().int().min(0).default(0),
  mergedAliasCount: z.number().int().min(0).default(0),
  rejectedCount: z.number().int().min(0).default(0),
  memorySummary: z.string().default(''),
  operator: z.string().default('antigravity-harness'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ExpansionRun = z.infer<typeof ExpansionRunSchema>;

export interface SimilarTermRecall {
  id: string;
  title: string;
  category: CategoryId;
  aliases: string[];
  summary: string;
  similarityScore: number;
  matchHint: string;
}

export interface ConceptLookupResult {
  query: string;
  normalizedQuery: string;
  exactMatch: {
    termId: string;
    title: string;
    category: CategoryId;
    matchedVia: 'id' | 'title' | 'alias';
    aliases: string[];
    summary: string;
  } | null;
  memoryMatch: ExpansionCandidate | null;
  similarTerms: SimilarTermRecall[];
}
