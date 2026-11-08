import crypto from 'node:crypto';
import type {
  CandidateAction,
  CandidateOrigin,
  CategoryId,
  ConceptLookupResult,
  ExpansionCandidate,
  ExpansionRun,
  TermEntry,
} from '@glossa/schema';
import { pgQuery, pgExecute } from '../pg-database.js';
import {
  normalizeConceptName,
  rowToExpansionCandidate,
  rowToExpansionRun,
} from './concept-matcher.js';

export interface HarnessStoreHost {
  getTermById(id: string): TermEntry | undefined;
  getTermByIdAsync(id: string): Promise<TermEntry | undefined>;
  saveTermAsync(
    term: TermEntry,
    reason?: string,
    operator?: string,
    expectedRevision?: number
  ): Promise<TermEntry>;
  lookupConceptAsync(
    query: string,
    preferredCategory?: CategoryId
  ): Promise<ConceptLookupResult>;
  bindTermRelationBidirectionalAsync(
    termIdA: string,
    termIdB: string,
    labelFromAToB?: string,
    labelFromBToA?: string
  ): Promise<void>;
}

/**
 * 将同义词触手（如「手持电脑」->「笔记本」，或「行销门店」->「费用门店」）并入目标词条的 aliases 别名列表，
 * 强制携带 expectedRevision 乐观锁校验并在遇到 409 并发冲突时自动重读最新快照重试合并，绝不覆盖维护人刚保存的正文！
 */
export async function mergeConceptAsAliasSql(
  host: HarnessStoreHost,
  targetTermId: string,
  aliasName: string,
  origins: CandidateOrigin[] = [],
  note?: string,
  operator = 'antigravity-harness'
): Promise<TermEntry | null> {
  const cleanAlias = aliasName.trim();
  const normAlias = normalizeConceptName(cleanAlias);

  let updatedTarget: TermEntry | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let targetTerm = await host.getTermByIdAsync(targetTermId);
    if (!targetTerm) {
      const lk = await host.lookupConceptAsync(targetTermId);
      if (lk.exactMatch) {
        targetTerm = await host.getTermByIdAsync(lk.exactMatch.termId);
      }
    }
    if (!targetTerm) return null;

    const nextAliases = [...(targetTerm.aliases || [])];
    if (
      cleanAlias &&
      normalizeConceptName(targetTerm.title) !== normAlias &&
      !nextAliases.some((a) => normalizeConceptName(a) === normAlias)
    ) {
      nextAliases.push(cleanAlias);
    }

    const nextRelations = [...(targetTerm.relations || [])];
    for (const orig of origins) {
      if (
        orig.sourceTermId &&
        orig.sourceTermId !== targetTerm.id &&
        !nextRelations.some((r) => r.target === orig.sourceTermId)
      ) {
        nextRelations.push({
          target: orig.sourceTermId,
          label: orig.relationLabel || `触手同义归并（${cleanAlias}）`,
        });
      }
    }

    try {
      updatedTarget = await host.saveTermAsync(
        {
          ...targetTerm,
          aliases: nextAliases,
          relations: nextRelations,
        },
        note || `触手同义词归并：将「${cleanAlias}」并入【${targetTerm.title}】标准别名`,
        operator,
        targetTerm.meta?.revision || 1
      );
      break;
    } catch (err: any) {
      if (err?.status === 409 && attempt < 4) {
        continue;
      }
      throw err;
    }
  }

  if (updatedTarget) {
    for (const orig of origins) {
      if (orig.sourceTermId && orig.sourceTermId !== updatedTarget.id) {
        await host.bindTermRelationBidirectionalAsync(
          orig.sourceTermId,
          updatedTarget.id,
          orig.relationLabel || `关联概念（${cleanAlias}）`,
          orig.relationLabel || `触手来源（${cleanAlias}）`
        );
      }
    }
  }

  return updatedTarget;
}

