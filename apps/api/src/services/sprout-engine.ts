import type {
  CandidateAction,
  CategoryId,
  ExpansionCandidate,
  ExpansionRun,
  TermEntry,
} from '@glossa/schema';
import { lexiconStore } from './lexicon-store.js';
import { validateAllowedLlmBaseUrl } from './agent-harness.js';
import { generateTermWithHarness } from './term-synthesis.js';

export interface DissectSproutInputItem {
  name: string;
  category?: CategoryId;
  quote: string;
  relationLabel: string;
  whyItMatters: string;
  recommendedAction?: CandidateAction;
  recommendedTargetTermId?: string;
  recommendationReason?: string;
}

export function extractTextSproutCandidates(
  sourceTerm: TermEntry,
  existingTerms: TermEntry[]
): DissectSproutInputItem[] {
  const results: DissectSproutInputItem[] = [];
  const seenNorm = new Set<string>();
  const sourceSelfNorms = new Set<string>([
    lexiconStore.normalizeConceptName(sourceTerm.id),
    lexiconStore.normalizeConceptName(sourceTerm.title),
    ...(sourceTerm.aliases || []).map((a) => lexiconStore.normalizeConceptName(a)),
  ]);
  const existingNorms = new Set<string>();
  for (const t of existingTerms) {
    existingNorms.add(lexiconStore.normalizeConceptName(t.id));
    existingNorms.add(lexiconStore.normalizeConceptName(t.title));
    for (const al of t.aliases || []) {
      existingNorms.add(lexiconStore.normalizeConceptName(al));
    }
  }

  // 2. Scan articleMarkdown, summary, and FAQs for domain concepts (preserve <strong> as ** before stripping HTML tags)
  const fullText = [
    sourceTerm.summary,
    sourceTerm.layman.plain,
    sourceTerm.articleMarkdown
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
      .replace(/<[^>]+>/g, ' '),
    ...(sourceTerm.faqs || []).map((f) => `${f.q} ${f.a}`),
  ].join('\n');

  const STOP_PHRASES = new Set([
    '业务本质',
    '核心定义',
    '通俗理解',
    '核心规则',
    '一句话总结',
    '常见问题',
    '一句话定义',
    '通俗比喻',
    '操作步骤',
    '注意事项',
    '系统表现',
    '排查动作',
    '业务含义',
    '核查要点',
    '流转阶段',
    '参与角色',
    '关键节点',
    '处理方案',
    '原因分析',
    '解决方案',
    '状态说明',
  ]);

  const regexes = [
    /\*\*([\u4e00-\u9fa5A-Za-z0-9·\-]{2,18})\*\*/g,
    /[【「]([\u4e00-\u9fa5A-Za-z0-9·\-]{2,18})[】」]/g,
  ];

  for (const rgx of regexes) {
    let match: RegExpExecArray | null;
    while ((match = rgx.exec(fullText)) !== null) {
      const phrase = match[1].trim();
      const norm = lexiconStore.normalizeConceptName(phrase);
      if (
        !norm ||
        norm.length < 2 ||
        seenNorm.has(norm) ||
        sourceSelfNorms.has(norm) ||
        existingNorms.has(norm) ||
        STOP_PHRASES.has(phrase) ||
        /^(阶段|步骤|场景|问题|原因|规则|维度|指标|方式|类型|状态)\d*$/.test(phrase)
      ) {
        continue;
      }

      seenNorm.add(norm);
      const idx = match.index;
      const snippetStart = Math.max(0, idx - 28);
      const snippetEnd = Math.min(fullText.length, idx + phrase.length + 38);
      const quote = fullText
        .slice(snippetStart, snippetEnd)
        .replace(/\s+/g, ' ')
        .trim();

      results.push({
        name: phrase,
        category: sourceTerm.category,
        quote,
        relationLabel: '正文提及的上下游业务概念',
        whyItMatters: `在【${sourceTerm.title}】业务规则中被重点强调，涉及跨环节协同或准入核验口径。`,
      });
      if (results.length >= 8) break;
    }
    if (results.length >= 8) break;
  }

  return results.slice(0, 8);
}

