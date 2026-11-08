import type { AgentTraceStep } from '@glossa/schema';
import {
  grepPrdCode,
  readPrdFile,
  inspectTermsDrift,
} from './codebase-probe.js';
import { lexiconStore } from './lexicon-store.js';

export {
  generateTermWithHarness,
  testAiProviderConnection,
  decodeJargonParagraph,
  type DecodeJargonResult,
} from './term-synthesis.js';

export {
  extractTextSproutCandidates,
  dissectTermSproutsWithHarness,
  expandCandidateWithHarness,
  runSproutWaveWithHarness,
  type DissectSproutInputItem,
} from './sprout-engine.js';

export interface AgentAskRequest {
  sessionId?: string;
  userId?: string;
  question: string;
  activeTermId?: string;
  selectedText?: string;
}

export interface AgentAskResponse {
  sessionId: string;
  answer: string;
  trace: AgentTraceStep[];
  referencedCommits: Array<{ repo: string; branch: string; commit: string; path: string }>;
  mode: 'llm-tool-loop' | 'code-search-only-no-key' | 'llm-error';
}

const ALLOWED_LLM_HOSTS = new Set([
  'api.deepseek.com',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'dashscope.aliyuncs.com',
  'ark.cn-beijing.volces.com',
  'api.moonshot.cn',
  'open.bigmodel.cn',
  'generativelanguage.googleapis.com',
]);

/**
 * 严格校验 LLM Base URL 白名单，彻底阻断通过自定义 baseUrl 窃取服务端 API Key 或触发内网 SSRF
 */
export function validateAllowedLlmBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('无效的 AI Base URL 格式');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('安全策略拦截：AI Base URL 必须使用 HTTPS 协议');
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_LLM_HOSTS.has(host)) {
    throw new Error(
      `安全策略拦截：域名 ${host} 不在受控大模型白名单内（允许：${Array.from(ALLOWED_LLM_HOSTS).join(', ')}）`
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'grep_prd_code',
      description: '在项目生产分支源码索引中搜索关键词、类名、方法名或字段名',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的代码标识符或业务关键词' },
          repo: { type: 'string', description: '可选：限定子仓库名称' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_prd_file',
      description: '按 repo + commit + path + 行号读取生产分支真实源码片段',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: '仓库名' },
          path: { type: 'string', description: '仓库内相对文件路径' },
          lines: { type: 'string', description: '行号范围，如 L9889-L9915' },
          commit: { type: 'string', description: '可选：指定 Git Commit SHA' },
        },
        required: ['repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_lexicon_db',
      description: '查询 CloudBase PostgreSQL 数据库中的领域词条定义、关系及源码指针',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '词条 ID 或中文名称关键词' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_git_diff',
      description: '检查指定词条或全站词条的源码指针与当前 origin/prd HEAD 是否存在 Commit 漂移',
      parameters: {
        type: 'object',
        properties: {
          termId: { type: 'string', description: '可选：词条 ID' },
        },
      },
    },
  },
];

