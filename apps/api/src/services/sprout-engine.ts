import type {
  CandidateAction,
  CategoryId,
  ExpansionCandidate,
  ExpansionRun,
  TermEntry,
} from '@glossa/schema';
import { lexiconStore } from './lexicon-store.js';
import { validateAllowedLlmBaseUrl } from './agent-harness.js';
import { generateTermWithHarness, sanitizeBusinessProse } from './term-synthesis.js';

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
  '适用范围',
  '关键管控点',
  '核心口径',
]);

/**
 * 触手候选准入闸门：
 * 拦截表格列名/角色职责短语（如“填报角色”“复盘角色”“操作步骤”）以及纯技术底层词汇（如“分布式锁”“Redis”“Controller”“LogDo”）。
 */
export function isNoiseOrTechCandidate(phrase: string): boolean {
  const clean = String(phrase || '').trim();
  if (!clean || clean.length < 2 || clean.length > 20) return true;
  if (STOP_PHRASES.has(clean)) return true;

  // 1. 通用编号或表格维度表头
  if (
    /^(阶段|步骤|场景|问题|原因|规则|维度|指标|方式|类型|状态|环节|动作|节点|条件|说明|备注)\d*$/.test(
      clean
    )
  ) {
    return true;
  }

  // 2. 表格角色列头或临时动作并列短语
  if (
    /(?:填报角色|复盘角色|治理人员|双标识核对|^接手方|进货记录|操作步骤|处理动作|执行动作|审批角色|负责角色|核查动作|流转动作|触发条件|判定结果|系统动作|异常表现|排查建议)$/.test(
      clean
    ) ||
    /^(?:业代|主管|经理|总监|内勤|财务|管理员|系统|操作人)[\/、与及和]/.test(clean)
  ) {
    return true;
  }

  // 3. 纯技术基建词汇、中间件或代码类名后缀（避免把 Invoice 误判为 VO）
  if (
    /(?:分布式锁|死信队列|消息总线|读写分离|路由转发|幂等键|事务回滚|索引优化|连接池|线程池|乐观锁|悲观锁)/.test(
      clean
    ) ||
    /\b(?:Redis|TDMQ|Pulsar|Kafka|RocketMQ|XDAL|MyBatis|Spring|Feign|IFID|POJO)\b/i.test(
      clean
    ) ||
    /(?:LogDo|Controller|ServiceImpl|Mapper|Repository|DTO|VO)$/.test(clean)
  ) {
    return true;
  }

  // 4. 代码方法名/变量名（camelCase 或 snake_case）或源码文件名（保留正常英文业务概念如 Subscription / Invoice / SKU）
  if (
    /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(clean) ||
    /^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(clean) ||
    /\.(?:java|ts|tsx|kt|vue|js|py|go|sql|xml|json)$/i.test(clean)
  ) {
    return true;
  }

  return false;
}