export async function ensureExpansionRunSql(input: {
  runId?: string;
  rootSeedType?: 'term' | 'text';
  rootSeedRef: string;
  title?: string;
  maxDepth?: number;
  maxDrafts?: number;
  operator?: string;
}): Promise<ExpansionRun> {
  const nowIso = new Date().toISOString();
  if (input.runId) {
    const existing = await pgQuery(
      `SELECT * FROM lexicon_expansion_runs WHERE id = $1 LIMIT 1`,
      [input.runId]
    );
    if (existing.length > 0) {
      if (input.maxDepth !== undefined || input.maxDrafts !== undefined) {
        const upd = await pgExecute(
          `UPDATE lexicon_expansion_runs
           SET max_depth = COALESCE($2, max_depth),
               max_drafts = COALESCE($3, max_drafts),
               updated_at = $4
           WHERE id = $1
           RETURNING *`,
          [
            input.runId,
            input.maxDepth !== undefined ? input.maxDepth : null,
            input.maxDrafts !== undefined ? input.maxDrafts : null,
            nowIso,
          ]
        );
        if (upd.length > 0) return rowToExpansionRun(upd[0]);
      }
      return rowToExpansionRun(existing[0]);
    }
  }

  const existingBySeed = await pgQuery(
    `SELECT * FROM lexicon_expansion_runs WHERE root_seed_ref = $1 ORDER BY updated_at DESC LIMIT 1`,
    [input.rootSeedRef]
  );
  if (existingBySeed.length > 0 && !input.runId) {
    const chosenId = existingBySeed[0].id;
    if (input.maxDepth !== undefined || input.maxDrafts !== undefined) {
      const upd = await pgExecute(
        `UPDATE lexicon_expansion_runs
         SET max_depth = COALESCE($2, max_depth),
             max_drafts = COALESCE($3, max_drafts),
             updated_at = $4
         WHERE id = $1
         RETURNING *`,
        [
          chosenId,
          input.maxDepth !== undefined ? input.maxDepth : null,
          input.maxDrafts !== undefined ? input.maxDrafts : null,
          nowIso,
        ]
      );
      if (upd.length > 0) return rowToExpansionRun(upd[0]);
    }
    return rowToExpansionRun(existingBySeed[0]);
  }

  const runId =
    input.runId ||
    `run_${input.rootSeedRef.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}_${Date.now()}`;
  const title =
    input.title || `引爆点【${input.rootSeedRef}】顺藤摸瓜触手裂变批次`;
  const operator = input.operator || 'antigravity-harness';

  const rows = await pgExecute(
    `INSERT INTO lexicon_expansion_runs (
       id, root_seed_type, root_seed_ref, title, status, max_depth, max_drafts,
       generated_count, merged_alias_count, rejected_count, memory_summary, operator, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, 0, 0, 0, $7, $8, $9, $9)
     ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      runId,
      input.rootSeedType || 'term',
      input.rootSeedRef,
      title,
      input.maxDepth ?? 2,
      input.maxDrafts ?? 20,
      `引爆点「${input.rootSeedRef}」已启动顺藤摸瓜剖析。`,
      operator,
      nowIso,
    ]
  );
  return rowToExpansionRun(rows[0]);
}

export async function refreshRunStatsSql(runId: string): Promise<ExpansionRun | null> {
  const runRows = await pgQuery(
    `SELECT * FROM lexicon_expansion_runs WHERE id = $1 LIMIT 1`,
    [runId]
  );
  if (runRows.length === 0) return null;

  const candRows = await pgQuery(
    `SELECT * FROM lexicon_expansion_candidates WHERE run_id = $1 ORDER BY updated_at DESC`,
    [runId]
  );
  const cands = candRows.map((r) => rowToExpansionCandidate(r));
  const generated = cands.filter((c) => c.status === 'GENERATED');
  const merged = cands.filter((c) => c.status === 'MERGED_ALIAS');
  const linked = cands.filter((c) => c.status === 'LINKED_EXISTING');
  const rejected = cands.filter((c) => c.status === 'REJECTED');
  const pending = cands.filter((c) => c.status === 'PENDING');

  const summaryParts: string[] = [
    `共捕获 ${cands.length} 条业务触手（待决策 ${pending.length}，已生成独立词条 ${generated.length}，已并入同义别名 ${merged.length}，已绑定既有词条 ${linked.length}，已剔除噪音 ${rejected.length}）。`,
  ];
  if (merged.length > 0) {
    summaryParts.push(
      `同义归并记忆：${merged
        .slice(0, 6)
        .map((m) => `「${m.name} -> ${m.targetTermId}」`)
        .join('、')}`
    );
  }
  if (generated.length > 0) {
    summaryParts.push(
      `新词分叉记忆：${generated
        .slice(0, 6)
        .map((g) => `「${g.name} (${g.targetTermId})」`)
        .join('、')}`
    );
  }
  if (rejected.length > 0) {
    summaryParts.push(
      `已剔除通用/非业务词：${rejected
        .slice(0, 6)
        .map((r) => `「${r.name}」`)
        .join('、')}`
    );
  }

  const nowIso = new Date().toISOString();
  const updatedRows = await pgExecute(
    `UPDATE lexicon_expansion_runs
     SET generated_count = $2,
         merged_alias_count = $3,
         rejected_count = $4,
         memory_summary = $5,
         updated_at = $6
     WHERE id = $1
     RETURNING *`,
    [
      runId,
      generated.length,
      merged.length,
      rejected.length,
      summaryParts.join(' '),
      nowIso,
    ]
  );
  return updatedRows.length > 0 ? rowToExpansionRun(updatedRows[0]) : null;
}

/**
 * 契约接口 2：触手入队与多父节点记忆归并 (enqueueCandidatesSql)
 */
export async function enqueueCandidatesSql(
  host: HarnessStoreHost,
  input: {
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
  }
): Promise<{
  run: ExpansionRun;
  enqueued: ExpansionCandidate[];
  autoLinked: ExpansionCandidate[];
  mergedOrigins: ExpansionCandidate[];
}> {
  const operator = input.operator || 'antigravity-harness';
  const run = await ensureExpansionRunSql({
    runId: input.runId,
    rootSeedType: input.rootSeedType,
    rootSeedRef: input.rootSeedRef,
    title: input.runTitle,
    maxDepth: input.maxDepth,
    maxDrafts: input.maxDrafts,
    operator,
  });

  const enqueued: ExpansionCandidate[] = [];
  const autoLinked: ExpansionCandidate[] = [];
  const mergedOrigins: ExpansionCandidate[] = [];
  const nowIso = new Date().toISOString();

  const atomicOriginsMergeExpr = `(
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)::text
    FROM (
      SELECT elem
      FROM jsonb_array_elements(COALESCE(NULLIF(lexicon_expansion_candidates.origins_json, '')::jsonb, '[]'::jsonb)) AS elem
      UNION ALL
      SELECT new_elem
      FROM jsonb_array_elements(EXCLUDED.origins_json::jsonb) AS new_elem
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(NULLIF(lexicon_expansion_candidates.origins_json, '')::jsonb, '[]'::jsonb)) AS existing_elem
        WHERE existing_elem->>'sourceTermId' = new_elem->>'sourceTermId'
      )
    ) merged_origins
  )`;

  for (const item of input.candidates) {
    const cleanName = String(item.name || '').trim();
    const normName = normalizeConceptName(cleanName);
    if (!normName || normName.length < 2) continue;

    const lookup = await host.lookupConceptAsync(cleanName, item.category);
    const newOrigin: CandidateOrigin = {
      sourceTermId: item.sourceTermId,
      sourceTermTitle: item.sourceTermTitle,
      quote: item.quote || cleanName,
      relationLabel: item.relationLabel || '顺藤摸瓜关联概念',
      whyItMatters: item.whyItMatters || '正文中涉及的关键业务分叉概念',
    };

    if (lookup.exactMatch) {
      if (
        item.sourceTermId &&
        item.sourceTermId !== lookup.exactMatch.termId
      ) {
        await host.bindTermRelationBidirectionalAsync(
          item.sourceTermId,
          lookup.exactMatch.termId,
          newOrigin.relationLabel,
          newOrigin.relationLabel
        );
      }

      const candId =
        lookup.memoryMatch?.id ||
        `cand_${crypto.createHash('sha1').update(normName).digest('hex').slice(0, 14)}`;
      const rows = await pgExecute(
        `INSERT INTO lexicon_expansion_candidates (
           id, run_id, name, normalized_name, category, status, depth, origins_json,
           recommended_action, recommended_target_term_id, recommended_target_term_title,
           recommendation_reason, decision_action, decision_note, target_term_id, operator, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'LINKED_EXISTING', $6, $7, 'LINK_EXISTING', $8, $9, $10, 'LINK_EXISTING', $11, $8, $12, $13, $13)
         ON CONFLICT (normalized_name) DO UPDATE SET
           origins_json = ${atomicOriginsMergeExpr},
           status = CASE
             WHEN lexicon_expansion_candidates.status IN ('GENERATED', 'MERGED_ALIAS') THEN lexicon_expansion_candidates.status
             ELSE 'LINKED_EXISTING'
           END,
           decision_action = COALESCE(lexicon_expansion_candidates.decision_action, 'LINK_EXISTING'),
           target_term_id = COALESCE(lexicon_expansion_candidates.target_term_id, EXCLUDED.target_term_id),
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          candId,
          run.id,
          cleanName,
          normName,
          item.category || lookup.exactMatch.category,
          input.depth ?? 1,
          JSON.stringify([newOrigin]),
          lookup.exactMatch.termId,
          lookup.exactMatch.title,
          `已命中库内词条【${lookup.exactMatch.title}】（匹配方式：${lookup.exactMatch.matchedVia}），已自动双向补齐关联`,
          `自动匹配既有词条【${lookup.exactMatch.title}】并双向建链`,
          operator,
          nowIso,
        ]
      );
      if (rows.length > 0) {
        autoLinked.push(rowToExpansionCandidate(rows[0]));
      }
      continue;
    }

    const topSim = lookup.similarTerms[0];
    let recAction: CandidateAction = item.recommendedAction || 'GENERATE_TERM';
    let recTargetId = item.recommendedTargetTermId || undefined;
    let recTargetTitle = recTargetId
      ? host.getTermById(recTargetId)?.title
      : undefined;
    let recReason = item.recommendationReason || '';

    if (!item.recommendedAction && topSim) {
      if (topSim.similarityScore >= 0.72) {
        recAction = 'MERGE_AS_ALIAS';
        recTargetId = topSim.id;
        recTargetTitle = topSim.title;
        recReason =
          recReason ||
          `${topSim.matchHint}；若二者代表同一业务实体（如同物异名），建议直接并入【${topSim.title}】别名。`;
      } else if (topSim.similarityScore >= 0.45) {
        recAction = 'GENERATE_TERM';
        recTargetId = topSim.id;
        recTargetTitle = topSim.title;
        recReason =
          recReason ||
          `具有独立业务规则，且与已有词条【${topSim.title}】强相关，建议生成独立词条并自动建立对比/上下游关联。`;
      }
    }
    if (!recReason) {
      recReason = `从【${newOrigin.sourceTermTitle}】剖析出的未收录业务概念：${newOrigin.whyItMatters}`;
    }

    const candId = `cand_${crypto
      .createHash('sha1')
      .update(normName)
      .digest('hex')
      .slice(0, 14)}`;

    const rows = await pgExecute(
      `INSERT INTO lexicon_expansion_candidates (
         id, run_id, name, normalized_name, category, status, depth, origins_json,
         recommended_action, recommended_target_term_id, recommended_target_term_title,
         recommendation_reason, operator, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11, $12, $13, $13)
       ON CONFLICT (normalized_name) DO UPDATE SET
         origins_json = ${atomicOriginsMergeExpr},
         recommended_action = CASE
           WHEN $14::BOOLEAN THEN EXCLUDED.recommended_action
           ELSE lexicon_expansion_candidates.recommended_action
         END,
         recommended_target_term_id = COALESCE(EXCLUDED.recommended_target_term_id, lexicon_expansion_candidates.recommended_target_term_id),
         recommended_target_term_title = COALESCE(EXCLUDED.recommended_target_term_title, lexicon_expansion_candidates.recommended_target_term_title),
         recommendation_reason = CASE
           WHEN $15::BOOLEAN THEN EXCLUDED.recommendation_reason
           ELSE lexicon_expansion_candidates.recommendation_reason
         END,
         updated_at = EXCLUDED.updated_at
       RETURNING *, (xmax = 0) AS is_fresh_insert`,
      [
        candId,
        run.id,
        cleanName,
        normName,
        item.category || 'terminal',
        input.depth ?? 1,
        JSON.stringify([newOrigin]),
        recAction,
        recTargetId || null,
        recTargetTitle || null,
        recReason,
        operator,
        nowIso,
        Boolean(item.recommendedAction),
        Boolean(item.recommendationReason),
      ]
    );

    if (rows.length > 0) {
      const candObj = rowToExpansionCandidate(rows[0]);
      const isFresh = Boolean(rows[0].is_fresh_insert);
      if (isFresh) {
        enqueued.push(candObj);
      } else {
        if (
          (candObj.status === 'GENERATED' ||
            candObj.status === 'MERGED_ALIAS' ||
            candObj.status === 'LINKED_EXISTING') &&
          candObj.targetTermId &&
          item.sourceTermId &&
          item.sourceTermId !== candObj.targetTermId
        ) {
          await host.bindTermRelationBidirectionalAsync(
            item.sourceTermId,
            candObj.targetTermId,
            newOrigin.relationLabel,
            newOrigin.relationLabel
          );
        }
        mergedOrigins.push(candObj);
      }
    }
  }

  const updatedRun = (await refreshRunStatsSql(run.id)) || run;
  return {
    run: updatedRun,
    enqueued,
    autoLinked,
    mergedOrigins,
  };
}