/**
 * 顺藤摸瓜触手剖析器 (dissectTermSproutsWithHarness)
 */
export async function dissectTermSproutsWithHarness(input: {
  sourceTermId?: string;
  rawText?: string;
  sourceTitle?: string;
  runId?: string;
  depth?: number;
  maxDepth?: number;
  maxDrafts?: number;
  operator?: string;
  customSprouts?: DissectSproutInputItem[];
}): Promise<{
  run: ExpansionRun;
  sourceTermId: string;
  sourceTermTitle: string;
  enqueued: ExpansionCandidate[];
  autoLinked: ExpansionCandidate[];
  mergedOrigins: ExpansionCandidate[];
  allTermCandidates: ExpansionCandidate[];
  mode: 'antigravity-direct' | 'llm-dissector' | 'domain-rule-dissector';
}> {
  const operator = input.operator || 'antigravity-harness';
  const allTerms = await lexiconStore.getTermsAsync();
  let sourceTerm = input.sourceTermId
    ? await lexiconStore.getTermByIdAsync(input.sourceTermId)
    : undefined;

  if (!sourceTerm && input.sourceTermId) {
    const qNorm = lexiconStore.normalizeConceptName(input.sourceTermId);
    sourceTerm =
      allTerms.find(
        (t) =>
          lexiconStore.normalizeConceptName(t.title) === qNorm ||
          (t.aliases || []).some((a) => lexiconStore.normalizeConceptName(a) === qNorm)
      ) ||
      allTerms.find(
        (t) =>
          t.category !== 'asop' &&
          (t.title.includes(input.sourceTermId!.trim()) ||
            (t.aliases || []).some((a) => a.includes(input.sourceTermId!.trim())))
      );
  }

  const effectiveSourceId = sourceTerm?.id || input.sourceTermId || 'seed-text';
  const effectiveSourceTitle =
    sourceTerm?.title || input.sourceTitle || '自定义业务种子文本';

  let rawSprouts: DissectSproutInputItem[] = [];
  let mode: 'antigravity-direct' | 'llm-dissector' | 'domain-rule-dissector' =
    'domain-rule-dissector';

  const defaultCategory =
    lexiconStore.getCategories().find((c) => c.id !== 'asop')?.id || 'core';

  if (Array.isArray(input.customSprouts) && input.customSprouts.length > 0) {
    rawSprouts = input.customSprouts;
    mode = 'antigravity-direct';
  } else if (sourceTerm) {
    rawSprouts = extractTextSproutCandidates(sourceTerm, allTerms);
  } else if (input.rawText) {
    const tempTerm: TermEntry = {
      id: effectiveSourceId,
      title: effectiveSourceTitle,
      pinyin: 'SEED',
      category: defaultCategory,
      aliases: [],
      summary: input.rawText.slice(0, 200),
      layman: { analogy: '', plain: input.rawText.slice(0, 200) },
      articleMarkdown: input.rawText,
      relations: [],
      faqs: [],
    };
    rawSprouts = extractTextSproutCandidates(tempTerm, allTerms);
  }

  const aiCfg = await lexiconStore.getServerAiConfig();
  if (
    mode !== 'antigravity-direct' &&
    aiCfg.hasKey &&
    aiCfg.apiKey &&
    (sourceTerm || input.rawText)
  ) {
    try {
      const safeBaseUrl = validateAllowedLlmBaseUrl(aiCfg.baseUrl);
      const endpoint = safeBaseUrl.endsWith('/v1')
        ? `${safeBaseUrl}/chat/completions`
        : `${safeBaseUrl}/v1/chat/completions`;
      const rawBodyText = sourceTerm
        ? `${sourceTerm.summary}\n${sourceTerm.articleMarkdown}`
        : String(input.rawText || '');
      const textForProbes = rawBodyText
        .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
        .replace(/<[^>]+>/g, ' ');
      const cleanBodyForLlm = textForProbes.replace(/[ \t]+/g, ' ').trim();
      const extraProbes = Array.from(
        new Set(
          (
            textForProbes.match(
              /(?:\*\*|【|「)([\u4e00-\u9fa5A-Za-z0-9·\-]{3,14})(?:\*\*|】|」)/g
            ) || []
          ).map((m) => m.replace(/^\*\*|\*\*$|^【|】$|^「|」$/g, '').trim())
        )
      ).slice(0, 8);
      const probeNames = Array.from(
        new Set([...rawSprouts.map((s) => s.name), ...extraProbes])
      ).slice(0, 10);

      const recallContext = await Promise.all(
        probeNames.map(async (name) => {
          const lk = await lexiconStore.lookupConceptAsync(
            name,
            sourceTerm?.category
          );
          return {
            candidateName: name,
            exactMatch: lk.exactMatch,
            similarTerms: lk.similarTerms.slice(0, 3),
          };
        })
      );
      const parentNeighbors = sourceTerm
        ? [
            {
              id: sourceTerm.id,
              title: sourceTerm.title,
              aliases: sourceTerm.aliases || [],
            },
            ...(sourceTerm.relations || [])
              .map((r) => allTerms.find((t) => t.id === r.target))
              .filter((t): t is TermEntry => Boolean(t))
              .map((t) => ({
                id: t.id,
                title: t.title,
                aliases: t.aliases || [],
              })),
          ]
        : [];

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiCfg.apiKey}`,
        },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          model: aiCfg.model || 'deepseek-chat',
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: [
                '你是 Glossa 领域百科的「触手剖析与价值过滤专家 (Sprout Dissector & Value Gate)」。',
                '请从给定的父词条正文中剖析出 3~6 个值得处理的业务概念触手，并对照库内相似词条召回结果，输出严格的 JSON 数组：',
                '[{"name":"概念名称","category":"领域分类ID","quote":"原文引用句","relationLabel":"与父词条的关系名","whyItMatters":"业务价值说明","recommendedAction":"GENERATE_TERM | MERGE_AS_ALIAS | REJECT","recommendedTargetTermId":"当为MERGE_AS_ALIAS或强关联对比时填入已有词条ID","recommendationReason":"为什么建议独立建词、并入已有词条别名或剔除"}]',
                '判断铁律：',
                '1. 若该概念与库内已有词条（或父词条及其直接关联词条）属于“同物异名/同义简称”，必须将 recommendedAction 设为 "MERGE_AS_ALIAS" 并填入 recommendedTargetTermId！',
                '2. 若该概念有独立的业务准入、状态流转、角色分工或核算规则，设为 "GENERATE_TERM"。',
                '3. 若是日常通用词汇、纯技术底层词，或仅仅是正文中的“表格步骤名/章节小标题/临时动作并列短语”，请直接忽略或设为 "REJECT"！',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                `父词条：【${effectiveSourceTitle} (${effectiveSourceId})】`,
                `父词条直接关联的库内既有词条（可直接作为同义归并或关联目标）：\n${JSON.stringify(parentNeighbors)}`,
                `正文内容：\n${cleanBodyForLlm}`,
                `初步提取候选及库内相似词召回：\n${JSON.stringify(recallContext)}`,
              ].join('\n\n'),
            },
          ],
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        const rawContent = String(data?.choices?.[0]?.message?.content || '');
        const arrMatch = rawContent.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          const parsed = JSON.parse(arrMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const rawByNorm = new Map<string, DissectSproutInputItem>();
            const byNorm = new Map<string, DissectSproutInputItem>();
            for (const item of rawSprouts) {
              const normKey = lexiconStore.normalizeConceptName(item.name);
              rawByNorm.set(normKey, item);
              if (item.recommendedAction) {
                byNorm.set(normKey, item);
              }
            }
            for (const aiItem of parsed) {
              if (!aiItem?.name) continue;
              const cleanAiName = String(aiItem.name).trim();
              const norm = lexiconStore.normalizeConceptName(cleanAiName);
              const existing = byNorm.get(norm) || rawByNorm.get(norm);
              const rawCat =
                aiItem.category && aiItem.category !== 'asop'
                  ? aiItem.category
                  : existing?.category && existing.category !== 'asop'
                    ? existing.category
                    : sourceTerm?.category && sourceTerm.category !== 'asop'
                      ? sourceTerm.category
                      : defaultCategory;
              byNorm.set(norm, {
                name: cleanAiName,
                category: rawCat,
                quote: aiItem.quote || existing?.quote || cleanAiName,
                relationLabel: aiItem.relationLabel || existing?.relationLabel || '顺藤摸瓜关联概念',
                whyItMatters: aiItem.whyItMatters || existing?.whyItMatters || '正文中涉及的关键业务分叉概念',
                recommendedAction:
                  aiItem.recommendedAction || existing?.recommendedAction,
                recommendedTargetTermId:
                  aiItem.recommendedTargetTermId || existing?.recommendedTargetTermId,
                recommendationReason:
                  aiItem.recommendationReason || existing?.recommendationReason,
              });
            }
            rawSprouts = Array.from(byNorm.values()).slice(0, 8);
            mode = 'llm-dissector';
          }
        }
      }
    } catch {
      // Keep deterministic domain-rule sprouts on LLM timeout/error
    }
  }

  const enqueueResult = await lexiconStore.enqueueCandidatesAsync({
    runId: input.runId,
    rootSeedType: input.rawText && !sourceTerm ? 'text' : 'term',
    rootSeedRef: effectiveSourceId,
    runTitle: `从【${effectiveSourceTitle}】引爆的触手裂变与同义归并批次`,
    depth: input.depth ?? 1,
    maxDepth: input.maxDepth,
    maxDrafts: input.maxDrafts,
    operator,
    candidates: rawSprouts.map((s) => ({
      name: s.name,
      category: s.category || sourceTerm?.category || defaultCategory,
      sourceTermId: effectiveSourceId,
      sourceTermTitle: effectiveSourceTitle,
      quote: s.quote || s.name,
      relationLabel: s.relationLabel || '顺藤摸瓜关联概念',
      whyItMatters: s.whyItMatters || '核心业务分叉触手',
      recommendedAction: s.recommendedAction,
      recommendedTargetTermId: s.recommendedTargetTermId,
      recommendationReason: s.recommendationReason,
    })),
  });

  const overview = await lexiconStore.getHarnessOverviewAsync({
    sourceTermId: effectiveSourceId,
  });

  return {
    run: enqueueResult.run,
    sourceTermId: effectiveSourceId,
    sourceTermTitle: effectiveSourceTitle,
    enqueued: enqueueResult.enqueued,
    autoLinked: enqueueResult.autoLinked,
    mergedOrigins: enqueueResult.mergedOrigins,
    allTermCandidates: overview.termCandidates,
    mode,
  };
}

/**
 * 针对单个候选触手执行决议与繁衍 (expandCandidateWithHarness)
 */
export async function expandCandidateWithHarness(
  candidateIdOrName: string,
  options?: {
    action?: CandidateAction;
    targetTermId?: string;
    decisionNote?: string;
    customTerm?: TermEntry;
    publishImmediately?: boolean;
    autoDissectNextLayer?: boolean;
    operator?: string;
  }
): Promise<{
  candidate: ExpansionCandidate;
  affectedTerm: TermEntry | null;
  run: ExpansionRun | null;
  nextLayerSprouts?: ExpansionCandidate[];
}> {
  const operator = options?.operator || 'antigravity-harness';
  const initialCand = await lexiconStore.getCandidateByIdOrNameAsync(candidateIdOrName);
  if (!initialCand) {
    throw new Error(`未找到候选触手: ${candidateIdOrName}`);
  }

  return lexiconStore.withCandidateResolutionLock(
    `expand:${initialCand.normalizedName}`,
    async () => {
      const cand = await lexiconStore.getCandidateByIdOrNameAsync(initialCand.id);
      if (!cand) {
        throw new Error(`未找到候选触手: ${candidateIdOrName}`);
      }

      const effectiveAction: CandidateAction =
        options?.action || cand.recommendedAction || 'GENERATE_TERM';
      const effectiveTargetId =
        options?.targetTermId || cand.recommendedTargetTermId;

      if (effectiveAction === 'MERGE_AS_ALIAS') {
        return lexiconStore.resolveCandidateAsync(
          cand.id,
          {
            action: 'MERGE_AS_ALIAS',
            targetTermId: effectiveTargetId,
            decisionNote:
              options?.decisionNote ||
              `同义概念归并：将「${cand.name}」并入【${effectiveTargetId}】标准别名`,
          },
          operator
        );
      }

      if (effectiveAction === 'LINK_EXISTING') {
        return lexiconStore.resolveCandidateAsync(
          cand.id,
          {
            action: 'LINK_EXISTING',
            targetTermId: effectiveTargetId,
            decisionNote: options?.decisionNote,
          },
          operator
        );
      }

      if (effectiveAction === 'REJECT') {
        return lexiconStore.resolveCandidateAsync(
          cand.id,
          {
            action: 'REJECT',
            decisionNote:
              options?.decisionNote ||
              cand.recommendationReason ||
              '通用词汇或无独立业务流转规则，已记入剔除记忆',
          },
          operator
        );
      }

      if (cand.status === 'GENERATED' && cand.targetTermId) {
        const existingGenerated = await lexiconStore.getTermByIdAsync(cand.targetTermId);
        if (existingGenerated) {
          const idempotentRes = await lexiconStore.resolveCandidateAsync(
            cand.id,
            {
              action: 'GENERATE_TERM',
              targetTermId: effectiveTargetId,
              generatedTerm: existingGenerated,
              publishImmediately: existingGenerated.meta?.status === 'PUBLISHED',
            },
            operator
          );
          return idempotentRes;
        }
      }

      let termToSave: TermEntry | undefined = options?.customTerm;
      let isVerified = Boolean(options?.customTerm);

      if (!termToSave) {
        const parentContext = cand.origins
          .map(
            (o) =>
              `来源词条【${o.sourceTermTitle} (${o.sourceTermId})】（关系：${o.relationLabel}）：「${o.quote}」—— 业务价值：${o.whyItMatters}`
          )
          .join('\n');

        const lookup = await lexiconStore.lookupConceptAsync(cand.name, cand.category);
        const twinTerm = lookup.similarTerms[0];
        const deterministicTermId =
          cand.targetTermId ||
          `term-sprout-${cand.id.replace(/^cand_/, '')}`;

        const generated = await generateTermWithHarness(cand.name, operator, {
          preferredId: deterministicTermId,
          persistImmediately: false,
          contextSnippet: parentContext,
          sourceTermId: cand.origins[0]?.sourceTermId,
          category: cand.category,
          aiExplanation: [
            `【${cand.name}】是从${cand.origins.map((o) => `【${o.sourceTermTitle}】`).join('、')}顺藤摸瓜繁衍出的业务词条。`,
            cand.origins[0]?.whyItMatters || '',
            twinTerm
              ? `\n### 与相近概念【${twinTerm.title}】的业务边界区分\n- **${cand.name}**：聚焦于${cand.origins[0]?.whyItMatters || '专项业务环节管控与执行准入'}。\n- **${twinTerm.title}**：${twinTerm.summary}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        isVerified = generated.grounded;
        const allowPublish = isVerified && options?.publishImmediately !== false;
        termToSave = {
          ...generated.term,
          meta: {
            ...(generated.term.meta || {
              updatedAt: new Date().toISOString().slice(0, 10),
              maintainedBy: operator,
              revision: 1,
            }),
            status: allowPublish ? 'PUBLISHED' : 'DRAFT',
          },
        };
      }

      const finalPublishImmediately =
        isVerified && options?.publishImmediately !== false;

      const resolved = await lexiconStore.resolveCandidateAsync(
        cand.id,
        {
          action: 'GENERATE_TERM',
          targetTermId: effectiveTargetId,
          decisionNote:
            options?.decisionNote ||
            (isVerified
              ? `顺藤摸瓜生成新词条【${termToSave.title} (${termToSave.id})】并完成父子双向关联`
              : `顺藤摸瓜生成待考据词条草稿【${termToSave.title} (${termToSave.id})】（无源码/AI实证，已拦截自动转正并保留为 DRAFT）`),
          generatedTerm: termToSave,
          publishImmediately: finalPublishImmediately,
        },
        operator
      );

      let nextLayerSprouts: ExpansionCandidate[] | undefined;
      const maxDepth = resolved.run?.maxDepth ?? 2;
      if (
        options?.autoDissectNextLayer &&
        isVerified &&
        resolved.affectedTerm &&
        resolved.affectedTerm.meta?.status === 'PUBLISHED' &&
        cand.depth < maxDepth
      ) {
        const nextDissect = await dissectTermSproutsWithHarness({
          sourceTermId: resolved.affectedTerm.id,
          runId: cand.runId,
          depth: cand.depth + 1,
          operator,
        });
        nextLayerSprouts = nextDissect.enqueued;
      }

      return {
        ...resolved,
        nextLayerSprouts,
      };
    }
  );
}

