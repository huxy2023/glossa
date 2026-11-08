import crypto from 'node:crypto';
import type { AgentTraceStep, TermEntry } from '@glossa/schema';
import { grepPrdCode, readPrdFile } from './codebase-probe.js';
import { lexiconStore } from './lexicon-store.js';
import { validateAllowedLlmBaseUrl } from './agent-harness.js';

/**
 * 净化面向业务读者的台前文本：
 * 1. 剥离模型偶发泄露的 DSML 内部标签；
 * 2. 剥离裸露的代码文件名（.java/.kt/.ts/.tsx/.vue/.sql 等）与 @commit 哈希；
 * 3. 自动为 Mermaid 流程图中包含括号/斜杠的未加引号节点补齐双引号，防止渲染报错。
 */
export function sanitizeBusinessProse(text: string): string {
  if (!text) return '';
  let cleaned = String(text)
    .replace(/<[｜|]DSML[｜|][^>]*>/g, '')
    .replace(/<\/?[a-z_]+_call>/gi, '')
    .replace(
      /[（(][^（）()\n]*?\b[A-Za-z0-9_./-]+\.(?:java|kt|ts|tsx|vue|js|py|go|sql|xml)\b[^（）()\n]*?[）)]/gi,
      ''
    )
    .replace(
      /`?\b[A-Za-z0-9_./-]+\.(?:java|kt|ts|tsx|vue|js|py|go|sql|xml)(?:#L\d+(?:-L?\d+)?)?\b`?/gi,
      '系统核心规则模块'
    )
    .replace(/@[0-9a-f]{7,40}\b/gi, '');

  // 修复 Mermaid 节点中含 () 或 / 却未加双引号的语法隐患
  cleaned = cleaned.replace(
    /```mermaid([\s\S]*?)```/g,
    (_full, body: string) => {
      const safeBody = body.replace(
        /\b([A-Za-z0-9_]+)\[([^"\]\n]*?[()\/][^"\]\n]*?)\]/g,
        (_m, nodeId: string, label: string) =>
          `${nodeId}["${label.replace(/"/g, "'")}"]`
      );
      return `\`\`\`mermaid${safeBody}\`\`\``;
    }
  );

  return cleaned.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 考据生成新词条草稿并写入 PostgreSQL (状态设为 DRAFT，绝不在零命中时捏造假代码路径或假表名)
 */