export async function getCandidateByIdOrNameSql(
  idOrName: string
): Promise<ExpansionCandidate | null> {
  const norm = normalizeConceptName(idOrName);
  const rows = await pgQuery(
    `SELECT * FROM lexicon_expansion_candidates WHERE id = $1 OR normalized_name = $2 LIMIT 1`,
    [idOrName, norm]
  );
  if (rows.length === 0) return null;
  return rowToExpansionCandidate(rows[0]);
}

const candidateResolutionLocks = new Map<string, Promise<any>>();

export async function withCandidateResolutionLock<T>(
  normalizedKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = candidateResolutionLocks.get(normalizedKey) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  candidateResolutionLocks.set(
    normalizedKey,
    prev.then(() => gate, () => gate)
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (candidateResolutionLocks.get(normalizedKey) === gate) {
      candidateResolutionLocks.delete(normalizedKey);
    }
  }
}

/**
 * 契约接口 3：触手三路分流决议执行器 (resolveCandidateSql)
 */
export async function resolveCandidateSql(
  host: HarnessStoreHost,
  candidateIdOrName: string,
  resolution: {
    action: CandidateAction;
    targetTermId?: string;
    decisionNote?: string;
    generatedTerm?: TermEntry;
    publishImmediately?: boolean;
  },
  operator = 'antigravity-harness'
): Promise<{
  candidate: ExpansionCandidate;
  affectedTerm: TermEntry | null;
  run: ExpansionRun | null;
}> {
  const initialCand = await getCandidateByIdOrNameSql(candidateIdOrName);
  if (!initialCand) {
    throw new Error(`未找到待决议的候选触手: ${candidateIdOrName}`);
  }

  return withCandidateResolutionLock(initialCand.normalizedName, async () => {
    const cand = await getCandidateByIdOrNameSql(initialCand.id);
    if (!cand) {
      throw new Error(`未找到待决议的候选触手: ${candidateIdOrName}`);
    }

    if (cand.status === 'GENERATED' && resolution.action === 'GENERATE_TERM' && cand.targetTermId) {
      const existingTerm = await host.getTermByIdAsync(cand.targetTermId);
      if (existingTerm) {
        for (const orig of cand.origins) {
          if (orig.sourceTermId && orig.sourceTermId !== existingTerm.id) {
            await host.bindTermRelationBidirectionalAsync(
              orig.sourceTermId,
              existingTerm.id,
              orig.relationLabel || '顺藤摸瓜分叉词条',
              orig.relationLabel || '父级引爆来源'
            );
          }
        }
        const run = await refreshRunStatsSql(cand.runId);
        return {
          candidate: cand,
          affectedTerm: existingTerm,
          run,
        };
      }
    }

    const nowIso = new Date().toISOString();
    let affectedTerm: TermEntry | null = null;
    let nextStatus: ExpansionCandidate['status'] = 'PENDING';
    let finalTargetId: string | undefined =
      resolution.targetTermId || cand.recommendedTargetTermId;

    if (resolution.action === 'MERGE_AS_ALIAS') {
      if (!finalTargetId) {
        throw new Error(`执行「并入别名 (MERGE_AS_ALIAS)」必须指定目标词条 ID (targetTermId)`);
      }
      affectedTerm = await mergeConceptAsAliasSql(
        host,
        finalTargetId,
        cand.name,
        cand.origins,
        resolution.decisionNote ||
          `触手同义词归并：将「${cand.name}」并入词条【${finalTargetId}】标准别名`,
        operator
      );
      if (!affectedTerm) {
        throw new Error(`并入别名的目标词条不存在: ${finalTargetId}`);
      }
      finalTargetId = affectedTerm.id;
      nextStatus = 'MERGED_ALIAS';
    } else if (resolution.action === 'LINK_EXISTING') {
      if (!finalTargetId) {
        throw new Error(`执行「绑定既有词条 (LINK_EXISTING)」必须指定目标词条 ID`);
      }
      affectedTerm = (await host.getTermByIdAsync(finalTargetId)) || null;
      if (!affectedTerm) {
        const lk = await host.lookupConceptAsync(finalTargetId);
        if (lk.exactMatch) {
          affectedTerm = (await host.getTermByIdAsync(lk.exactMatch.termId)) || null;
        }
      }
      if (!affectedTerm) {
        throw new Error(`目标词条不存在: ${finalTargetId}`);
      }
      finalTargetId = affectedTerm.id;
      for (const orig of cand.origins) {
        if (orig.sourceTermId && orig.sourceTermId !== finalTargetId) {
          await host.bindTermRelationBidirectionalAsync(
            orig.sourceTermId,
            finalTargetId,
            orig.relationLabel || '核心关联概念',
            orig.relationLabel || '核心关联概念'
          );
        }
      }
      nextStatus = 'LINKED_EXISTING';
    } else if (resolution.action === 'REJECT') {
      nextStatus = 'REJECTED';
      finalTargetId = undefined;
    } else if (resolution.action === 'GENERATE_TERM') {
      if (!resolution.generatedTerm) {
        throw new Error(`执行「生成独立词条 (GENERATE_TERM)」需要提供生成的词条结构 generatedTerm`);
      }

      const staleCutoffIso = new Date(Date.now() - 60_000).toISOString();
      const claimRows = await pgExecute(
        `UPDATE lexicon_expansion_candidates
         SET status = 'GENERATED',
             decision_action = 'GENERATE_TERM',
             decision_note = $2,
             target_term_id = $3,
             operator = $4,
             updated_at = $5
         WHERE id = $1
           AND (
             status <> 'GENERATED'
             OR (
               NOT EXISTS (
                 SELECT 1 FROM lexicon_terms t WHERE t.id = lexicon_expansion_candidates.target_term_id
               )
               AND updated_at < $6
             )
           )
         RETURNING *`,
        [
          cand.id,
          resolution.decisionNote || cand.recommendationReason,
          resolution.generatedTerm.id,
          operator,
          nowIso,
          staleCutoffIso,
        ]
      );

      if (claimRows.length === 0) {
        let latestCand = (await getCandidateByIdOrNameSql(cand.id)) || cand;
        let winnerTermId = latestCand.targetTermId || resolution.generatedTerm.id;
        let existingTerm = await host.getTermByIdAsync(winnerTermId);

        for (let waitIdx = 0; waitIdx < 30 && !existingTerm; waitIdx++) {
          await new Promise((r) => setTimeout(r, 40));
          latestCand = (await getCandidateByIdOrNameSql(cand.id)) || latestCand;
          winnerTermId = latestCand.targetTermId || resolution.generatedTerm.id;
          existingTerm = await host.getTermByIdAsync(winnerTermId);
          if (latestCand.status !== 'GENERATED') {
            break;
          }
        }

        if (!existingTerm) {
          const inProgressErr: any = new Error(
            `候选触手「${cand.name}」正由另一进程执行生成落库中 (409)，请稍后刷新查看结果`
          );
          inProgressErr.status = 409;
          throw inProgressErr;
        }

        for (const orig of latestCand.origins) {
          if (orig.sourceTermId && orig.sourceTermId !== existingTerm.id) {
            await host.bindTermRelationBidirectionalAsync(
              orig.sourceTermId,
              existingTerm.id,
              orig.relationLabel || '顺藤摸瓜分叉词条',
              orig.relationLabel || '父级引爆来源'
            );
          }
        }
        const run = await refreshRunStatsSql(latestCand.runId);
        return {
          candidate: latestCand,
          affectedTerm: existingTerm,
          run,
        };
      }

      try {
        const parentRelations = cand.origins
          .filter((o) => o.sourceTermId)
          .map((o) => ({
            target: o.sourceTermId,
            label: o.relationLabel || '父级引爆来源',
          }));

        const twinTargetId = resolution.targetTermId || cand.recommendedTargetTermId;
        if (
          twinTargetId &&
          twinTargetId !== resolution.generatedTerm.id &&
          !parentRelations.some((r) => r.target === twinTargetId)
        ) {
          parentRelations.push({
            target: twinTargetId,
            label: '易混概念与上下游辨析',
          });
        }

        const mergedRelations = [...(resolution.generatedTerm.relations || [])];
        for (const pr of parentRelations) {
          if (!mergedRelations.some((r) => r.target === pr.target)) {
            mergedRelations.push(pr);
          }
        }

        const desiredStatus =
          resolution.publishImmediately === true
            ? 'PUBLISHED'
            : resolution.publishImmediately === false
              ? 'DRAFT'
              : resolution.generatedTerm.meta?.status || 'DRAFT';

        const existingById = await host.getTermByIdAsync(resolution.generatedTerm.id);
        if (existingById) {
          affectedTerm = existingById;
        } else {
          try {
            affectedTerm = await host.saveTermAsync(
              {
                ...resolution.generatedTerm,
                relations: mergedRelations,
                meta: {
                  ...(resolution.generatedTerm.meta || {
                    updatedAt: nowIso.slice(0, 10),
                    maintainedBy: operator,
                    revision: 1,
                  }),
                  status: desiredStatus,
                },
              },
              resolution.decisionNote ||
                `顺藤摸瓜触手裂变生成词条【${resolution.generatedTerm.title}】（源自：${cand.origins
                  .map((o) => o.sourceTermTitle)
                  .join('、')}）`,
              operator,
              0
            );
          } catch (saveErr: any) {
            if (saveErr?.status === 409) {
              const concurrentExisting = await host.getTermByIdAsync(
                resolution.generatedTerm.id
              );
              if (concurrentExisting) {
                affectedTerm = concurrentExisting;
              } else {
                throw saveErr;
              }
            } else {
              throw saveErr;
            }
          }
        }

        finalTargetId = affectedTerm.id;
        nextStatus = 'GENERATED';

        for (const orig of cand.origins) {
          if (orig.sourceTermId && orig.sourceTermId !== affectedTerm.id) {
            await host.bindTermRelationBidirectionalAsync(
              orig.sourceTermId,
              affectedTerm.id,
              orig.relationLabel || '顺藤摸瓜分叉词条',
              orig.relationLabel || '父级引爆来源'
            );
          }
        }
        if (twinTargetId && twinTargetId !== affectedTerm.id) {
          await host.bindTermRelationBidirectionalAsync(
            twinTargetId,
            affectedTerm.id,
            '易混概念与上下游辨析',
            '易混概念与上下游辨析'
          );
        }
      } catch (err) {
        await pgExecute(
          `UPDATE lexicon_expansion_candidates SET status = $2, updated_at = $3 WHERE id = $1`,
          [cand.id, cand.status, new Date().toISOString()]
        );
        throw err;
      }
    }

    const updatedRows = await pgExecute(
      `UPDATE lexicon_expansion_candidates
       SET status = $2,
           decision_action = $3,
           decision_note = $4,
           target_term_id = $5,
           operator = $6,
           updated_at = $7
       WHERE id = $1
       RETURNING *`,
      [
        cand.id,
        nextStatus,
        resolution.action,
        resolution.decisionNote || cand.recommendationReason,
        finalTargetId || null,
        operator,
        nowIso,
      ]
    );

    const updatedCandidate = rowToExpansionCandidate(updatedRows[0]);
    const updatedRun = await refreshRunStatsSql(cand.runId);

    return {
      candidate: updatedCandidate,
      affectedTerm,
      run: updatedRun,
    };
  });
}