/**
 * 一键引爆波次执行器 (runSproutWaveWithHarness)
 */
export async function runSproutWaveWithHarness(input: {
  seedTermId: string;
  maxDepth?: number;
  maxDrafts?: number;
  autoResolve?: boolean;
  operator?: string;
}): Promise<{
  run: ExpansionRun;
  dissectedCount: number;
  mergedAliases: ExpansionCandidate[];
  generatedTerms: TermEntry[];
  rejectedCandidates: ExpansionCandidate[];
  pendingCandidates: ExpansionCandidate[];
}> {
  const operator = input.operator || 'antigravity-harness';
  const effectiveMaxDepth = Math.max(1, input.maxDepth ?? 2);
  const effectiveMaxDrafts = Math.max(1, input.maxDrafts ?? 5);

  const dissectRes = await dissectTermSproutsWithHarness({
    sourceTermId: input.seedTermId,
    depth: 1,
    maxDepth: effectiveMaxDepth,
    maxDrafts: effectiveMaxDrafts,
    operator,
  });

  const runId = dissectRes.run.id;
  const runMaxDepth = dissectRes.run.maxDepth || effectiveMaxDepth;
  const runMaxDrafts = dissectRes.run.maxDrafts || effectiveMaxDrafts;

  const mergedAliases: ExpansionCandidate[] = [];
  const generatedTerms: TermEntry[] = [];
  const rejectedCandidates: ExpansionCandidate[] = [];

  if (input.autoResolve !== false) {
    for (let currentDepth = 1; currentDepth <= runMaxDepth; currentDepth++) {
      const waveOverview = await lexiconStore.getHarnessOverviewAsync({
        runId,
      });
      let totalGeneratedInRun = waveOverview.candidates.filter(
        (c) => c.status === 'GENERATED'
      ).length;
      const pendingAtDepth = waveOverview.candidates.filter(
        (c) => c.status === 'PENDING' && c.depth === currentDepth
      );
      if (pendingAtDepth.length === 0) {
        continue;
      }

      for (const cand of pendingAtDepth) {
        if (cand.recommendedAction === 'MERGE_AS_ALIAS' && cand.recommendedTargetTermId) {
          const r = await expandCandidateWithHarness(cand.id, {
            action: 'MERGE_AS_ALIAS',
            targetTermId: cand.recommendedTargetTermId,
            operator,
          });
          mergedAliases.push(r.candidate);
        } else if (cand.recommendedAction === 'REJECT') {
          const r = await expandCandidateWithHarness(cand.id, {
            action: 'REJECT',
            operator,
          });
          rejectedCandidates.push(r.candidate);
        } else if (
          cand.recommendedAction === 'GENERATE_TERM' &&
          totalGeneratedInRun < runMaxDrafts
        ) {
          const r = await expandCandidateWithHarness(cand.id, {
            action: 'GENERATE_TERM',
            publishImmediately: true,
            autoDissectNextLayer: currentDepth < runMaxDepth,
            operator,
          });
          if (r.affectedTerm) {
            generatedTerms.push(r.affectedTerm);
            totalGeneratedInRun++;
          }
        }
      }
    }
  }

  const finalOverview = await lexiconStore.getHarnessOverviewAsync({
    runId,
  });
  const updatedRun =
    finalOverview.runs.find((r) => r.id === runId) || dissectRes.run;

  return {
    run: updatedRun,
    dissectedCount: finalOverview.candidates.length,
    mergedAliases,
    generatedTerms,
    rejectedCandidates,
    pendingCandidates: finalOverview.candidates.filter((c) => c.status === 'PENDING'),
  };
}