export async function generateTermWithHarness(
  title: string,
  operator = 'admin',
  options?: {
    contextSnippet?: string;
    sourceTermId?: string;
    category?: TermEntry['category'];
    aiExplanation?: string;
    preferredId?: string;
    isGroundedOverride?: boolean;
    persistImmediately?: boolean;
  }
): Promise<{
  term: TermEntry;
  trace: AgentTraceStep[];
  grounded: boolean;
  hitCount: number;
}> {
  const cleanTitle = title.trim();
  const isAsopCategory = options?.category === 'asop';
  const slug =
    options?.preferredId?.trim() ||
    `${isAsopCategory ? 'asop' : 'term'}-${crypto
      .randomUUID()
      .replace(/-/g, '')
      .slice(0, 16)}`;

  if (options?.preferredId && options?.persistImmediately !== false) {
    const existingById = await lexiconStore.getTermByIdAsync(slug);
    if (existingById) {
      return {
        term: existingById,
        trace: [
          {
            tool: 'pg_save_term_draft',
            summary: `词条 ${slug} 已存在，直接幂等返回既有记录，避免覆盖已有内容`,
          },
        ],
        grounded: true,
        hitCount: 0,
      };
    }
  }

  const trace: AgentTraceStep[] = [];
  let hits = await grepPrdCode(cleanTitle, undefined, 8);
  trace.push({
    tool: 'grep_prd_code',
    summary: `在代码库中检索 "${cleanTitle}" -> 命中 ${hits.length} 处真实代码`,
  });

  if (options?.contextSnippet) {
    const codeTokens = Array.from(
      new Set(
        options.contextSnippet.match(
          /[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+|[A-Z][a-zA-Z0-9]{3,}/g
        ) || []
      )
    );
    for (const token of codeTokens.slice(0, 4)) {
      if (hits.length >= 8) break;
      const subHits = await grepPrdCode(token, undefined, 4);
      if (subHits.length > 0) {
        for (const sh of subHits) {
          if (
            !hits.some(
              (eh) => eh.repo === sh.repo && eh.path === sh.path && eh.line === sh.line
            )
          ) {
            hits.push(sh);
          }
        }
        trace.push({
          tool: 'grep_prd_code',
          summary: `结合上下文标识符 "${token}" 关联检索 -> 命中 ${subHits.length} 处真实代码`,
        });
      }
    }
  }

  if (hits.length === 0 && cleanTitle.length >= 4) {
    const stripped = cleanTitle
      .replace(
        /(?:变更免审批规则|免审批规则|变更审批|管理规则|核算规则|判定规则|执行标准|处理流程|管理办法|业务规则|校验规则|准入规则|规则|机制|体系|策略|标准|口径)$/g,
        ''
      )
      .trim();
    if (
      stripped.length >= 2 &&
      stripped !== cleanTitle &&
      /^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(stripped)
    ) {
      const subHits = await grepPrdCode(stripped, undefined, 6);
      if (subHits.length > 0) {
        hits = subHits;
        trace.push({
          tool: 'grep_prd_code',
          summary: `结合核心业务词干 "${stripped}" 检索代码库 -> 命中 ${subHits.length} 处真实代码`,
        });
      }
    }
  }

  const parentTerm = options?.sourceTermId
    ? await lexiconStore.getTermByIdAsync(options.sourceTermId)
    : undefined;

  // 将命中的前 4 处真实源码片段自动同步至 PostgreSQL lexicon_code_snapshots 并提取精准代码指针与多行源码切片
  const codeEvidenceNotes: string[] = [];
  const codeSlicesForPrompt: Array<{
    repo: string;
    path: string;
    lines: string;
    content: string;
  }> = [];
  const synthesizedPointers: NonNullable<TermEntry['engineering']>['pointers'] = [];

  for (const h of hits.slice(0, 4)) {
    const slice = await readPrdFile({
      repo: h.repo,
      filePath: h.path,
      lines: `L${Math.max(1, h.line - 10)}-L${h.line + 35}`,
      commit: h.commit,
    });
    const lineRange = slice
      ? `L${slice.startLine}-L${slice.endLine}`
      : `L${Math.max(1, h.line - 10)}-L${h.line + 35}`;
    const resolvedCommit = slice?.resolvedCommit || h.commit || 'HEAD';
    const branch = slice?.branch || h.branch || 'prd';

    if (slice && slice.content && synthesizedPointers.length < 4) {
      await lexiconStore.upsertCodeSnapshot({
        repo: slice.repo,
        branch: slice.branch,
        commitSha: slice.resolvedCommit,
        filePath: slice.path,
        lineRange,
        content: slice.content,
      });
      codeSlicesForPrompt.push({
        repo: slice.repo,
        path: slice.path,
        lines: lineRange,
        content: slice.content.slice(0, 1600),
      });
      const chineseComments =
        slice.content
          .match(/[\u4e00-\u9fa5][\u4e00-\u9fa50-9A-Za-z，。、；：（）“”！【】\s-]{5,80}/g)
          ?.map((s) => s.trim())
          .filter((s) => s.length >= 6) || [];
      if (chineseComments.length > 0) {
        codeEvidenceNotes.push(...chineseComments.slice(0, 2));
      }
    }

    if (
      !synthesizedPointers.some((p) => p.repo === h.repo && p.path === h.path)
    ) {
      synthesizedPointers.push({
        repo: h.repo,
        branch,
        commit: resolvedCommit,
        path: h.path,
        lines: lineRange,
        desc:
          sanitizeBusinessProse(h.snippet || '').slice(0, 100) ||
          `【${cleanTitle}】相关的业务规则与状态校验实现`,
      });
    }
  }

  // 若仍无直接命中但父词条存在已证实的源码指针，继承父词条关联链路指针兜底，防止同链路子词条变成无根孤岛
  if (
    synthesizedPointers.length === 0 &&
    parentTerm?.engineering?.pointers &&
    parentTerm.engineering.pointers.length > 0
  ) {
    for (const ptr of parentTerm.engineering.pointers.slice(0, 2)) {
      synthesizedPointers.push({
        repo: ptr.repo,
        branch: ptr.branch || 'prd',
        commit: ptr.commit,
        path: ptr.path,
        lines: ptr.lines,
        desc: `承接父词条【${parentTerm.title}】链路：${ptr.desc}`,
      });
    }
  }

  const synthesizedRepos = Array.from(
    new Set(synthesizedPointers.map((p) => p.repo))
  );
  let synthesizedDataMappings: NonNullable<
    TermEntry['engineering']
  >['dataMappings'] =
    parentTerm?.engineering?.dataMappings
      ? parentTerm.engineering.dataMappings.slice(0, 2)
      : [];

  const aiCfg = await lexiconStore.getServerAiConfig();
  const rawAdopted = String(options?.aiExplanation || '').trim();
  const cleanAdoptedFirstLine = rawAdopted
    ? rawAdopted
        .replace(/\*\*/g, '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 8 && !l.startsWith('#') && !l.startsWith('|')) ||
      rawAdopted.slice(0, 120)
    : '';

  const dedupedEvidenceNotes = Array.from(new Set(codeEvidenceNotes)).slice(0, 4);
  let generatedAnalogy = `可以把【${cleanTitle}】理解为业务流转链路中的一道专项准入或核算关卡——只有符合前置资格与单据闭环，后续动作才能顺畅放行。`;
  let generatedPlain = cleanAdoptedFirstLine
    ? cleanAdoptedFirstLine.slice(0, 160)
    : dedupedEvidenceNotes[0]
      ? `【${cleanTitle}】围绕「${dedupedEvidenceNotes[0]}」等业务规则展开，用于规范跨角色作业标准、资格核验与单据流转口径。`
      : `【${cleanTitle}】是当前业务协同体系中的核心领域概念，用于规范跨角色作业标准、资格核验与单据流转口径。`;

  let generatedMarkdown = rawAdopted
    ? [
        `## 业务定义与核心定位`,
        '',
        rawAdopted,
        ...(dedupedEvidenceNotes.length > 0
          ? [
              '',
              '## 系统校验与业务规则要点',
              '',
              ...dedupedEvidenceNotes.map((note) => `- ${note}`),
            ]
          : []),
      ].join('\n')
    : [
        `## 业务定义与核心定位`,
        '',
        `> **核心口径**：${generatedPlain}`,
        '',
        `## 参与角色与业务流转规则`,
        '',
        '| 维度 | 业务规则说明 |',
        '| :--- | :--- |',
        `| **适用范围** | 围绕「${cleanTitle}」涉及的业务申请、资质复核与执行闭环场景 |`,
        `| **关键管控点** | ${
          dedupedEvidenceNotes.length > 0
            ? dedupedEvidenceNotes.join('；')
            : '需确保前置资料齐全、状态处于有效期内，避免因口径不一致导致流程卡单'
        } |`,
      ].join('\n');

  let generatedFaqs: NonNullable<TermEntry['faqs']> = [
    {
      q: `在实际业务协同中，如何理解【${cleanTitle}】的定位与准入条件？`,
      a: `${generatedPlain} 在发起业务动作前，需先确认主体状态与前置资质已满足要求。`,
    },
    {
      q: `如果遇到【${cleanTitle}】触发系统拦截或状态异常，现场该如何排查？`,
      a: `${
        dedupedEvidenceNotes.length > 0
          ? `重点核查以下系统校验规则：${dedupedEvidenceNotes.join('；')}。`
          : `建议依次核对：1. 关联主数据或单据是否处于有效状态；2. 当前操作人角色与组织管辖范围是否匹配；3. 上游前置环节是否已完成闭环。`
      }`,
    },
  ];

  if (aiCfg.hasKey && aiCfg.apiKey) {
    try {
      const safeBaseUrl = validateAllowedLlmBaseUrl(aiCfg.baseUrl);
      trace.push({
        tool: 'llm_draft_synthesis',
        summary: `调用 ${aiCfg.model} 按 V5 因词制宜规范提炼【${cleanTitle}】词条草稿`,
      });
      const res = await fetch(`${safeBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiCfg.apiKey}`,
        },
        body: JSON.stringify({
          model: aiCfg.model || 'deepseek-chat',
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content:
                options?.category === 'asop'
                  ? '请基于给定的业务上下文与源码规则摘要，按 V5 规范输出 JSON 格式的【端到端业务流程攻略 (ASOP Playbook)】草稿：{"analogy":"一句通俗生活比喻","plain":"一句端到端全链路主线概述","markdown":"Markdown格式的端到端业务流程攻略，包含：1. 全链路流转图（使用 ```mermaid\\nflowchart LR\\nA[\\"阶段1\\"] --> B[\\"阶段2\\"]\\n``` 语法，含括号或斜杠的节点名必须加双引号）；2. 关键节点准入与状态拆解表格；3. 常见业务卡单排障指南（纯业务语言，严禁出现代码文件名、物理表名、Git哈希或Emoji）","faqs":[{"q":"高频排障问题1","a":"纯业务排障解答1"},{"q":"高频排障问题2","a":"纯业务排障解答2"}]}。'
                  : '请基于给定的业务上下文与源码规则摘要，按 V5「标准导读外壳 + 因词制宜自由表达内芯（反八股文模具）」规范输出 JSON 格式词条草稿：{"analogy":"一句通俗生活比喻","plain":"一句业务大白话定义","markdown":"因词制宜组织的Markdown正文（根据词条属性灵活选用生命周期状态表、核算公式与剔除边界表、或核心机制判定规则表；纯业务语言，严禁出现代码文件名、物理表名、Git哈希、装饰性Emoji或空洞AI套话）","faqs":[{"q":"一线高频排障/边界问题1","a":"具体核查步骤与业务解答1"},{"q":"跨角色协同或口径核对问题2","a":"具体核查步骤与业务解答2"}]}。',
            },
            {
              role: 'user',
              content: [
                `词条名称：${cleanTitle}`,
                rawAdopted ? `已验证的伴读解释：${rawAdopted}` : '',
                options?.contextSnippet ? `来源上下文：${options.contextSnippet}` : '',
                hits.length > 0
                  ? `真实代码考据命中摘要（共 ${hits.length} 处，请严格以源码实现中的真实判定顺序、状态流转与拦截条件为准转化为纯业务语言，严禁凭空脑补源码未实现的规则，且切勿暴露文件名或表名）：\n${JSON.stringify(
                      hits.slice(0, 5).map((h) => ({
                        repo: h.repo,
                        snippet: h.snippet,
                      }))
                    )}`
                  : '',
                codeSlicesForPrompt.length > 0
                  ? `精读的真实源码实现切片（唯一事实源，请严格遵循其中的真实逻辑）：\n${codeSlicesForPrompt
                      .map(
                        (s) =>
                          `--- [${s.repo}] (${s.lines}) ---\n${s.content}`
                      )
                      .join('\n\n')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        const rawContent = String(data?.choices?.[0]?.message?.content || '');
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.analogy) generatedAnalogy = parsed.analogy;
          if (parsed.plain) generatedPlain = parsed.plain;
          if (parsed.markdown) {
            generatedMarkdown = parsed.markdown;
          }
          if (Array.isArray(parsed.faqs) && parsed.faqs.length >= 2) {
            const validFaqs = parsed.faqs
              .filter((f: any) => f && f.q && f.a)
              .map((f: any) => ({
                q: sanitizeBusinessProse(String(f.q)),
                a: sanitizeBusinessProse(String(f.a)),
              }));
            if (validFaqs.length >= 2) {
              generatedFaqs = validFaqs;
            }
          }
          if (Array.isArray(parsed.dataMappings) && parsed.dataMappings.length > 0) {
            const validMappings = parsed.dataMappings.filter(
              (m: any) => m && m.db && m.table && m.field && m.rule
            );
            if (validMappings.length > 0) {
              synthesizedDataMappings = validMappings;
            }
          }
        }
      }
    } catch {
      // Keep clean business draft if LLM call fails
    }
  }

  // 对台前展示文本执行统一净化，杜绝文件名/Commit哈希/DSML标签泄露
  generatedAnalogy = sanitizeBusinessProse(generatedAnalogy);
  generatedPlain = sanitizeBusinessProse(generatedPlain);
  generatedMarkdown = sanitizeBusinessProse(generatedMarkdown);
  generatedFaqs = generatedFaqs.map((f) => ({
    q: sanitizeBusinessProse(f.q),
    a: sanitizeBusinessProse(f.a),
  }));

  // 仅当存在真实源码考据命中或显式授信/模板确认时方可视为已核实 (grounded=true)；仅继承父词条指针或纯模型合成的草稿必须保留为 DRAFT 待审
  const grounded = Boolean(hits.length > 0 || options?.isGroundedOverride);

  const defaultCategory =
    options?.category ||
    lexiconStore
      .getCategories()
      .find((c) => c.id !== 'asop' && cleanTitle.includes(c.name.slice(0, 2)))
      ?.id ||
    lexiconStore.getCategories().find((c) => c.id !== 'asop')?.id ||
    'core';

  // 自动扫描正文与摘要中提及的库内既有词条，织入双向血缘关系网
  const allExistingTerms = await lexiconStore.getTermsAsync();
  const autoRelations: NonNullable<TermEntry['relations']> = options?.sourceTermId
    ? [{ target: options.sourceTermId, label: '关联业务来源' }]
    : [];
  const combinedProse = `${generatedPlain}\n${generatedMarkdown}`;
  for (const existing of allExistingTerms) {
    if (existing.id === slug) continue;
    if (autoRelations.length >= 6) break;
    if (autoRelations.some((r) => r.target === existing.id)) continue;
    if (existing.title.length >= 2 && combinedProse.includes(existing.title)) {
      autoRelations.push({
        target: existing.id,
        label: '正文提及关联概念',
      });
    }
  }

  const newTerm: TermEntry = {
    id: slug,
    title: cleanTitle,
    subtitle:
      defaultCategory === 'asop'
        ? '端到端业务流程攻略 · 跨角色全链路流转与卡点排障'
        : '业务词条 · 核心概念与协同口径解析',
    pinyin: cleanTitle
      .slice(0, 4)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, 'LX'),
    category: defaultCategory,
    aliases: [cleanTitle],
    summary: generatedPlain,
    layman: {
      analogy: generatedAnalogy,
      plain: generatedPlain,
    },
    articleMarkdown: generatedMarkdown,
    engineering: {
      repos: synthesizedRepos,
      pointers: synthesizedPointers,
      dataMappings: synthesizedDataMappings,
    },
    relations: autoRelations,
    faqs: generatedFaqs,
    meta: {
      updatedAt: new Date().toISOString().slice(0, 10),
      maintainedBy: operator,
      status: 'DRAFT',
      revision: 1,
    },
  };

  if (options?.persistImmediately === false) {
    trace.push({
      tool: 'pg_save_term_draft',
      summary: `已在内存构建候选词条草稿 (grounded=${grounded}, pointers=${synthesizedPointers.length})，交由候选决议器执行跨进程原子抢占落库`,
    });
    return { term: newTerm, trace, grounded, hitCount: hits.length };
  }

  const saved = await lexiconStore.saveTermAsync(
    newTerm,
    rawAdopted
      ? `从伴读解释采纳生成词条草稿 (${hits.length} 处代码命中)`
      : `考据生成新词条草稿 (${hits.length} 处真实代码命中)`,
    operator
  );

  // 为自动织入的目标词条反向补齐血缘链接，杜绝单向孤岛链接
  for (const rel of autoRelations) {
    const targetTerm = await lexiconStore.getTermByIdAsync(rel.target);
    if (
      targetTerm &&
      !(targetTerm.relations || []).some((r) => r.target === saved.id)
    ) {
      const updatedTarget: TermEntry = {
        ...targetTerm,
        relations: [
          ...(targetTerm.relations || []),
          { target: saved.id, label: '关联上下游概念' },
        ],
      };
      await lexiconStore.saveTermAsync(
        updatedTarget,
        `自动补齐与新词条【${saved.title}】的反向血缘关联`,
        operator,
        targetTerm.meta?.revision
      );
    }
  }

  trace.push({
    tool: 'pg_save_term_draft',
    summary: `已原子写入 PostgreSQL (status=DRAFT, grounded=${grounded}, pointers=${synthesizedPointers.length}, revision=${saved.meta?.revision || 1})`,
  });

  return { term: saved, trace, grounded, hitCount: hits.length };
}

/**
 * 测试 AI Provider 连通性（支持表单实时传入或复用库内已加密保存的 Key）
 */
export async function testAiProviderConnection(input: {
  protocol?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<{
  ok: boolean;
  latencyMs: number;
  model: string;
  reply?: string;
  error?: string;
}> {
  const savedCfg = await lexiconStore.getServerAiConfig();
  const protocol =
    input.protocol === 'anthropic-messages'
      ? 'anthropic-messages'
      : savedCfg.protocol || 'openai-compatible';
  const rawBaseUrl = String(input.baseUrl || savedCfg.baseUrl || 'https://api.deepseek.com').trim();
  const safeBaseUrl = validateAllowedLlmBaseUrl(rawBaseUrl);
  const model = String(input.model || savedCfg.model || 'deepseek-chat').trim();
  const effectiveKey = String(input.apiKey || '').trim() || savedCfg.apiKey;

  if (!effectiveKey) {
    return {
      ok: false,
      latencyMs: 0,
      model,
      error: '尚未填写 API Key（请在输入框填入 Key 后再点击测试连接）',
    };
  }

  const startMs = Date.now();
  try {
    if (protocol === 'anthropic-messages') {
      const endpoint = safeBaseUrl.endsWith('/v1')
        ? `${safeBaseUrl}/messages`
        : `${safeBaseUrl}/v1/messages`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': effectiveKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
        }),
      });
      const latencyMs = Date.now() - startMs;
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          model,
          error: data?.error?.message || `HTTP ${res.status}`,
        };
      }
      return {
        ok: true,
        latencyMs,
        model,
        reply: String(data?.content?.[0]?.text || 'OK').trim(),
      };
    } else {
      const endpoint = safeBaseUrl.endsWith('/v1')
        ? `${safeBaseUrl}/chat/completions`
        : `${safeBaseUrl}/v1/chat/completions`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${effectiveKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
        }),
      });
      const latencyMs = Date.now() - startMs;
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          model,
          error: data?.error?.message || `HTTP ${res.status}`,
        };
      }
      return {
        ok: true,
        latencyMs,
        model,
        reply: String(data?.choices?.[0]?.message?.content || 'OK').trim(),
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Date.now() - startMs,
      model,
      error: err?.message || '网络连接失败',
    };
  }
}

export {
  decodeJargonParagraph,
  inferAdvisorSkill,
  extractChineseDomainPhrases,
  type AdvisorSkillId,
  type AdvisorEnginePreference,
  type DecodeJargonInput,
  type DecodeJargonResult,
} from './advisor-skills.js';

