import {
  ExpansionCandidateSchema,
  ExpansionRunSchema,
  type CandidateOrigin,
  type CategoryId,
  type ConceptLookupResult,
  type ExpansionCandidate,
  type ExpansionRun,
  type SimilarTermRecall,
  type TermEntry,
} from '@glossa/schema';
import { pgQuery, pgExecute } from '../pg-database.js';

export function normalizeConceptName(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s·•\-_（）()【】「」『』""''/\\:：,，。.?？!！]+/g, '');
}

export function rowToExpansionRun(row: any): ExpansionRun {
  return ExpansionRunSchema.parse({
    id: row.id,
    rootSeedType: row.root_seed_type === 'text' ? 'text' : 'term',
    rootSeedRef: row.root_seed_ref,
    title: row.title,
    status: row.status || 'RUNNING',
    maxDepth: Number(row.max_depth || 2),
    maxDrafts: Number(row.max_drafts || 20),
    generatedCount: Number(row.generated_count || 0),
    mergedAliasCount: Number(row.merged_alias_count || 0),
    rejectedCount: Number(row.rejected_count || 0),
    memorySummary: row.memory_summary || '',
    operator: row.operator || 'antigravity-harness',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function rowToExpansionCandidate(row: any): ExpansionCandidate {
  let origins: CandidateOrigin[] = [];
  try {
    origins = JSON.parse(row.origins_json || '[]');
  } catch {
    origins = [];
  }
  return ExpansionCandidateSchema.parse({
    id: row.id,
    runId: row.run_id,
    name: row.name,
    normalizedName: row.normalized_name,
    category: row.category || 'core',
    status: row.status || 'PENDING',
    depth: Number(row.depth || 1),
    origins,
    recommendedAction: row.recommended_action || 'GENERATE_TERM',
    recommendedTargetTermId: row.recommended_target_term_id || undefined,
    recommendedTargetTermTitle: row.recommended_target_term_title || undefined,
    recommendationReason: row.recommendation_reason || '',
    decisionAction: row.decision_action || undefined,
    decisionNote: row.decision_note || undefined,
    targetTermId: row.target_term_id || undefined,
    operator: row.operator || 'antigravity-harness',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function computeConceptSimilarity(
  queryNorm: string,
  term: TermEntry,
  preferredCategory?: CategoryId
): { score: number; hint: string } {
  if (!queryNorm || queryNorm.length < 2) return { score: 0, hint: '' };
  const titleNorm = normalizeConceptName(term.title);
  const aliasNorms = (term.aliases || []).map((a) => ({
    raw: a,
    norm: normalizeConceptName(a),
  }));

  let substringScore = 0;
  let matchedTargetLabel = term.title;
  if (titleNorm.includes(queryNorm) || queryNorm.includes(titleNorm)) {
    const shorter = Math.min(titleNorm.length, queryNorm.length);
    const longer = Math.max(titleNorm.length, queryNorm.length);
    substringScore = 0.42 + 0.35 * (shorter / Math.max(longer, 1));
  }
  for (const al of aliasNorms) {
    if (!al.norm) continue;
    if (al.norm.includes(queryNorm) || queryNorm.includes(al.norm)) {
      const shorter = Math.min(al.norm.length, queryNorm.length);
      const longer = Math.max(al.norm.length, queryNorm.length);
      const sc = 0.42 + 0.35 * (shorter / Math.max(longer, 1));
      if (sc > substringScore) {
        substringScore = sc;
        matchedTargetLabel = `${term.title}（别名：${al.raw}）`;
      }
    }
  }

  const getBigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.slice(i, i + 2));
    }
    if (s.length === 1) set.add(s);
    return set;
  };
  const qBigrams = getBigrams(queryNorm);
  let bestBigramDice = 0;
  for (const candidateNorm of [titleNorm, ...aliasNorms.map((a) => a.norm)]) {
    if (!candidateNorm) continue;
    const tBigrams = getBigrams(candidateNorm);
    let inter = 0;
    for (const bg of qBigrams) {
      if (tBigrams.has(bg)) inter++;
    }
    const dice = (2 * inter) / Math.max(qBigrams.size + tBigrams.size, 1);
    if (dice > bestBigramDice) bestBigramDice = dice;
  }

  const summaryNorm = normalizeConceptName(`${term.summary} ${term.layman.plain}`);
  const inSummary = summaryNorm.includes(queryNorm) ? 0.14 : 0;
  const catBonus = preferredCategory && term.category === preferredCategory ? 0.06 : 0;

  const rawScore = Math.min(
    0.96,
    Math.max(substringScore, bestBigramDice * 0.82) + inSummary + catBonus
  );
  const score = Math.round(rawScore * 100) / 100;

  if (score < 0.25) return { score: 0, hint: '' };

  const hint =
    score >= 0.65
      ? `与已有词条【${matchedTargetLabel}】高度重合（相似度 ${Math.round(score * 100)}%），极可能是同义叫法（建议并入别名）或强关联子概念`
      : inSummary > 0
        ? `已在【${term.title}】核心定义中直接提及（相似度 ${Math.round(score * 100)}%），建议核对是否为其同义别名或上下游衍生词条`
        : `与【${term.title}】共享核心业务词根（相似度 ${Math.round(score * 100)}%），可对比区分或建立关联`;

  return { score, hint };
}

/**
 * 概念查重、记忆账本检索与 Top-5 相似词条召回
 */
export async function lookupConceptSql(
  query: string,
  allTerms: TermEntry[],
  preferredCategory?: CategoryId
): Promise<ConceptLookupResult> {
  const cleanQuery = String(query || '').trim();
  const normalizedQuery = normalizeConceptName(cleanQuery);

  let exactMatch: ConceptLookupResult['exactMatch'] = null;
  for (const t of allTerms) {
    if (normalizeConceptName(t.id) === normalizedQuery) {
      exactMatch = {
        termId: t.id,
        title: t.title,
        category: t.category,
        matchedVia: 'id',
        aliases: t.aliases || [],
        summary: t.summary,
      };
      break;
    }
    if (normalizeConceptName(t.title) === normalizedQuery) {
      exactMatch = {
        termId: t.id,
        title: t.title,
        category: t.category,
        matchedVia: 'title',
        aliases: t.aliases || [],
        summary: t.summary,
      };
      break;
    }
    const hitAlias = (t.aliases || []).find(
      (a) => normalizeConceptName(a) === normalizedQuery
    );
    if (hitAlias) {
      exactMatch = {
        termId: t.id,
        title: t.title,
        category: t.category,
        matchedVia: 'alias',
        aliases: t.aliases || [],
        summary: t.summary,
      };
      break;
    }
  }

  const memRows = normalizedQuery
    ? await pgQuery(
        `SELECT * FROM lexicon_expansion_candidates WHERE normalized_name = $1 LIMIT 1`,
        [normalizedQuery]
      )
    : [];
  const memoryMatch =
    memRows.length > 0 ? rowToExpansionCandidate(memRows[0]) : null;

  const similarTerms: SimilarTermRecall[] = [];
  for (const t of allTerms) {
    if (exactMatch && t.id === exactMatch.termId) continue;
    const { score, hint } = computeConceptSimilarity(
      normalizedQuery,
      t,
      preferredCategory
    );
    if (score >= 0.25) {
      similarTerms.push({
        id: t.id,
        title: t.title,
        category: t.category,
        aliases: t.aliases || [],
        summary: t.summary,
        similarityScore: score,
        matchHint: hint,
      });
    }
  }
  similarTerms.sort((a, b) => b.similarityScore - a.similarityScore);

  return {
    query: cleanQuery,
    normalizedQuery,
    exactMatch,
    memoryMatch,
    similarTerms: similarTerms.slice(0, 5),
  };
}

/**
 * 双向绑定两个词条的业务关联 (relations)，在 PostgreSQL 层通过 JSONB 原子去重追加，防止并发覆盖
 */
export async function bindTermRelationBidirectionalSql(
  termIdA: string,
  termIdB: string,
  labelFromAToB = '核心关联概念',
  labelFromBToA = '核心关联概念'
): Promise<void> {
  if (!termIdA || !termIdB || termIdA === termIdB) return;
  const appendRelationSql = `
    UPDATE lexicon_terms
    SET relations_json = (
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(NULLIF(relations_json, '')::jsonb, '[]'::jsonb)) AS elem
          WHERE elem->>'target' = $2
        ) THEN relations_json
        ELSE (
          COALESCE(NULLIF(relations_json, '')::jsonb, '[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('target', $2::text, 'label', $3::text))
        )::text
      END
    )
    WHERE id = $1
  `;
  await pgExecute(appendRelationSql, [termIdA, termIdB, labelFromAToB]);
  await pgExecute(appendRelationSql, [termIdB, termIdA, labelFromBToA]);
}