async function executeHarnessTool(
  name: string,
  args: Record<string, any>,
  trace: AgentTraceStep[],
  referencedCommits: Array<{ repo: string; branch: string; commit: string; path: string }>
): Promise<string> {
  if (name === 'grep_prd_code') {
    const q = String(args.query || '').trim();
    const repo = args.repo ? String(args.repo).trim() : undefined;
    const hits = await grepPrdCode(q, repo, 6);
    trace.push({
      tool: 'grep_prd_code',
      summary: `检索生产代码 "${q}"${repo ? ` (${repo})` : ''} -> 命中 ${hits.length} 处`,
      detail: hits.map((h) => `${h.repo}@${h.commit}:${h.path}#L${h.line}`).join('\n'),
    });
    for (const h of hits.slice(0, 3)) {
      if (!referencedCommits.some((r) => r.repo === h.repo && r.path === h.path)) {
        referencedCommits.push({
          repo: h.repo,
          branch: h.branch,
          commit: h.commit,
          path: `${h.path}#L${h.line}`,
        });
      }
    }
    return JSON.stringify({ query: q, hitCount: hits.length, hits });
  }

  if (name === 'read_prd_file') {
    const repo = String(args.repo || '');
    const filePath = String(args.path || '');
    const lines = args.lines ? String(args.lines) : undefined;
    const commit = args.commit ? String(args.commit) : undefined;
    const res = await readPrdFile({ repo, filePath, lines, commit });
    trace.push({
      tool: 'read_prd_file',
      summary: res
        ? `读取源码 ${repo}@${res.resolvedCommit}:${res.path} (L${res.startLine}-L${res.endLine})`
        : `读取源码未命中 ${repo}:${filePath}`,
    });
    if (!res) {
      return JSON.stringify({ error: '未找到指定仓库/Commit 下的源码文件或路径越界被拒绝' });
    }
    if (!referencedCommits.some((r) => r.repo === res.repo && r.path.startsWith(res.path))) {
      referencedCommits.push({
        repo: res.repo,
        branch: res.branch,
        commit: res.resolvedCommit,
        path: `${res.path}#L${res.startLine}-L${res.endLine}`,
      });
    }
    return JSON.stringify(res);
  }

  if (name === 'query_lexicon_db') {
    const kw = String(args.keyword || '').trim().toLowerCase();
    const allTerms = await lexiconStore.getTermsAsync();
    const matched = allTerms
      .filter(
        (t) =>
          t.id.toLowerCase().includes(kw) ||
          t.title.toLowerCase().includes(kw) ||
          t.summary.toLowerCase().includes(kw)
      )
      .slice(0, 4);
    trace.push({
      tool: 'query_lexicon_db',
      summary: `查询 PostgreSQL 词条库 "${args.keyword}" -> 匹配 ${matched.length} 条记录`,
    });
    for (const m of matched) {
      for (const p of (m.engineering?.pointers || []).slice(0, 2)) {
        if (!referencedCommits.some((r) => r.repo === p.repo && r.path === p.path)) {
          referencedCommits.push({
            repo: p.repo,
            branch: p.branch,
            commit: p.commit,
            path: p.path,
          });
        }
      }
    }
    return JSON.stringify(
      matched.map((t) => ({
        id: t.id,
        title: t.title,
        revision: t.meta?.revision || 1,
        summary: t.summary,
        layman: t.layman,
        pointers: t.engineering?.pointers || [],
        dataMappings: t.engineering?.dataMappings || [],
      }))
    );
  }

  if (name === 'inspect_git_diff') {
    const allTerms = await lexiconStore.getTermsAsync();
    const targetTerms = args.termId
      ? allTerms.filter((t) => t.id === args.termId)
      : allTerms;
    const report = await inspectTermsDrift(targetTerms);
    trace.push({
      tool: 'inspect_git_diff',
      summary: `执行 Commit 漂移检查 (${report.totalPointers} 条指针: 同步=${report.syncedCount}, 漂移=${report.driftedCount}, 异常=${report.errorCount})`,
    });
    return JSON.stringify(report);
  }

  return JSON.stringify({ error: `未知工具: ${name}` });
}

/**
 * 过滤 DeepSeek V3.2 内部工具调用标记（如 <｜DSML｜calls>...），防止内部 XML 泄露至前端气泡或落库
 */
