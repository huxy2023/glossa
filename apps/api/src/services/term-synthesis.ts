import crypto from 'node:crypto';
import type { AgentTraceStep, TermEntry } from '@glossa/schema';
import { grepPrdCode, readPrdFile } from './codebase-probe.js';
import { lexiconStore } from './lexicon-store.js';
import { validateAllowedLlmBaseUrl } from './agent-harness.js';

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
  const slug =
    options?.preferredId?.trim() ||
    `term-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

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

  if (hits.length === 0 && options?.contextSnippet) {
    const codeTokens =
      options.contextSnippet.match(
        /[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+/g
      ) || [];
    for (const token of codeTokens.slice(0, 2)) {
      const subHits = await grepPrdCode(token, undefined, 6);
      if (subHits.length > 0) {
        hits = subHits;
        trace.push({
          tool: 'grep_prd_code',
          summary: `结合划词上下文标识符 "${token}" 关联检索 -> 命中 ${subHits.length} 处真实代码`,
        });
        break;
      }
    }
  }

  if (hits.length === 0 && cleanTitle.length >= 5) {
    const stripped = cleanTitle
      .replace(/(?:变更免审批规则|免审批规则|变更审批|管理规则|核算规则|判定规则|执行标准|处理流程|管理办法|业务规则|规则|机制|体系)$/g, '')
      .trim();
    if (
      stripped.length >= 4 &&
      stripped !== cleanTitle &&
      /^[\u4e00-\u9fa5]+$/.test(stripped)
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

  // 将命中的前 3 处真实源码片段自动同步至 PostgreSQL lexicon_code_snapshots
  const codeEvidenceNotes: string[] = [];
  for (const h of hits.slice(0, 3)) {
    const slice = await readPrdFile({
      repo: h.repo,
      filePath: h.path,
      lines: `L${Math.max(1, h.line - 8)}-L${h.line + 20}`,
      commit: h.commit,
    });
    if (slice && slice.content) {
      await lexiconStore.upsertCodeSnapshot({
        repo: slice.repo,
        branch: slice.branch,
        commitSha: slice.resolvedCommit,
        filePath: slice.path,
        lineRange: `L${slice.startLine}-L${slice.endLine}`,
        content: slice.content,
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
  }

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

  if (aiCfg.hasKey && aiCfg.apiKey) {
    try {
      const safeBaseUrl = validateAllowedLlmBaseUrl(aiCfg.baseUrl);
      trace.push({
        tool: 'llm_draft_synthesis',
        summary: `调用 ${aiCfg.model} 提炼【${cleanTitle}】结构化业务词条草稿`,
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
                  ? '请基于给定的业务上下文与源码规则摘要，输出 JSON 格式的【端到端业务流程攻略 (ASOP Playbook)】草稿：{"analogy":"一句通俗生活比喻","plain":"一句端到端全链路主线概述","markdown":"Markdown格式的端到端业务流程攻略，包含：1. 全链路流转图（使用 ```mermaid\\nflowchart LR\\nA[阶段1] --> B[阶段2]\\n``` 语法）；2. 关键节点准入与状态拆解表格；3. 常见业务卡单排障指南（纯业务语言，严禁出现代码类名、数据库表名、Git哈希或Emoji）"}。'
                  : '请基于给定的业务上下文与源码规则摘要，输出 JSON 格式词条草稿：{"analogy":"一句通俗生活比喻","plain":"一句业务大白话定义","markdown":"Markdown格式的清晰业务解析（包含通俗本质引用块、核心规则拆解表格、角色职责与业务影响说明，纯业务语言，严禁出现代码类名、数据库表名、Git哈希或Emoji）"}。',
            },
            {
              role: 'user',
              content: [
                `词条名称：${cleanTitle}`,
                rawAdopted ? `已验证的伴读解释：${rawAdopted}` : '',
                options?.contextSnippet ? `来源上下文：${options.contextSnippet}` : '',
                hits.length > 0
                  ? `真实代码考据命中摘要（共 ${hits.length} 处，请转化为纯业务规则描述，切勿暴露文件名或表名）：\n${JSON.stringify(
                      hits.slice(0, 5).map((h) => ({
                        repo: h.repo,
                        snippet: h.snippet,
                      }))
                    )}`
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
        }
      }
    } catch {
      // Keep clean business draft if LLM call fails
    }
  }

  // 仅当存在真实源码考据命中或显式授信/模板确认时方可视为已核实 (grounded=true)；纯模型凭未核实上下文合成的草稿必须保留为 DRAFT 待审
  const grounded = Boolean(hits.length > 0 || options?.isGroundedOverride);

  const defaultCategory =
    options?.category ||
    lexiconStore
      .getCategories()
      .find((c) => c.id !== 'asop' && cleanTitle.includes(c.name.slice(0, 2)))?.id ||
    lexiconStore.getCategories().find((c) => c.id !== 'asop')?.id ||
    'core';

  const newTerm: TermEntry = {
    id: slug,
    title: cleanTitle,
    subtitle: '业务词条 · 核心概念与协同口径解析',
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
      repos: [],
      pointers: [],
      dataMappings: [],
    },
    relations: options?.sourceTermId
      ? [{ target: options.sourceTermId, label: '关联业务来源' }]
      : [],
    faqs: [
      {
        q: `在实际业务协同中，如何理解【${cleanTitle}】的定位与作用？`,
        a: `${generatedPlain} 在跨岗位配合时，建议结合上下游关联词条核对准入条件与流转状态。`,
      },
    ],
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
      summary: `已在内存构建候选词条草稿 (grounded=${grounded})，交由候选决议器执行跨进程原子抢占落库`,
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
  trace.push({
    tool: 'pg_save_term_draft',
    summary: `已原子写入 PostgreSQL (status=DRAFT, grounded=${grounded}, revision=${saved.meta?.revision || 1})`,
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