export async function getHarnessOverviewSql(options?: {
  sourceTermId?: string;
  runId?: string;
  status?: string;
}): Promise<{
  runs: ExpansionRun[];
  candidates: ExpansionCandidate[];
  termCandidates: ExpansionCandidate[];
  stats: {
    totalCandidates: number;
    pendingCount: number;
    generatedCount: number;
    mergedAliasCount: number;
    linkedExistingCount: number;
    rejectedCount: number;
  };
}> {
  const [runRows, candRows] = await Promise.all([
    pgQuery(`SELECT * FROM lexicon_expansion_runs ORDER BY updated_at DESC LIMIT 20`),
    pgQuery(`SELECT * FROM lexicon_expansion_candidates ORDER BY updated_at DESC LIMIT 300`),
  ]);

  const runs = runRows.map((r) => rowToExpansionRun(r));
  const allCandidates = candRows.map((r) => rowToExpansionCandidate(r));

  const stats = {
    totalCandidates: allCandidates.length,
    pendingCount: allCandidates.filter((c) => c.status === 'PENDING').length,
    generatedCount: allCandidates.filter((c) => c.status === 'GENERATED').length,
    mergedAliasCount: allCandidates.filter((c) => c.status === 'MERGED_ALIAS').length,
    linkedExistingCount: allCandidates.filter((c) => c.status === 'LINKED_EXISTING').length,
    rejectedCount: allCandidates.filter((c) => c.status === 'REJECTED').length,
  };

  const termCandidates = options?.sourceTermId
    ? allCandidates.filter(
        (c) =>
          c.origins.some((o) => o.sourceTermId === options.sourceTermId) ||
          c.targetTermId === options.sourceTermId ||
          c.recommendedTargetTermId === options.sourceTermId
      )
    : [];

  let filtered = allCandidates;
  if (options?.runId) {
    filtered = filtered.filter((c) => c.runId === options.runId);
  }
  if (options?.status) {
    filtered = filtered.filter((c) => c.status === options.status);
  }

  return {
    runs,
    candidates: filtered,
    termCandidates,
    stats,
  };
}