export function stripDsmlMarkup(text: string): string {
  return String(text || '')
    .replace(
      /<(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+(?:function_)?calls>[\s\S]*?<\/(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+(?:function_)?calls>/gi,
      ''
    )
    .replace(
      /<(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+invoke\b[^>]*>[\s\S]*?<\/(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+invoke>/gi,
      ''
    )
    .replace(/<\/?(?:\s*[｜|]\s*)+DSML[^>]*>/gi, '')
    .replace(/<(?:\s*[｜|]\s*)+DSML[\s\S]*$/gi, '')
    .trim();
}

/**
 * 解析 DeepSeek V3.2 在 content 中直接输出的 <｜DSML｜calls><｜DSML｜invoke name="...">... 标记为标准 OpenAI tool_calls
 */
export function extractDsmlToolCalls(content: string): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  const raw = String(content || '');
  if (!/DSML/i.test(raw)) return [];
  const calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  const invokeRegex =
    /<(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+invoke>/gi;
  let invMatch: RegExpExecArray | null;
  let idx = 0;
  while ((invMatch = invokeRegex.exec(raw)) !== null) {
    const fnName = invMatch[1].trim();
    const body = invMatch[2] || '';
    const args: Record<string, any> = {};
    const paramRegex =
      /<(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      args[pMatch[1].trim()] = pMatch[2].trim();
    }
    calls.push({
      id: `dsml_call_${Date.now()}_${idx++}`,
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }
  return calls;
}

/**
 * 真实 Multi-Turn Tool-Calling Agent 伴读循环
 * - 统一使用 PostgreSQL (lexicon_ai_configs) 中保存的受控 Provider 与加密 API Key；
 * - 加载同一 sessionId 的历史消息实现真正的多轮对话（严格校验当前用户会话归属，倒序取最近消息）；
 * - 若已配置 API Key：执行最多 3 轮 Tool-Calling 检索 + 1 轮纯 Markdown 汇总（同时兼容标准 tool_calls 与 DeepSeek DSML 标记）；
 * - 若尚未配置 API Key：真实执行代码与数据库检索工具，并明确标记为 `code-search-only-no-key`，绝不伪造大模型回答。
 */
export async function runAgentAsk(req: AgentAskRequest): Promise<AgentAskResponse> {
  const sessionId = req.sessionId || `sess_${Date.now()}`;
  const trace: AgentTraceStep[] = [];
  const referencedCommits: Array<{ repo: string; branch: string; commit: string; path: string }> = [];

  const aiCfg = await lexiconStore.getServerAiConfig();
  const activeTerm = req.activeTermId
    ? await lexiconStore.getTermByIdAsync(req.activeTermId)
    : undefined;
  const history = await lexiconStore.getChatMessages(sessionId, 8, req.userId);

  // 1. 先对当前词条与用户问题执行一次基础实证检索，确保即便无 Key 也有真实代码证据
  if (activeTerm) {
    await executeHarnessTool(
      'query_lexicon_db',
      { keyword: activeTerm.id },
      trace,
      referencedCommits
    );
  }

  const tokenMatches = req.question.match(/[A-Za-z_][A-Za-z0-9_]{3,}|[\u4e00-\u9fa5]{2,6}/g) || [];
  const searchKw =
    tokenMatches.find((w) => !['为什么', '什么意思', '怎么理解', '区别是什么', '有哪些'].includes(w)) ||
    activeTerm?.title ||
    'isFeeTerminalByCode';

  const rawSearchJson = await executeHarnessTool(
    'grep_prd_code',
    { query: searchKw },
    trace,
    referencedCommits
  );

  // 2. 若已配置真实 API Key，启动标准 OpenAI-Compatible Multi-Turn Tool-Calling 循环
  if (aiCfg.hasKey && aiCfg.apiKey) {
    try {
      const safeBaseUrl = validateAllowedLlmBaseUrl(aiCfg.baseUrl);
      const systemPrompt = [
        '你是 Glossa 领域百科与真实代码事实工作台的 AI 伴读专家。',
        process.env.GLOSSA_DOMAIN_CONTEXT
          ? `当前项目领域背景：${process.env.GLOSSA_DOMAIN_CONTEXT}`
          : '',
        '铁律：',
        '1. 你的所有回答必须严格基于工具从代码库及 PostgreSQL 词条库中查出的真实业务与代码事实，严禁引用过时文档或主观臆造。',
        '2. 你可以调用 grep_prd_code、read_prd_file、query_lexicon_db、inspect_git_diff 工具获取进一步代码证据。',
        '3. 请使用结构清晰的 Markdown 格式（### 小标题、项目符号列表、**重点加粗**、行内 `字段名`）：先用通俗大白话直击业务本质与实操排障步骤，再简要说明底层核心表名/字段判定逻辑；非用户主动追问，不要在正文中堆砌冗长的 Git Commit SHA，也绝不要在正文中输出 <｜DSML｜...> 标签。',
        activeTerm
          ? `当前用户正在阅读词条：【${activeTerm.title} (${activeTerm.id})】，简介：${activeTerm.summary}`
          : '',
        req.selectedText ? `用户划选的正文片段：「${req.selectedText}」` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...history
          .map((m) => ({
            role: m.role,
            content: stripDsmlMarkup(m.content),
          }))
          .filter((m) => m.content),
        {
          role: 'user',
          content: `${req.question}\n\n[初始预检索上下文]: ${rawSearchJson}`,
        },
      ];

      let finalAnswer = '';

      for (let round = 1; round <= 4; round++) {
        const isFinalSynthesisRound = round === 4;
        trace.push({
          tool: 'llm_reasoning_round',
          summary: isFinalSynthesisRound
            ? `调用大模型 ${aiCfg.model} (汇总证据生成最终 Markdown 回答)`
            : `调用大模型 ${aiCfg.model} (第 ${round} 轮 Tool-Calling 推理)`,
        });

        const requestMessages = isFinalSynthesisRound
          ? [
              ...messages,
              {
                role: 'user',
                content:
                  '[系统指令：代码与词典检索阶段已完成。请勿再调用任何工具或输出 DSML 标签，直接基于上述已获取的词条与源码证据，用结构化 Markdown 回答用户问题。]',
              },
            ]
          : messages;

        const reqBody: Record<string, any> = {
          model: aiCfg.model || 'deepseek-chat',
          messages: requestMessages,
          temperature: 0.2,
        };
        if (!isFinalSynthesisRound) {
          reqBody.tools = OPENAI_TOOLS;
          reqBody.tool_choice = 'auto';
        }

        const res = await fetch(`${safeBaseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${aiCfg.apiKey}`,
          },
          signal: AbortSignal.timeout(28000),
          body: JSON.stringify(reqBody),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`大模型 HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data: any = await res.json();
        const choice = data?.choices?.[0]?.message;
        if (!choice) {
          throw new Error('大模型返回格式异常（缺少 choices[0].message）');
        }

        // 兼容标准 tool_calls 与 DeepSeek V3.2 在 content 中输出的 <｜DSML｜calls>
        const dsmlCalls =
          !Array.isArray(choice.tool_calls) || choice.tool_calls.length === 0
            ? extractDsmlToolCalls(choice.content || '')
            : [];
        const effectiveToolCalls =
          Array.isArray(choice.tool_calls) && choice.tool_calls.length > 0
            ? choice.tool_calls
            : dsmlCalls;

        if (!isFinalSynthesisRound && effectiveToolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: stripDsmlMarkup(choice.content || '') || null,
            tool_calls: effectiveToolCalls,
          });
          for (const tc of effectiveToolCalls) {
            const fnName = tc.function?.name || '';
            let fnArgs: Record<string, any> = {};
            try {
              fnArgs = JSON.parse(tc.function?.arguments || '{}');
            } catch {
              fnArgs = {};
            }
            const toolResultStr = await executeHarnessTool(
              fnName,
              fnArgs,
              trace,
              referencedCommits
            );
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolResultStr,
            });
          }
          continue;
        }

        finalAnswer = stripDsmlMarkup(String(choice.content || ''));
        if (finalAnswer) {
          break;
        }
      }

      if (finalAnswer) {
        await lexiconStore.saveChatTurn({
          sessionId,
          userId: req.userId || 'admin',
          activeTermId: req.activeTermId,
          question: req.question,
          answer: finalAnswer,
          trace,
          referencedCommits: referencedCommits.map((r) => `${r.repo}@${r.commit}:${r.path}`),
          mode: 'llm-tool-loop',
        });

        return {
          sessionId,
          answer: finalAnswer,
          trace,
          referencedCommits,
          mode: 'llm-tool-loop',
        };
      }
    } catch (err: any) {
      const errorAnswer = [
        `⚠️ **大模型调用未成功（未伪造回答）**：${err?.message || '未知错误'}`,
        '',
        '以下为后端探针从 `.codebase-prd` / PostgreSQL 实证索引中真实检索到的代码坐标供直接参考：',
        ...referencedCommits.map((r) => `- \`${r.repo}\` (\`${r.branch}@${r.commit}\`) -> \`${r.path}\``),
      ].join('\n');

      await lexiconStore.saveChatTurn({
        sessionId,
        userId: req.userId || 'admin',
        activeTermId: req.activeTermId,
        question: req.question,
        answer: errorAnswer,
        trace,
        referencedCommits: referencedCommits.map((r) => `${r.repo}@${r.commit}:${r.path}`),
        mode: 'llm-error',
      });

      return {
        sessionId,
        answer: errorAnswer,
        trace,
        referencedCommits,
        mode: 'llm-error',
      };
    }
  }

  // 3. 当尚未在数据库配置 API Key 时：如实展示真实检索到的词条与源码结果，绝不冒充大模型生成
  const honestNoKeyAnswer = [
    `**[当前模式：词典直查模式（尚未配置大模型 API Key）]**`,
    `> 如需启用 DeepSeek / OpenAI 智能问答，请点击右上角 **「AI 配置」** 保存 API Key。`,
    '',
    activeTerm
      ? `### 1. 当前词条【${activeTerm.title}】业务摘要 (v${activeTerm.meta?.revision || 1})\n- **一句话定义**：${activeTerm.summary}\n- **通俗比喻**：${activeTerm.layman.analogy}\n- **业务规则**：${activeTerm.layman.plain}`
      : `### 1. 针对问题「${req.question}」的词典检索结果`,
  ].join('\n');

  await lexiconStore.saveChatTurn({
    sessionId,
    userId: req.userId || 'admin',
    activeTermId: req.activeTermId,
    question: req.question,
    answer: honestNoKeyAnswer,
    trace,
    referencedCommits: referencedCommits.map((r) => `${r.repo}@${r.commit}:${r.path}`),
    mode: 'code-search-only-no-key',
  });

  return {
    sessionId,
    answer: honestNoKeyAnswer,
    trace,
    referencedCommits,
    mode: 'code-search-only-no-key',
  };
}

/**
 * 真实流式 SSE Agent 伴读引擎（实时推送工具检索状态 + DeepSeek 逐字流式 Markdown 渲染）
 */
export async function streamAgentAsk(
  req: AgentAskRequest,
  emit: (event: 'status' | 'delta' | 'done' | 'error', payload: any) => Promise<void> | void
): Promise<void> {
  const sessionId = req.sessionId || `sess_${Date.now()}`;
  const trace: AgentTraceStep[] = [];
  const referencedCommits: Array<{ repo: string; branch: string; commit: string; path: string }> = [];

  await emit('status', {
    text: '正在检索领域词典与业务规则...',
    trace,
  });

  const aiCfg = await lexiconStore.getServerAiConfig();
  const activeTerm = req.activeTermId
    ? await lexiconStore.getTermByIdAsync(req.activeTermId)
    : undefined;
  const history = await lexiconStore.getChatMessages(sessionId, 8, req.userId);

  if (activeTerm) {
    await executeHarnessTool(
      'query_lexicon_db',
      { keyword: activeTerm.id },
      trace,
      referencedCommits
    );
  }

  const tokenMatches = req.question.match(/[A-Za-z_][A-Za-z0-9_]{3,}|[\u4e00-\u9fa5]{2,6}/g) || [];
  const searchKw =
    tokenMatches.find((w) => !['为什么', '什么意思', '怎么理解', '区别是什么', '有哪些'].includes(w)) ||
    activeTerm?.title ||
    'isFeeTerminalByCode';

  const rawSearchJson = await executeHarnessTool(
    'grep_prd_code',
    { query: searchKw },
    trace,
    referencedCommits
  );

  if (!aiCfg.hasKey || !aiCfg.apiKey) {
    const fallbackRes = await runAgentAsk(req);
    await emit('delta', { delta: fallbackRes.answer });
    await emit('done', fallbackRes);
    return;
  }

  try {
    const safeBaseUrl = validateAllowedLlmBaseUrl(aiCfg.baseUrl);
    const systemPrompt = [
      '你是 Glossa 领域百科与业务流程指南的 AI 伴读专家，服务对象为业务新人、产品经理与运营人员。',
      process.env.GLOSSA_DOMAIN_CONTEXT
        ? `当前项目领域背景：${process.env.GLOSSA_DOMAIN_CONTEXT}`
        : '',
      '铁律：',
      '1. 你的所有回答必须严格基于词条库与系统真实业务规则，严禁主观臆造。',
      '2. 请使用结构清晰的 Markdown 格式（### 小标题、项目符号列表、**重点加粗**）：用通俗大白话讲透业务本质、角色职责分工、上下游流转逻辑与实操排障步骤；不要输出冗长的代码类名、物理表名、Git Commit SHA、Emoji 表情符号或 <｜DSML｜...> 标签。',
      activeTerm
        ? `当前用户正在阅读词条：【${activeTerm.title} (${activeTerm.id})】，简介：${activeTerm.summary}`
        : '',
      req.selectedText ? `用户划选的正文片段：「${req.selectedText}」` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      ...history
        .map((m) => ({
          role: m.role,
          content: stripDsmlMarkup(m.content),
        }))
        .filter((m) => m.content),
      {
        role: 'user',
        content: `${req.question}\n\n[初始预检索上下文]: ${rawSearchJson}`,
      },
    ];

    let finalAnswer = '';

    // 阶段 1：最多 2 轮快速工具检索探针（若大模型直接回答则立即流式吐出）
    for (let round = 1; round <= 2; round++) {
      await emit('status', {
        text: `🧠 DeepSeek 正在分析问题并规划代码考据 (第 ${round} 轮)...`,
        trace,
      });

      trace.push({
        tool: 'llm_reasoning_round',
        summary: `调用大模型 ${aiCfg.model} (第 ${round} 轮 Tool-Calling 推理)`,
      });

      const res = await fetch(`${safeBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiCfg.apiKey}`,
        },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          model: aiCfg.model || 'deepseek-chat',
          messages,
          tools: OPENAI_TOOLS,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`大模型 HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data: any = await res.json();
      const choice = data?.choices?.[0]?.message;
      if (!choice) {
        throw new Error('大模型返回格式异常（缺少 choices[0].message）');
      }

      const dsmlCalls =
        !Array.isArray(choice.tool_calls) || choice.tool_calls.length === 0
          ? extractDsmlToolCalls(choice.content || '')
          : [];
      const effectiveToolCalls =
        Array.isArray(choice.tool_calls) && choice.tool_calls.length > 0
          ? choice.tool_calls
          : dsmlCalls;

      if (effectiveToolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: stripDsmlMarkup(choice.content || '') || null,
          tool_calls: effectiveToolCalls,
        });

        for (const tc of effectiveToolCalls) {
          const fnName = tc.function?.name || '';
          let fnArgs: Record<string, any> = {};
          try {
            fnArgs = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            fnArgs = {};
          }
          const shortTarget =
            fnArgs.path?.split('/').pop() || fnArgs.query || fnArgs.keyword || fnArgs.repo || '';
          await emit('status', {
            text: `🧬 正在执行工具 [${fnName}]：${shortTarget}...`,
            trace,
          });
          const toolResultStr = await executeHarnessTool(
            fnName,
            fnArgs,
            trace,
            referencedCommits
          );
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolResultStr,
          });
        }
        continue;
      }

      const directText = stripDsmlMarkup(String(choice.content || ''));
      if (directText) {
        finalAnswer = directText;
        // 分块平滑推送给前端
        const chunkSize = 24;
        for (let i = 0; i < finalAnswer.length; i += chunkSize) {
          await emit('delta', { delta: finalAnswer.slice(i, i + chunkSize) });
        }
        break;
      }
    }

    // 阶段 2：若前 2 轮都在调工具，则发起不带 tools 的原生 SSE 流式生成请求（100% 杜绝 DSML 泄露，且真实逐 token 流式渲染）
    if (!finalAnswer) {
      await emit('status', {
        text: '✍️ 已完成源码与词条取证，正在流式生成解答...',
        trace,
      });

      trace.push({
        tool: 'llm_streaming_synthesis',
        summary: `流式调用 ${aiCfg.model} 生成最终 Markdown 解答`,
      });

      const streamMessages = [
        ...messages,
        {
          role: 'user',
          content:
            '[系统指令：代码与词典检索阶段已完成。请勿再调用任何工具或输出 DSML 标签，直接基于上述已获取的词条与源码证据，用结构化 Markdown 回答用户问题。]',
        },
      ];

      const streamRes = await fetch(`${safeBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiCfg.apiKey}`,
        },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: aiCfg.model || 'deepseek-chat',
          messages: streamMessages,
          temperature: 0.2,
          stream: true,
        }),
      });

      if (!streamRes.ok || !streamRes.body) {
        const errText = await streamRes.text();
        throw new Error(`流式生成 HTTP ${streamRes.status}: ${errText.slice(0, 200)}`);
      }

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let rawAccumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payloadStr = line.slice(5).trim();
          if (!payloadStr || payloadStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payloadStr);
            const deltaContent = parsed?.choices?.[0]?.delta?.content;
            if (typeof deltaContent === 'string' && deltaContent.length > 0) {
              rawAccumulated += deltaContent;
              // 若出现 DSML 起始标签则立即截断不向外推送
              if (!/<(?:\s*[｜|]\s*)+DSML/i.test(rawAccumulated)) {
                await emit('delta', { delta: deltaContent });
              }
            }
          } catch {}
        }
      }

      finalAnswer = stripDsmlMarkup(rawAccumulated);
    }

    if (!finalAnswer) {
      throw new Error('模型未返回有效文本内容');
    }

    await lexiconStore.saveChatTurn({
      sessionId,
      userId: req.userId || 'admin',
      activeTermId: req.activeTermId,
      question: req.question,
      answer: finalAnswer,
      trace,
      referencedCommits: referencedCommits.map((r) => `${r.repo}@${r.commit}:${r.path}`),
      mode: 'llm-tool-loop',
    });

    await emit('done', {
      sessionId,
      answer: finalAnswer,
      trace,
      referencedCommits,
      mode: 'llm-tool-loop',
    });
  } catch (err: any) {
    const errorAnswer = [
      `⚠️ **大模型调用未成功（未伪造回答）**：${err?.message || '未知错误'}`,
      '',
      '以下为后端探针从 `.codebase-prd` / PostgreSQL 实证索引中真实检索到的代码坐标供直接参考：',
      ...referencedCommits.map((r) => `- \`${r.repo}\` (\`${r.branch}@${r.commit}\`) -> \`${r.path}\``),
    ].join('\n');

    await lexiconStore.saveChatTurn({
      sessionId,
      userId: req.userId || 'admin',
      activeTermId: req.activeTermId,
      question: req.question,
      answer: errorAnswer,
      trace,
      referencedCommits: referencedCommits.map((r) => `${r.repo}@${r.commit}:${r.path}`),
      mode: 'llm-error',
    });

    await emit('error', {
      sessionId,
      answer: errorAnswer,
      trace,
      referencedCommits,
      mode: 'llm-error',
      error: err?.message || '未知错误',
    });
  }
}
