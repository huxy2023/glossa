import crypto from 'node:crypto';
import {
  TermEntrySchema,
  TermRevisionRecordSchema,
  FeedbackTicketSchema,
  type CategoryId,
  type TermEntry,
  type TermRevisionRecord,
  type FeedbackTicket,
  type FeedbackTicketType,
  type CandidateAction,
  type CandidateOrigin,
  type ExpansionCandidate,
  type ExpansionRun,
  type ConceptLookupResult,
} from '@glossa/schema';
import {
  pgQuery,
  pgExecute,
  getDrizzleDb,
  getDbDriverMode,
} from './pg-database.js';
import * as dbSchema from '../db/schema.js';
import {
  type CategoryItem,
  DEFAULT_CATEGORIES,
  sortTerms,
  rowToTermEntry,
  loadLocalSeedTerms,
  bootstrapDatabaseTablesAndSeeds,
} from './stores/db-bootstrap.js';
import {
  type AuthSessionUser,
  type PublicAiConfig,
  type ServerAiConfig,
  type ChatTurnMessage,
  type WorkerNodeStatus,
  authenticateUserSql,
  verifySessionTokenSql,
  revokeSessionTokenSql,
  getPublicAiConfigSql,
  getServerAiConfigSql,
  updateAiConfigSql,
  getCodeSnapshotFromPgSql,
  getAllCodeSnapshotsFromPgSql,
  listChatSessionsSql,
  getChatMessagesSql,
  saveChatTurnSql,
  upsertCodeSnapshotSql,
  registerWorkerHeartbeatSql,
  getWorkerStatusSql,
  enqueueWorkerTaskSql,
  waitForWorkerTaskSql,
  claimNextWorkerTaskSql,
  completeWorkerTaskSql,
} from './stores/auth-and-ops-store.js';
import {
  normalizeConceptName,
  lookupConceptSql,
  bindTermRelationBidirectionalSql,
} from './stores/concept-matcher.js';
import {
  mergeConceptAsAliasSql,
  ensureExpansionRunSql,
  refreshRunStatsSql,
  enqueueCandidatesSql,
  getCandidateByIdOrNameSql,
  withCandidateResolutionLock,
  resolveCandidateSql,
  getHarnessOverviewSql,
} from './stores/harness-memory-store.js';

export type {
  CategoryItem,
  AuthSessionUser,
  PublicAiConfig,
  ServerAiConfig,
  ChatTurnMessage,
  WorkerNodeStatus,
};