function inferNonAsopCategory(
  phrase: string,
  preferredCategory?: CategoryId
): CategoryId {
  const validCategories = lexiconStore
    .getCategories()
    .filter((c) => c.id !== 'asop');
  const defaultCategory = validCategories[0]?.id || 'core';

  if (
    preferredCategory &&
    preferredCategory !== 'asop' &&
    validCategories.some((c) => c.id === preferredCategory)
  ) {
    // 若 phrase 明确包含其他分类名称的前缀关键字，则优先归入语义匹配的分类
    const matchedByKeyword = validCategories.find(
      (c) => c.name.length >= 2 && phrase.includes(c.name.slice(0, 2))
    );
    return matchedByKeyword?.id || preferredCategory;
  }

  const matched = validCategories.find(
    (c) => c.name.length >= 2 && phrase.includes(c.name.slice(0, 2))
  );
  return matched?.id || defaultCategory;
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
        isNoiseOrTechCandidate(phrase)
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
        category: inferNonAsopCategory(phrase, sourceTerm.category),
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
          )
            .map((m) => m.replace(/^\*\*|\*\*$|^【|】$|^「|」$/g, '').trim())
            .filter((m) => !isNoiseOrTechCandidate(m))
        )
      ).slice(0, 8);
      const probeNames = Array.from(
        new Set([...rawSprouts.map((s) => s.name), ...extraProbes])
      ).slice(0, 10);

      const validDomainCategories = lexiconStore
        .getCategories()
        .filter((c) => c.id !== 'asop')
        .map((c) => ({ id: c.id, name: c.name }));

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
                '[{"name":"概念名称","category":"必须从给定的可用业务领域分类ID中选择（严禁使用asop）","quote":"原文引用句","relationLabel":"与父词条的关系名","whyItMatters":"业务价值说明","recommendedAction":"GENERATE_TERM | MERGE_AS_ALIAS | REJECT","recommendedTargetTermId":"当为MERGE_AS_ALIAS或强关联对比时填入已有词条ID","recommendationReason":"为什么建议独立建词、并入已有词条别名或剔除"}]',
                `当前词库合法的业务领域分类列表（请根据子概念自身的业务属性归入最匹配的 category，严禁盲目继承父词条的 asop）：${JSON.stringify(validDomainCategories)}`,
                '判断铁律：',
                '1. 若该概念与库内已有词条（或父词条及其直接关联词条）属于“同物异名/同义简称”，必须将 recommendedAction 设为 "MERGE_AS_ALIAS" 并填入 recommendedTargetTermId！',
                '2. 若该概念有独立的业务准入、状态流转、角色分工或核算规则，设为 "GENERATE_TERM"。',
                '3. 若是日常通用词汇、纯技术底层词（如 Redis、TDMQ、Controller、分布式锁），或仅仅是正文中的“表格角色列头/操作步骤名/章节小标题/临时动作并列短语”（如填报角色、复盘角色、操作步骤），请直接忽略或设为 "REJECT"！',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                `父词条：【${effectiveSourceTitle} (${effectiveSourceId})】`,
                `可用业务领域分类（严禁选 asop）：${JSON.stringify(validDomainCategories)}`,
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
              if (
                isNoiseOrTechCandidate(cleanAiName) &&
                aiItem.recommendedAction !== 'REJECT'
              ) {
                continue;
              }
              const norm = lexiconStore.normalizeConceptName(cleanAiName);
              const existing = byNorm.get(norm) || rawByNorm.get(norm);
              const rawCat = inferNonAsopCategory(
                cleanAiName,
                aiItem.category && aiItem.category !== 'asop'
                  ? aiItem.category
                  : existing?.category && existing.category !== 'asop'
                    ? existing.category
                    : sourceTerm?.category
              );
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

  const filteredSprouts = rawSprouts.filter(
    (s) =>
      mode === 'antigravity-direct' ||
      s.recommendedAction === 'REJECT' ||
      !isNoiseOrTechCandidate(s.name)
  );

  const enqueueResult = await lexiconStore.enqueueCandidatesAsync({
    runId: input.runId,
    rootSeedType: input.rawText && !sourceTerm ? 'text' : 'term',
    rootSeedRef: effectiveSourceId,
    runTitle: `从【${effectiveSourceTitle}】引爆的触手裂变与同义归并批次`,
    depth: input.depth ?? 1,
    maxDepth: input.maxDepth,
    maxDrafts: input.maxDrafts,
    operator,
    candidates: filteredSprouts.map((s) => ({
      name: s.name,
      category: inferNonAsopCategory(
        s.name,
        s.category || sourceTerm?.category || defaultCategory
      ),
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

export interface LexiconQualityAuditReport {
  totalTerms: number;
  healthyTerms: number;
  autoFixedCount: number;
  codeLeakageTerms: Array<{
    id: string;
    title: string;
    matches: string[];
    fixed: boolean;
  }>;
  categoryMismatches: Array<{
    id: string;
    title: string;
    fromCategory: string;
    toCategory: string;
    fixed: boolean;
  }>;
  duplicateTwins: Array<{
    termAId: string;
    termATitle: string;
    termBId: string;
    termBTitle: string;
    reason: string;
  }>;
  oneWayRelations: Array<{
    fromId: string;
    toId: string;
    fixed: boolean;
  }>;
  unlinkedMentions: Array<{
    sourceId: string;
    mentionedTargetId: string;
    mentionedTitle: string;
    fixed: boolean;
  }>;
}

/**
 * 词库质量巡检与一键自愈引擎 (auditLexiconQuality)
 * 检测并可选修复：
 * 1. 台前正文代码文件名/Commit哈希/DSML标签泄露 (codeLeakageTerms)
 * 2. 子触手误归入 asop 或非法分类 (categoryMismatches)
 * 3. 同义/重名双胞胎词条预警 (duplicateTwins)
 * 4. 单向断链血缘关系 (oneWayRelations) 与正文已提及但未建立 relations 的孤岛词条 (unlinkedMentions)
 */
export async function auditLexiconQuality(options?: {
  autoFix?: boolean;
  operator?: string;
}): Promise<LexiconQualityAuditReport> {
  const autoFix = Boolean(options?.autoFix);
  const operator = options?.operator || 'glossa-audit-harness';
  const allTerms = await lexiconStore.getTermsAsync();
  const validCategoryIds = new Set(
    lexiconStore.getCategories().map((c) => c.id)
  );

  const codeLeakageTerms: LexiconQualityAuditReport['codeLeakageTerms'] = [];
  const categoryMismatches: LexiconQualityAuditReport['categoryMismatches'] = [];
  const duplicateTwins: LexiconQualityAuditReport['duplicateTwins'] = [];
  const oneWayRelations: LexiconQualityAuditReport['oneWayRelations'] = [];
  const unlinkedMentions: LexiconQualityAuditReport['unlinkedMentions'] = [];

  const dirtyTerms = new Map<string, TermEntry>();
  const workingTerms = new Map<string, TermEntry>(
    allTerms.map((t) => [
      t.id,
      {
        ...t,
        layman: { ...t.layman },
        relations: [...(t.relations || [])],
        faqs: [...(t.faqs || [])],
      },
    ])
  );

  const markDirty = (t: TermEntry) => {
    workingTerms.set(t.id, t);
    dirtyTerms.set(t.id, t);
  };

  // 1. 检测代码文件名 / Commit 哈希 / DSML 泄露 & 2. 检测分类错配
  const leakRegex =
    /\b[A-Za-z0-9_./-]+\.(?:java|kt|ts|tsx|vue|js|py|go|sql|xml)\b|@[0-9a-f]{7,40}\b|<[｜|]DSML[｜|][^>]*>/gi;

  for (const term of workingTerms.values()) {
    const proseBlob = [
      term.summary,
      term.layman.analogy,
      term.layman.plain,
      term.articleMarkdown,
      ...(term.faqs || []).map((f) => `${f.q} ${f.a}`),
    ].join('\n');

    const matches = Array.from(new Set(proseBlob.match(leakRegex) || []));
    if (matches.length > 0) {
      if (autoFix) {
        term.summary = sanitizeBusinessProse(term.summary);
        term.layman = {
          analogy: sanitizeBusinessProse(term.layman.analogy),
          plain: sanitizeBusinessProse(term.layman.plain),
        };
        term.articleMarkdown = sanitizeBusinessProse(term.articleMarkdown);
        term.faqs = (term.faqs || []).map((f) => ({
          q: sanitizeBusinessProse(f.q),
          a: sanitizeBusinessProse(f.a),
        }));
        markDirty(term);
      }
      codeLeakageTerms.push({
        id: term.id,
        title: term.title,
        matches,
        fixed: autoFix,
      });
    }

    const isNonPlaybookAsop =
      term.category === 'asop' && term.id.startsWith('term-sprout-');
    const isInvalidCategory = !validCategoryIds.has(term.category);

    if (isNonPlaybookAsop || isInvalidCategory) {
      const fromCat = term.category;
      const toCat = inferNonAsopCategory(term.title);
      if (fromCat !== toCat) {
        if (autoFix) {
          term.category = toCat;
          markDirty(term);
        }
        categoryMismatches.push({
          id: term.id,
          title: term.title,
          fromCategory: fromCat,
          toCategory: toCat,
          fixed: autoFix,
        });
      }
    }
  }

  // 3. 检测重名或别名重叠的双胞胎词条
  const termList = Array.from(workingTerms.values());
  for (let i = 0; i < termList.length; i++) {
    for (let j = i + 1; j < termList.length; j++) {
      const a = termList[i];
      const b = termList[j];
      const aNorms = new Set([
        lexiconStore.normalizeConceptName(a.title),
        ...(a.aliases || []).map((al) => lexiconStore.normalizeConceptName(al)),
      ]);
      const bNorms = [
        lexiconStore.normalizeConceptName(b.title),
        ...(b.aliases || []).map((al) => lexiconStore.normalizeConceptName(al)),
      ].filter((n) => n.length >= 2);
      const overlap = bNorms.find((n) => aNorms.has(n));
      if (overlap) {
        duplicateTwins.push({
          termAId: a.id,
          termATitle: a.title,
          termBId: b.id,
          termBTitle: b.title,
          reason: `共享标准归一化名称/别名 "${overlap}"`,
        });
      }
    }
  }

  // 4. 检测并补齐正文已提及但未挂接 relations 的孤岛词条 + 单向断链血缘
  for (const source of workingTerms.values()) {
    const prose = `${source.summary}\n${source.layman.plain}\n${source.articleMarkdown}`;
    for (const candidateTarget of workingTerms.values()) {
      if (candidateTarget.id === source.id) continue;
      if (candidateTarget.title.length < 2) continue;
      const alreadyLinked = (source.relations || []).some(
        (r) => r.target === candidateTarget.id
      );
      if (
        !alreadyLinked &&
        (source.relations || []).length < 8 &&
        prose.includes(candidateTarget.title)
      ) {
        if (autoFix) {
          source.relations = [
            ...(source.relations || []),
            { target: candidateTarget.id, label: '正文提及关联概念' },
          ];
          markDirty(source);
        }
        unlinkedMentions.push({
          sourceId: source.id,
          mentionedTargetId: candidateTarget.id,
          mentionedTitle: candidateTarget.title,
          fixed: autoFix,
        });
      }
    }
  }

  for (const source of workingTerms.values()) {
    for (const rel of source.relations || []) {
      const target = workingTerms.get(rel.target);
      if (!target || target.id === source.id) continue;
      const hasReverse = (target.relations || []).some(
        (r) => r.target === source.id
      );
      if (!hasReverse) {
        if (autoFix) {
          target.relations = [
            ...(target.relations || []),
            { target: source.id, label: '关联上下游概念' },
          ];
          markDirty(target);
        }
        oneWayRelations.push({
          fromId: source.id,
          toId: target.id,
          fixed: autoFix,
        });
      }
    }
  }

  if (autoFix && dirtyTerms.size > 0) {
    for (const dirty of dirtyTerms.values()) {
      await lexiconStore.saveTermAsync(
        dirty,
        'Harness 质量巡检自动修复（台前净化/分类纠偏/双向血缘织网）',
        operator,
        dirty.meta?.revision
      );
    }
  }

  const unhealthyTermIds = new Set<string>([
    ...codeLeakageTerms.filter((i) => !i.fixed).map((i) => i.id),
    ...categoryMismatches.filter((i) => !i.fixed).map((i) => i.id),
    ...oneWayRelations.filter((i) => !i.fixed).map((i) => i.toId),
    ...unlinkedMentions.filter((i) => !i.fixed).map((i) => i.sourceId),
  ]);

  return {
    totalTerms: allTerms.length,
    healthyTerms: Math.max(0, allTerms.length - unhealthyTermIds.size),
    autoFixedCount: dirtyTerms.size,
    codeLeakageTerms,
    categoryMismatches,
    duplicateTwins,
    oneWayRelations,
    unlinkedMentions,
  };
}