class LexiconStore {
  public readonly schema = dbSchema;
  public get db() {
    return getDrizzleDb();
  }
  public get driverName(): 'drizzle-pg-tcp' | 'drizzle-cloudbase-http' {
    return getDbDriverMode();
  }
  private categories: CategoryItem[] = DEFAULT_CATEGORIES;
  private termsCache: TermEntry[] = [];
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor() {
    this.categories = DEFAULT_CATEGORIES;
    this.termsCache = loadLocalSeedTerms();
  }

  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await bootstrapDatabaseTablesAndSeeds(this.termsCache);
      await this.refreshFromPg();
      this.initialized = true;
    })();

    return this.initPromise;
  }

  public async refreshFromPg(): Promise<TermEntry[]> {
    try {
      const catRows = await pgQuery(
        `SELECT id, name FROM lexicon_categories ORDER BY sort_order ASC, id ASC`
      );
      if (catRows.length > 0) {
        this.categories = catRows.map((r: any) => ({
          id: String(r.id),
          name: String(r.name),
        }));
      }
    } catch {
      // keep existing categories if table not ready
    }

    const rows = await pgQuery(`SELECT * FROM lexicon_terms`);
    this.termsCache = sortTerms(rows.map(rowToTermEntry));

    const knownCatIds = new Set(this.categories.map((c) => c.id));
    for (const t of this.termsCache) {
      if (t.category && !knownCatIds.has(t.category)) {
        knownCatIds.add(t.category);
        this.categories.push({ id: t.category, name: t.category });
      }
    }
    return this.termsCache;
  }

  public getCategories(): CategoryItem[] {
    return this.categories;
  }

  public getTerms(): TermEntry[] {
    return this.termsCache;
  }

  public async getTermsAsync(): Promise<TermEntry[]> {
    await this.ensureInitialized();
    return this.refreshFromPg();
  }

  public getTermById(id: string): TermEntry | undefined {
    return this.termsCache.find((t) => t.id === id);
  }

  public async getTermByIdAsync(id: string): Promise<TermEntry | undefined> {
    await this.ensureInitialized();
    const rows = await pgQuery(`SELECT * FROM lexicon_terms WHERE id = $1 LIMIT 1`, [id]);
    if (rows.length === 0) return undefined;
    return rowToTermEntry(rows[0]);
  }

  /**
   * 单语句 CTE 原子保存词条 + 写入完整词条快照 (lexicon_term_revisions)
   * 支持乐观并发控制 (expectedRevision)，若版本冲突抛出 ConflictError (409)
   */
  public async saveTermAsync(
    term: TermEntry,
    reason = '源码考据与词条修订',
    operator = 'antigravity-v5',
    expectedRevision?: number
  ): Promise<TermEntry> {
    await this.ensureInitialized();
    const nowIso = new Date().toISOString();
    const nowDate = nowIso.slice(0, 10);

    const existing = await this.getTermByIdAsync(term.id);
    if (expectedRevision !== undefined && existing && existing.meta?.revision !== expectedRevision) {
      const err: any = new Error(
        `版本冲突 (409)：当前词条最新 revision 为 ${existing.meta?.revision}，但请求基准为 ${expectedRevision}`
      );
      err.status = 409;
      throw err;
    }

    const nextRev = existing ? (existing.meta?.revision || 1) + 1 : 1;
    const enriched: TermEntry = TermEntrySchema.parse({
      ...term,
      meta: {
        updatedAt: nowDate,
        maintainedBy: operator,
        status: term.meta?.status || 'PUBLISHED',
        revision: nextRev,
        sourceCommitBatchId: term.meta?.sourceCommitBatchId,
        ext: term.meta?.ext,
      },
    });

    const revId = `rev_${enriched.id}_v${nextRev}_${Date.now()}`;
    const snapshotJson = JSON.stringify(enriched);
    const pointersJson = JSON.stringify(enriched.engineering?.pointers || []);

    const cteRows = await pgExecute(
      `WITH upserted AS (
         INSERT INTO lexicon_terms (
           id, title, subtitle, pinyin, category, status, revision, summary,
           layman_analogy, layman_plain, article_markdown, aliases_json,
           relations_json, faqs_json, engineering_json, ext_json, maintained_by, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           pinyin = EXCLUDED.pinyin,
           category = EXCLUDED.category,
           status = EXCLUDED.status,
           revision = lexicon_terms.revision + 1,
           summary = EXCLUDED.summary,
           layman_analogy = EXCLUDED.layman_analogy,
           layman_plain = EXCLUDED.layman_plain,
           article_markdown = EXCLUDED.article_markdown,
           aliases_json = EXCLUDED.aliases_json,
           relations_json = EXCLUDED.relations_json,
           faqs_json = EXCLUDED.faqs_json,
           engineering_json = EXCLUDED.engineering_json,
           ext_json = EXCLUDED.ext_json,
           maintained_by = EXCLUDED.maintained_by,
           updated_at = EXCLUDED.updated_at
         WHERE ($18::INTEGER IS NULL OR lexicon_terms.revision = $18::INTEGER)
         RETURNING *
       ),
       rev_ins AS (
         INSERT INTO lexicon_term_revisions (
           id, term_id, revision, status, reason, operator, term_snapshot_json, pointers_snapshot_json, created_at
         )
         SELECT $19, id, revision, status, $20, maintained_by, $21, $22, $23
         FROM upserted
         RETURNING id
       )
       SELECT * FROM upserted`,
      [
        enriched.id,
        enriched.title,
        enriched.subtitle || null,
        enriched.pinyin,
        enriched.category,
        enriched.meta?.status || 'PUBLISHED',
        enriched.summary,
        enriched.layman.analogy,
        enriched.layman.plain,
        enriched.articleMarkdown,
        JSON.stringify(enriched.aliases || []),
        JSON.stringify(enriched.relations || []),
        JSON.stringify(enriched.faqs || []),
        JSON.stringify(enriched.engineering || { repos: [], pointers: [], dataMappings: [] }),
        enriched.meta?.ext ? JSON.stringify(enriched.meta.ext) : null,
        operator,
        nowDate,
        expectedRevision !== undefined ? expectedRevision : null,
        revId,
        reason,
        snapshotJson,
        pointersJson,
        nowIso,
      ]
    );

    if (cteRows.length === 0) {
      const err: any = new Error('并发更新冲突 (409)，请刷新后重试');
      err.status = 409;
      throw err;
    }

    await this.refreshFromPg();
    return rowToTermEntry(cteRows[0]);
  }

  public async publishTermAsync(
    termId: string,
    operator = 'admin',
    expectedRevision?: number
  ): Promise<TermEntry | null> {
    const existing = await this.getTermByIdAsync(termId);
    if (!existing) return null;
    const targetExpectedRev =
      expectedRevision !== undefined && Number.isFinite(Number(expectedRevision))
        ? Number(expectedRevision)
        : existing.meta?.revision;
    const updated: TermEntry = {
      ...existing,
      meta: {
        revision: existing.meta?.revision || 1,
        status: 'PUBLISHED',
        updatedAt: new Date().toISOString(),
        maintainedBy: operator,
      },
    };
    return this.saveTermAsync(
      updated,
      '草稿词条审核通过并转正发布 (PUBLISHED)',
      operator,
      targetExpectedRev
    );
  }

  public async updateTermFieldsAsync(
    termId: string,
    patch: {
      title?: string;
      subtitle?: string;
      pinyin?: string;
      category?: TermEntry['category'];
      aliases?: string[];
      summary?: string;
      laymanAnalogy?: string;
      laymanPlain?: string;
      articleMarkdown?: string;
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      expectedRevision?: number;
    },
    operator = 'admin'
  ): Promise<TermEntry | null> {
    const existing = await this.getTermByIdAsync(termId);
    if (!existing) return null;
    const targetExpectedRev =
      patch.expectedRevision !== undefined && Number.isFinite(Number(patch.expectedRevision))
        ? Number(patch.expectedRevision)
        : existing.meta?.revision;
    const updated: TermEntry = {
      ...existing,
      title: patch.title !== undefined ? patch.title.trim() : existing.title,
      subtitle: patch.subtitle !== undefined ? patch.subtitle.trim() || undefined : existing.subtitle,
      pinyin: patch.pinyin !== undefined ? patch.pinyin.trim().toUpperCase() : existing.pinyin,
      category: patch.category || existing.category,
      aliases: Array.isArray(patch.aliases) ? patch.aliases : existing.aliases,
      summary: patch.summary !== undefined ? patch.summary.trim() : existing.summary,
      layman: {
        analogy:
          patch.laymanAnalogy !== undefined
            ? patch.laymanAnalogy.trim()
            : existing.layman.analogy,
        plain:
          patch.laymanPlain !== undefined
            ? patch.laymanPlain.trim()
            : existing.layman.plain,
      },
      articleMarkdown:
        patch.articleMarkdown !== undefined
          ? patch.articleMarkdown
          : existing.articleMarkdown,
      meta: {
        revision: existing.meta?.revision || 1,
        status: patch.status || existing.meta?.status || 'PUBLISHED',
        updatedAt: new Date().toISOString(),
        maintainedBy: operator,
      },
    };
    return this.saveTermAsync(
      updated,
      `在线编辑修订词条【${updated.title}】`,
      operator,
      targetExpectedRev
    );
  }

  public async deleteTermAsync(
    termId: string,
    operator = 'admin'
  ): Promise<boolean> {
    await this.ensureInitialized();
    const nowIso = new Date().toISOString();
    const deletedRows = await pgQuery(
      `WITH deleted_term AS (
         DELETE FROM lexicon_terms
         WHERE id = $1
         RETURNING *
       ),
       inserted_rev AS (
         INSERT INTO lexicon_term_revisions (
           id, term_id, revision, status, reason, operator, term_snapshot_json, pointers_snapshot_json, created_at
         )
         SELECT
           'rev_' || id || '_v' || (revision + 1) || '_del_' || $2,
           id,
           revision + 1,
           'ARCHIVED',
           '删除词条【' || title || '】归档快照',
           $3,
           jsonb_build_object(
             'id', id,
             'title', title,
             'subtitle', subtitle,
             'pinyin', pinyin,
             'category', category,
             'aliases', COALESCE(aliases_json::jsonb, '[]'::jsonb),
             'summary', summary,
             'layman', jsonb_build_object('analogy', layman_analogy, 'plain', layman_plain),
             'articleMarkdown', article_markdown,
             'engineering', COALESCE(engineering_json::jsonb, '{}'::jsonb),
             'relations', COALESCE(relations_json::jsonb, '[]'::jsonb),
             'faqs', COALESCE(faqs_json::jsonb, '[]'::jsonb),
             'meta', jsonb_build_object(
               'status', status,
               'revision', revision,
               'updatedAt', updated_at,
               'maintainedBy', maintained_by
             )
           )::text,
           COALESCE((engineering_json::jsonb)->'pointers', '[]'::jsonb)::text,
           $4
         FROM deleted_term
         ON CONFLICT (term_id, revision) DO NOTHING
       )
       SELECT id FROM deleted_term`,
      [termId, String(Date.now()), operator, nowIso]
    );
    if (deletedRows.length === 0) return false;
    await this.refreshFromPg();
    return true;
  }

  public async addFaqAsync(
    termId: string,
    q: string,
    a: string,
    operator = 'antigravity-v5'
  ): Promise<TermEntry | null> {
    const term = await this.getTermByIdAsync(termId);
    if (!term) return null;
    const updated: TermEntry = {
      ...term,
      faqs: [...(term.faqs || []), { q, a }],
    };
    return this.saveTermAsync(
      updated,
      `沉淀伴读问答至 FAQ: ${q.slice(0, 28)}`,
      operator,
      term.meta?.revision
    );
  }

  public async getRevisionsAsync(termId?: string): Promise<TermRevisionRecord[]> {
    await this.ensureInitialized();
    const rows = termId
      ? await pgQuery(
          `SELECT * FROM lexicon_term_revisions WHERE term_id = $1 ORDER BY revision DESC LIMIT 50`,
          [termId]
        )
      : await pgQuery(
          `SELECT * FROM lexicon_term_revisions ORDER BY created_at DESC LIMIT 50`
        );

    return rows.map((r) => {
      let parsedSnapshot: TermEntry | undefined = undefined;
      if (termId && r.term_snapshot_json) {
        try {
          parsedSnapshot = TermEntrySchema.parse(JSON.parse(r.term_snapshot_json));
        } catch {
          parsedSnapshot = undefined;
        }
      }
      return TermRevisionRecordSchema.parse({
        id: r.id,
        termId: r.term_id,
        revision: Number(r.revision),
        status: r.status || 'PUBLISHED',
        reason: r.reason,
        operator: r.operator,
        termSnapshot: parsedSnapshot,
        pointersSnapshot: (() => {
          try {
            return JSON.parse(r.pointers_snapshot_json || '[]');
          } catch {
            return [];
          }
        })(),
        createdAt: r.created_at,
      });
    });
  }

  public async rollbackTermRevisionAsync(
    termId: string,
    targetRevision: number,
    operator = 'admin',
    expectedRevision?: number
  ): Promise<TermEntry | null> {
    await this.ensureInitialized();
    const revRows = await pgQuery(
      `SELECT * FROM lexicon_term_revisions WHERE term_id = $1 AND revision = $2 LIMIT 1`,
      [termId, targetRevision]
    );
    if (revRows.length === 0) return null;
    const rawSnap = revRows[0].term_snapshot_json;
    if (!rawSnap) return null;

    const snapObj = typeof rawSnap === 'object' ? rawSnap : JSON.parse(String(rawSnap));
    const parsedSnap = TermEntrySchema.parse({
      ...snapObj,
      id: termId,
      meta: {
        ...(snapObj.meta || {}),
        status: snapObj.meta?.status === 'ARCHIVED' ? 'PUBLISHED' : snapObj.meta?.status || 'PUBLISHED',
      },
    });

    const existing = await this.getTermByIdAsync(termId);
    const targetExpectedRev =
      expectedRevision !== undefined && Number.isFinite(Number(expectedRevision))
        ? Number(expectedRevision)
        : existing?.meta?.revision;

    return this.saveTermAsync(
      parsedSnap,
      `时光机回滚：恢复至历史版本 v${targetRevision} 快照`,
      operator,
      targetExpectedRev
    );
  }

  public async recordFeedbackAsync(input: {
    type: FeedbackTicketType;
    termId?: string;
    termRevision?: number;
    queryOrSelection: string;
    comment?: string;
    reporter?: string;
  }): Promise<FeedbackTicket> {
    await this.ensureInitialized();
    const cleanQuery = String(input.queryOrSelection || '').trim();
    const dedupKey = `${input.type}:${input.termId || 'global'}:${cleanQuery.toLowerCase()}`;
    const nowIso = new Date().toISOString();
    const id = `fb_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const rows = await pgExecute(
      `INSERT INTO lexicon_feedback_tickets (
         id, dedup_key, type, status, term_id, term_revision, query_or_selection, comment, reporter, hit_count, created_at, updated_at
       ) VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7, $8, 1, $9, $9)
       ON CONFLICT (dedup_key) DO UPDATE SET
         hit_count = lexicon_feedback_tickets.hit_count + 1,
         status = CASE WHEN lexicon_feedback_tickets.status IN ('RESOLVED_UPDATED', 'REJECTED') THEN 'OPEN' ELSE lexicon_feedback_tickets.status END,
         comment = COALESCE($7, lexicon_feedback_tickets.comment),
         updated_at = $9
       RETURNING *`,
      [
        id,
        dedupKey,
        input.type,
        input.termId || null,
        input.termRevision ?? null,
        cleanQuery,
        input.comment || null,
        input.reporter || 'anonymous',
        nowIso,
      ]
    );

    const r = rows[0];
    return FeedbackTicketSchema.parse({
      id: r.id,
      type: r.type,
      status: r.status,
      termId: r.term_id || undefined,
      termRevision: r.term_revision ? Number(r.term_revision) : undefined,
      queryOrSelection: r.query_or_selection,
      comment: r.comment || undefined,
      resolutionTermId: r.resolution_term_id || undefined,
      resolutionNote: r.resolution_note || undefined,
      resolvedBy: r.resolved_by || undefined,
      reporter: r.reporter,
      hitCount: Number(r.hit_count || 1),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  public async getFeedbackTicketsAsync(): Promise<FeedbackTicket[]> {
    await this.ensureInitialized();
    const rows = await pgQuery(
      `SELECT * FROM lexicon_feedback_tickets ORDER BY CASE WHEN status = 'OPEN' THEN 0 WHEN status = 'TRIAGING' THEN 1 ELSE 2 END ASC, hit_count DESC, updated_at DESC LIMIT 100`
    );
    return rows.map((r) =>
      FeedbackTicketSchema.parse({
        id: r.id,
        type: r.type,
        status: r.status,
        termId: r.term_id || undefined,
        termRevision: r.term_revision ? Number(r.term_revision) : undefined,
        queryOrSelection: r.query_or_selection,
        comment: r.comment || undefined,
        resolutionTermId: r.resolution_term_id || undefined,
        resolutionNote: r.resolution_note || undefined,
        resolvedBy: r.resolved_by || undefined,
        reporter: r.reporter,
        hitCount: Number(r.hit_count || 1),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })
    );
  }

  public async resolveFeedbackTicketAsync(
    ticketId: string,
    patch: {
      status: 'OPEN' | 'TRIAGING' | 'RESOLVED_UPDATED' | 'REJECTED';
      resolutionTermId?: string;
      resolutionNote?: string;
    },
    operator = 'admin'
  ): Promise<FeedbackTicket | null> {
    await this.ensureInitialized();
    const nowIso = new Date().toISOString();
    const rows = await pgExecute(
      `UPDATE lexicon_feedback_tickets
       SET status = $2,
           resolution_term_id = COALESCE($3, resolution_term_id),
           resolution_note = COALESCE($4, resolution_note),
           resolved_by = $5,
           updated_at = $6
       WHERE id = $1
       RETURNING *`,
      [
        ticketId,
        patch.status,
        patch.resolutionTermId || null,
        patch.resolutionNote || null,
        operator,
        nowIso,
      ]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return FeedbackTicketSchema.parse({
      id: r.id,
      type: r.type,
      status: r.status,
      termId: r.term_id || undefined,
      termRevision: r.term_revision ? Number(r.term_revision) : undefined,
      queryOrSelection: r.query_or_selection,
      comment: r.comment || undefined,
      resolutionTermId: r.resolution_term_id || undefined,
      resolutionNote: r.resolution_note || undefined,
      resolvedBy: r.resolved_by || undefined,
      reporter: r.reporter,
      hitCount: Number(r.hit_count || 1),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  // ==========================================================================
  // 鉴权、AI 配置、源码快照、伴读会话与 Worker 队列委托接口
  // ==========================================================================

  public async authenticateUser(
    username: string,
    password: string,
    userAgent = ''
  ): Promise<{ token: string; user: AuthSessionUser } | null> {
    await this.ensureInitialized();
    return authenticateUserSql(username, password, userAgent);
  }

  public async verifySessionToken(rawToken: string): Promise<AuthSessionUser | null> {
    await this.ensureInitialized();
    return verifySessionTokenSql(rawToken);
  }

  public async revokeSessionToken(rawToken: string): Promise<void> {
    await this.ensureInitialized();
    return revokeSessionTokenSql(rawToken);
  }

  public async getPublicAiConfig(): Promise<PublicAiConfig> {
    await this.ensureInitialized();
    return getPublicAiConfigSql();
  }

  public async getServerAiConfig(): Promise<ServerAiConfig> {
    await this.ensureInitialized();
    return getServerAiConfigSql();
  }

  public async updateAiConfig(
    input: {
      protocol: 'openai-compatible' | 'anthropic-messages';
      baseUrl: string;
      model: string;
      apiKey?: string;
    },
    operator = 'admin'
  ): Promise<PublicAiConfig> {
    await this.ensureInitialized();
    return updateAiConfigSql(input, operator);
  }

  public async getCodeSnapshotFromPg(
    repo: string,
    filePath: string,
    commit?: string
  ) {
    await this.ensureInitialized();
    return getCodeSnapshotFromPgSql(repo, filePath, commit);
  }

  public async getAllCodeSnapshotsFromPg(repo?: string) {
    await this.ensureInitialized();
    return getAllCodeSnapshotsFromPgSql(repo);
  }

  public async listChatSessions(userId: string, limit = 15) {
    await this.ensureInitialized();
    return listChatSessionsSql(userId, limit);
  }

  public async getChatMessages(
    sessionId: string,
    limit = 12,
    userId?: string
  ): Promise<ChatTurnMessage[]> {
    await this.ensureInitialized();
    return getChatMessagesSql(sessionId, limit, userId);
  }

  public async saveChatTurn(params: {
    sessionId: string;
    userId: string;
    activeTermId?: string;
    question: string;
    answer: string;
    trace: any[];
    referencedCommits: string[];
    mode: string;
  }): Promise<void> {
    await this.ensureInitialized();
    return saveChatTurnSql(params);
  }

  public async upsertCodeSnapshot(snap: {
    repo: string;
    branch: string;
    commitSha: string;
    filePath: string;
    lineRange: string;
    content: string;
  }): Promise<void> {
    await this.ensureInitialized();
    return upsertCodeSnapshotSql(snap);
  }

  public async registerWorkerHeartbeat(input: {
    workerId: string;
    hostname: string;
    codebaseRoot: string;
    repoCount: number;
  }): Promise<WorkerNodeStatus> {
    await this.ensureInitialized();
    return registerWorkerHeartbeatSql(input);
  }

  public async getWorkerStatus() {
    await this.ensureInitialized();
    return getWorkerStatusSql();
  }

  public async enqueueWorkerTask(
    taskType:
      | 'GREP_CODE'
      | 'READ_FILE'
      | 'INSPECT_DRIFT'
      | 'HARNESS_DISSECT'
      | 'HARNESS_RESOLVE'
      | 'HARNESS_CONSULT',
    payload: Record<string, any>,
    requester = 'cloud-api'
  ): Promise<string> {
    await this.ensureInitialized();
    return enqueueWorkerTaskSql(taskType, payload, requester);
  }

  public async waitForWorkerTask(taskId: string, timeoutMs = 5500): Promise<any | null> {
    return waitForWorkerTaskSql(taskId, timeoutMs);
  }

  public async claimNextWorkerTask(workerId: string) {
    await this.ensureInitialized();
    return claimNextWorkerTaskSql(workerId);
  }

  public async completeWorkerTask(
    taskId: string,
    workerId: string,
    result: any,
    errorMessage?: string
  ): Promise<void> {
    await this.ensureInitialized();
    return completeWorkerTaskSql(taskId, workerId, result, errorMessage);
  }

  // ==========================================================================
  // AI Agent Harness 记忆账本与触手裂变契约委托接口
  // ==========================================================================

  public normalizeConceptName(raw: string): string {
    return normalizeConceptName(raw);
  }

  public async lookupConceptAsync(
    query: string,
    preferredCategory?: CategoryId
  ): Promise<ConceptLookupResult> {
    await this.ensureInitialized();
    const allTerms = await this.getTermsAsync();
    return lookupConceptSql(query, allTerms, preferredCategory);
  }

  public async bindTermRelationBidirectionalAsync(
    termIdA: string,
    termIdB: string,
    labelFromAToB = '核心关联概念',
    labelFromBToA = '核心关联概念'
  ): Promise<void> {
    if (!termIdA || !termIdB || termIdA === termIdB) return;
    await this.ensureInitialized();
    await bindTermRelationBidirectionalSql(termIdA, termIdB, labelFromAToB, labelFromBToA);
    await this.refreshFromPg();
  }

  public async mergeConceptAsAliasAsync(
    targetTermId: string,
    aliasName: string,
    origins: CandidateOrigin[] = [],
    note?: string,
    operator = 'antigravity-harness'
  ): Promise<TermEntry | null> {
    await this.ensureInitialized();
    return mergeConceptAsAliasSql(this, targetTermId, aliasName, origins, note, operator);
  }

  public async ensureExpansionRunAsync(input: {
    runId?: string;
    rootSeedType?: 'term' | 'text';
    rootSeedRef: string;
    title?: string;
    maxDepth?: number;
    maxDrafts?: number;
    operator?: string;
  }): Promise<ExpansionRun> {
    await this.ensureInitialized();
    return ensureExpansionRunSql(input);
  }

  public async refreshRunStatsAsync(runId: string): Promise<ExpansionRun | null> {
    await this.ensureInitialized();
    return refreshRunStatsSql(runId);
  }

  public async enqueueCandidatesAsync(input: {
    runId?: string;
    rootSeedType?: 'term' | 'text';
    rootSeedRef: string;
    runTitle?: string;
    depth?: number;
    maxDepth?: number;
    maxDrafts?: number;
    operator?: string;
    candidates: Array<{
      name: string;
      category?: CategoryId;
      sourceTermId: string;
      sourceTermTitle: string;
      quote: string;
      relationLabel?: string;
      whyItMatters: string;
      recommendedAction?: CandidateAction;
      recommendedTargetTermId?: string;
      recommendationReason?: string;
    }>;
  }) {
    await this.ensureInitialized();
    return enqueueCandidatesSql(this, input);
  }

  public async getCandidateByIdOrNameAsync(
    idOrName: string
  ): Promise<ExpansionCandidate | null> {
    await this.ensureInitialized();
    return getCandidateByIdOrNameSql(idOrName);
  }

  public async withCandidateResolutionLock<T>(
    normalizedKey: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return withCandidateResolutionLock(normalizedKey, fn);
  }

  public async resolveCandidateAsync(
    candidateIdOrName: string,
    resolution: {
      action: CandidateAction;
      targetTermId?: string;
      decisionNote?: string;
      generatedTerm?: TermEntry;
      publishImmediately?: boolean;
    },
    operator = 'antigravity-harness'
  ) {
    await this.ensureInitialized();
    return resolveCandidateSql(this, candidateIdOrName, resolution, operator);
  }

  public async getHarnessOverviewAsync(options?: {
    sourceTermId?: string;
    runId?: string;
    status?: string;
  }) {
    await this.ensureInitialized();
    return getHarnessOverviewSql(options);
  }
}

export const lexiconStore = new LexiconStore();
