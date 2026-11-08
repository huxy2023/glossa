import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TermEntry } from '@glossa/schema';
import {
  CODEBASE_PRD_ROOT,
  grepPrdCode,
  readPrdFile,
  type CodeSearchHit,
} from './codebase-probe.js';
import { lexiconStore } from './lexicon-store.js';
import { validateAllowedLlmBaseUrl } from './agent-harness.js';

export type AdvisorSkillId =
  | 'troubleshooting'
  | 'solution-design'
  | 'metrics-analytics'
  | 'jargon-demystify';

export type AdvisorEnginePreference = 'auto' | 'codex-cli' | 'llm-api';

export interface AdvisorHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  skillId?: string;
}

export interface DecodeJargonInput {
  text: string;
  userId?: string;
  sessionId?: string;
  history?: AdvisorHistoryTurn[];
  skillId?: AdvisorSkillId;
  enginePreference?: AdvisorEnginePreference;
  allowWorkerDelegation?: boolean;
}

export interface DecodeJargonResult {
  matchedTerms: Array<{
    id: string;
    title: string;
    category: string;
    matchedPhrase: string;
    analogy: string;
    plain: string;
  }>;
  matchedFields: Array<{
    termId: string;
    termTitle: string;
    db: string;
    table: string;
    field: string;
    rule: string;
  }>;
  codeHits: Array<{
    repo: string;
    branch: string;
    commit: string;
    path: string;
    line: number;
    snippet: string;
  }>;
  suggestedNewTerms: string[];
  translationMarkdown: string;
  mode: 'codex-cli' | 'worker-codex' | 'llm-decoded' | 'lexicon-rule-only';
  skillId: AdvisorSkillId;
  durationMs: number;
  traceSteps: Array<{
    tool: string;
    summary: string;
  }>;
  lexiconStats?: {
    totalTerms: number;
    asopCount: number;
    totalFaqs: number;
    categoryBreakdown: Record<string, number>;
  };
}

const STOP_SPLIT_RE =
  /[，。！？；：、“”‘’"'\(\)（）【】\[\]\s,.;:!?/\\|+=-]+|(?:虽然|但是|而且|因为|所以|如果|以及|或者|可以|不能|无法|没有|看不到|不显示|为什么|怎么|如何|什么|我们|你们|他们|想要|需要|正在|已经|还是|时候|一下|一个|一些|请问|帮我|分析|排查|看看|的|了|在|是|和|与|或|有|把|被|给|到|去|当|后|前|里|上|下)+/g;

export function inferAdvisorSkill(rawText: string): AdvisorSkillId {
  const t = rawText.trim();
  if (
    /统计|口径|指标|转化率|达标率|覆盖率|分子|分母|报表|计算公式|多少个|汇总分析|全景统计/.test(
      t
    )
  ) {
    return 'metrics-analytics';
  }
  if (
    /需求|方案|怎么做|如何实现|怎么设计|如何支持|改造|新增功能|想要做|想支持|评估影响/.test(
      t
    )
  ) {
    return 'solution-design';
  }
  if (
    /为什么|没有|看不到|不显示|无法|不能|报错|拦截|失败|排障|异常|怎么回事|选不到|置灰|卡住|不出来/.test(
      t
    )
  ) {
    return 'troubleshooting';
  }
  return 'jargon-demystify';
}

export function extractChineseDomainPhrases(
  rawText: string,
  knownTerms: TermEntry[] = []
): string[] {
  const result = new Set<string>();

  for (const term of knownTerms) {
    const candidates = [term.title, ...(term.aliases || [])];
    for (const cand of candidates) {
      const clean = String(cand || '').trim();
      if (clean.length >= 2 && clean.length <= 12 && rawText.includes(clean)) {
        result.add(clean);
      }
    }
  }

  const segments = rawText
    .split(STOP_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);

  for (const seg of segments) {
    if (seg.length <= 7 && /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,7}$/.test(seg)) {
      result.add(seg);
    } else if (seg.length > 7 && /^[\u4e00-\u9fa5]+$/.test(seg)) {
      // 对较长连续中文短语自动提取首尾 2~4 字锚点，提升领域词召回率
      result.add(seg.slice(0, 4));
      result.add(seg.slice(-4));
      result.add(seg.slice(-2));
    }
  }

  return Array.from(result)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function buildSkillSystemPrompt(
  skillId: AdvisorSkillId,
  allTerms: TermEntry[] = []
): string {
  const sampleTitles = allTerms
    .slice(0, 18)
    .map((t) => t.title)
    .join('、');
  const domainContextLine =
    process.env.GLOSSA_DOMAIN_CONTEXT ||
    (sampleTitles
      ? `当前系统核心领域概念包括：${sampleTitles} 等。`
      : '当前系统为企业级业务与数字化协同平台。');

  const commonGuardrails = [
    '你是 Glossa 领域百科与源码实证平台的「首席业务参谋与架构专家」。',
    '【最高实证铁律（严禁幻觉）】：',
    `1. ${domainContextLine}`,
    '2. 严禁脱离给定的【领域词典实证定义】与【真实源码取证片段】，严禁凭空臆造当前系统词典与源码中根本不存在的外部行业概念或虚假状态。',
    '3. 请输出结构清晰、专业笃定的 Markdown 报告，不要使用 Emoji 图标。在解释业务规则时，可自然引用源码中已证实的业务状态或控制逻辑作为实证支撑。',
  ];

  if (skillId === 'troubleshooting') {
    return [
      ...commonGuardrails,
      '',
      '当前激活技能：【现场疑难排障 (Troubleshooting Skill)】',
      '请严格按以下三段式结构输出排障报告：',
      '### 一、问题本质与一句话结论',
      '直接点明该现象在当前系统中的真实原因（明确区分是「页面/列表模式固有展示规则」还是「业务范围过滤 / 准入状态拦截」）。',
      '### 二、核心业务规则与源码实证拆解',
      '结合已命中的领域词条与真实源码片段，用表格或分点逐项拆解涉及的入口模式差异、参数传递与真实状态校验链路。',
      '### 三、现场排障核对清单（按优先级从高到低）',
      '给出一线业务、运营或技术支持可直接按步骤核查的 1-2-3 排查动作。',
    ].join('\n');
  }

  if (skillId === 'solution-design') {
    return [
      ...commonGuardrails,
      '',
      '当前激活技能：【需求方案推演 (Solution Design Skill)】',
      '请严格按以下三段式结构输出方案推演报告：',
      '### 一、需求定位与既有资产复用评估',
      '指出该需求落在哪个业务域，盘点当前词典与代码仓中已有的底座能力、词条模型与端到端流程，明确哪些现成机制可直接复用，避免重复造轮子。',
      '### 二、推荐落地方案与核心流转设计',
      '从「配置/准入层 -> 执行/校验层 -> 核算/审计层」给出最简、高内聚的业务与系统改造方案。',
      '### 三、上下游影响面与边界防坑提醒',
      '逐一列出该改动会波及的关联业务词条、角色权限边界、历史存量数据兼容以及风控注意点。',
    ].join('\n');
  }

  if (skillId === 'metrics-analytics') {
    return [
      ...commonGuardrails,
      '',
      '当前激活技能：【统计口径与数据洞察 (Metrics & Analytics Skill)】',
      '请严格按以下三段式结构输出统计口径分析报告：',
      '### 一、核心统计口径与计算公式',
      '明确所问指标或业务域的标准定义、分子口径、分母口径、统计周期以及知识库资产全景分布。',
      '### 二、异常剔除边界与并表规则',
      '用表格或列表详细说明哪些异常状态或无效单据必须从有效统计或结算中剔除。',
      '### 三、数据核对与报表排查建议',
      '说明实时看板与批处理快照、角色组织管辖范围对统计数字一致性的影响。',
    ].join('\n');
  }

  return [
    ...commonGuardrails,
    '',
    '当前激活技能：【术语与潜台词拆解 (Jargon Demystify Skill)】',
    '请严格按以下三段式结构输出解码报告：',
    '### 一、一句话白话总译（这段话到底在讲什么）',
    '用最接地气的大白话把整段话翻译给刚入职的产品、业务或运营同学听。',
    '### 二、逐项业务术语与潜台词拆解',
    '用列表或表格拆解段落里提到的每个关键概念、角色职责与系统业务管控规则。',
    '### 三、业务注意项与排查提醒',
    '指出这段业务场景在实际操作或需求评审中最容易踩的业务边界。',
  ].join('\n');
}

async function runLocalCodexCliHarness(prompt: string, timeoutMs = 55_000): Promise<{
  markdown: string;
  inspectedFiles: string[];
} | null> {
  if (!fs.existsSync(CODEBASE_PRD_ROOT)) return null;
  const tmpOutFile = path.join(
    os.tmpdir(),
    `glossa_advisor_codex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.md`
  );

  return new Promise((resolve) => {
    let settled = false;
    const inspectedFiles = new Set<string>();

    const child = spawn(
      'codex',
      [
        'exec',
        '-c',
        'mcp_servers={}',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--json',
        '-C',
        CODEBASE_PRD_ROOT,
        '-o',
        tmpOutFile,
        '-',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      }
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        try {
          if (fs.existsSync(tmpOutFile)) fs.unlinkSync(tmpOutFile);
        } catch {}
        resolve(null);
      }
    }, timeoutMs);

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          const cmdStr = JSON.stringify(evt);
          const fileMatches = cmdStr.match(
            /[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+\.(?:kt|java|swift|ts|tsx|vue|js|py|go|rs)/g
          );
          if (fileMatches) {
            for (const fm of fileMatches) inspectedFiles.add(fm);
          }
        } catch {}
      }
    });

    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (fs.existsSync(tmpOutFile)) {
          const md = fs.readFileSync(tmpOutFile, 'utf8').trim();
          fs.unlinkSync(tmpOutFile);
          if (md) {
            resolve({
              markdown: md,
              inspectedFiles: Array.from(inspectedFiles),
            });
            return;
          }
        }
      } catch {}
      resolve(null);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * 业务参谋与多技能智能咨询引擎 (Business Advisor & Skills Harness)
 * 兼容原 /api/agent/decode 与新 /api/agent/consult 契约
 */
export async function decodeJargonParagraph(
  input: DecodeJargonInput
): Promise<DecodeJargonResult> {
  const startTime = Date.now();
  const rawText = String(input.text || '').trim();

  // 解析多轮连续对话历史（支持前端直接透传 history 或按 sessionId 从 PostgreSQL 读取）
  let priorTurns: AdvisorHistoryTurn[] = [];
  if (Array.isArray(input.history) && input.history.length > 0) {
    priorTurns = input.history
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0
      )
      .slice(-10);
  } else if (input.sessionId && input.userId) {
    try {
      const dbMsgs = await lexiconStore.getChatMessages(
        input.sessionId,
        10,
        input.userId
      );
      priorTurns = dbMsgs.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
    } catch {
      priorTurns = [];
    }
  }

  const skillId: AdvisorSkillId = input.skillId || inferAdvisorSkill(rawText);
  const enginePreference: AdvisorEnginePreference = input.enginePreference || 'auto';
  const traceSteps: Array<{ tool: string; summary: string }> = [];

  if (priorTurns.length > 0) {
    traceSteps.push({
      tool: 'session_context_memory',
      summary: `已挂载前序 ${Math.ceil(priorTurns.length / 2)} 轮连续参谋对话上下文`,
    });
  }

  // 若用户显式要求 codex-cli 且当前机器无本地 .codebase-prd，则尝试通过 PostgreSQL 队列派发给内网 Worker 执行
  if (
    enginePreference === 'codex-cli' &&
    !fs.existsSync(CODEBASE_PRD_ROOT) &&
    input.allowWorkerDelegation !== false
  ) {
    try {
      const workerStatus = await lexiconStore.getWorkerStatus();
      if (workerStatus.online && workerStatus.activeWorkers.length > 0) {
        const taskId = await lexiconStore.enqueueWorkerTask(
          'HARNESS_CONSULT',
          {
            text: rawText,
            userId: input.userId,
            sessionId: input.sessionId,
            history: priorTurns,
            skillId,
            enginePreference: 'codex-cli',
          },
          input.userId || 'advisor-client'
        );
        const remoteRes = await lexiconStore.waitForWorkerTask(taskId, 55_000);
        if (remoteRes && remoteRes.translationMarkdown) {
          return {
            ...remoteRes,
            mode: 'worker-codex',
            durationMs: Date.now() - startTime,
          };
        }
      }
    } catch {
      // Fallback to local execution
    }
  }

  const allTerms = await lexiconStore.getTermsAsync();
  const currentPhrases = extractChineseDomainPhrases(rawText, allTerms);
  const historyUserText = priorTurns
    .filter((t) => t.role === 'user')
    .map((t) => t.content)
    .join(' ');
  const historyPhrases = historyUserText
    ? extractChineseDomainPhrases(historyUserText, allTerms)
    : [];
  const domainPhrases = Array.from(new Set([...currentPhrases, ...historyPhrases]));

  // 计算全库统计画像（供 metrics-analytics 技能及全局上下文使用）
  const categoryBreakdown: Record<string, number> = {};
  let totalFaqs = 0;
  let asopCount = 0;
  for (const t of allTerms) {
    categoryBreakdown[t.category] = (categoryBreakdown[t.category] || 0) + 1;
    totalFaqs += (t.faqs || []).length;
    if (t.category === 'asop') asopCount++;
  }
  const lexiconStats = {
    totalTerms: allTerms.length,
    asopCount,
    totalFaqs,
    categoryBreakdown,
  };

  // 1. 多层级语义词条召回（精确包含 + 领域短语拆解打分 + 概念查重器召回）
  const scoredTerms = new Map<
    string,
    { term: TermEntry; score: number; matchedPhrase: string }
  >();

  const recordTermHit = (term: TermEntry, scoreDelta: number, phrase: string) => {
    const existing = scoredTerms.get(term.id);
    if (!existing) {
      scoredTerms.set(term.id, {
        term,
        score: scoreDelta,
        matchedPhrase: phrase,
      });
    } else {
      existing.score += scoreDelta;
      if (phrase.length > existing.matchedPhrase.length) {
        existing.matchedPhrase = phrase;
      }
    }
  };

  const matchedFields: DecodeJargonResult['matchedFields'] = [];

  for (const t of allTerms) {
    const candidates = [t.title, ...(t.aliases || [])].filter((s) => s && s.length >= 2);
    const exactHit = candidates.find((c) =>
      rawText.toLowerCase().includes(c.toLowerCase())
    );
    if (exactHit) {
      recordTermHit(t, 120 + exactHit.length * 5, exactHit);
    }

    for (const phrase of domainPhrases) {
      if (phrase.length < 2) continue;
      const inTitle = t.title.includes(phrase);
      const inAlias = (t.aliases || []).some((a) => a.includes(phrase));
      if (inTitle || inAlias) {
        // 越长的领域短语权重越高（例如 "移动端首页" 5字得 50 分，"门店" 2字得 8 分）
        const weight = phrase.length >= 4 ? phrase.length * 11 : phrase.length >= 3 ? 22 : 7;
        recordTermHit(t, weight, phrase);
      } else if (phrase.length >= 3) {
        if (t.summary.includes(phrase) || t.layman.plain.includes(phrase)) {
          recordTermHit(t, phrase.length * 5, phrase);
        } else if ((t.articleMarkdown || '').includes(phrase)) {
          recordTermHit(t, phrase.length * 3, phrase);
        }
      }
    }

    if (
      skillId === 'metrics-analytics' &&
      /核算|统计|率|口径|达标|看板|剔除|结算/.test(t.title + t.summary)
    ) {
      recordTermHit(t, 18, '统计口径关联');
    }

    for (const dm of t.engineering?.dataMappings || []) {
      const fieldTokens = dm.field
        .split(/[\/,\s()]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3);
      const tableTokens = dm.table
        .split(/[\/,\s()]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4);
      const hitFieldOrTable = [...fieldTokens, ...tableTokens].find((tok) =>
        rawText.toLowerCase().includes(tok.toLowerCase())
      );
      if (hitFieldOrTable) {
        matchedFields.push({
          termId: t.id,
          termTitle: t.title,
          db: dm.db,
          table: dm.table,
          field: dm.field,
          rule: dm.rule,
        });
        recordTermHit(t, 90, hitFieldOrTable);
      }
    }
  }

  // 对核心领域短语执行 lookupConceptAsync 补充同义/近似召回
  for (const phrase of domainPhrases.filter((p) => p.length >= 3).slice(0, 5)) {
    const lookup = await lexiconStore.lookupConceptAsync(phrase);
    if (lookup.exactMatch) {
      const exactTerm = allTerms.find((item) => item.id === lookup.exactMatch?.termId);
      if (exactTerm) {
        recordTermHit(exactTerm, 80, phrase);
      }
    }
    for (const sim of (lookup.similarTerms || []).slice(0, 2)) {
      const fullTerm = allTerms.find((item) => item.id === sim.id);
      if (fullTerm && sim.similarityScore >= 0.45) {
        recordTermHit(fullTerm, Math.round(sim.similarityScore * 45), phrase);
      }
    }
  }

  const rankedTermEntries = Array.from(scoredTerms.values())
    .filter((item) => item.score >= 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const matchedTerms: DecodeJargonResult['matchedTerms'] = rankedTermEntries.map(
    ({ term, matchedPhrase }) => ({
      id: term.id,
      title: term.title,
      category: term.category,
      matchedPhrase,
      analogy: term.layman.analogy,
      plain: term.layman.plain,
    })
  );

  traceSteps.push({
    tool: 'lexicon_semantic_recall',
    summary: `提取领域短语 [${domainPhrases.slice(0, 6).join('、')}] -> 召回 ${matchedTerms.length} 个领域词条与攻略`,
  });

  // 2. 中英文双路源码实证探针（搜索英文标识符 + 核心中文业务短语）
  const englishTokens = Array.from(
    new Set(rawText.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || [])
  );
  const chineseSearchTokens = domainPhrases
    .filter((p) => p.length >= 3 && !['移动端', '客户端', '管理端'].includes(p))
    .slice(0, 4);
  if (chineseSearchTokens.length === 0 && domainPhrases.length > 0) {
    chineseSearchTokens.push(...domainPhrases.slice(0, 2));
  }

  const codeQueries = Array.from(
    new Set([...englishTokens.slice(0, 3), ...chineseSearchTokens])
  ).slice(0, 5);

  const codeHits: DecodeJargonResult['codeHits'] = [];
  for (const q of codeQueries) {
    const hits = await grepPrdCode(q, undefined, 25);
    for (const h of hits) {
      if (
        codeHits.length < 40 &&
        !codeHits.some((c) => c.repo === h.repo && c.path === h.path && c.line === h.line)
      ) {
        codeHits.push(h);
      }
    }
  }

  // 将命中词条自带的权威源码锚点也补充进候选证据（若检索结果较少）
  for (const { term } of rankedTermEntries.slice(0, 3)) {
    for (const ptr of (term.engineering?.pointers || []).slice(0, 2)) {
      const startLine = Number(((ptr.lines || '1').match(/\d+/) || [1])[0]);
      if (
        codeHits.length < 12 &&
        !codeHits.some((c) => c.repo === ptr.repo && c.path === ptr.path)
      ) {
        codeHits.push({
          repo: ptr.repo,
          branch: ptr.branch || 'prd',
          commit: ptr.commit,
          path: ptr.path,
          line: startLine,
          snippet: ptr.desc,
        });
      }
    }
  }

  traceSteps.push({
    tool: 'grep_prd_code',
    summary: `在 38 仓源码库中检索 [${codeQueries.join(', ')}] -> 命中 ${codeHits.length} 处真实源码位置`,
  });

  // 3. 读取前 4 处最核心源码的真实上下文窗口（供大模型或 Codex CLI 直接取证）
  const codeSlices: Array<{
    repo: string;
    path: string;
    lines: string;
    content: string;
  }> = [];

  const prioritizedHits = [...codeHits].sort((a, b) => {
    const scoreHit = (h: CodeSearchHit) => {
      let s = 0;
      if (
        /Service|Controller|Manager|Handler|Engine|UseCase|Domain|Policy|Validator|Workflow/i.test(
          h.path
        )
      ) {
        s += 40;
      } else if (/\/src\/|\/domain\/|\/service\/|\/core\//i.test(h.path)) {
        s += 20;
      }
      if (h.snippet.length >= 22) s += 12;
      if (/console\.(log|error)/i.test(h.snippet)) {
        s -= 20;
      }
      if (/ copy/i.test(h.path)) s -= 25;
      return s;
    };
    return scoreHit(b) - scoreHit(a);
  });

  const seenSliceFiles = new Set<string>();
  for (const h of prioritizedHits) {
    if (codeSlices.length >= 4) break;
    const fileKey = `${h.repo}:${h.path}`;
    if (seenSliceFiles.has(fileKey)) continue;
    seenSliceFiles.add(fileKey);

    const startL = Math.max(1, h.line - 15);
    const endL = h.line + 45;
    const fileSlice = await readPrdFile({
      repo: h.repo,
      filePath: h.path,
      lines: `L${startL}-L${endL}`,
      commit: h.commit !== 'unknown' ? h.commit : undefined,
    });
    if (fileSlice && fileSlice.content) {
      codeSlices.push({
        repo: h.repo,
        path: h.path,
        lines: `L${fileSlice.startLine}-L${fileSlice.endLine}`,
        content: fileSlice.content.slice(0, 2000),
      });
    }
  }

  if (codeSlices.length > 0) {
    traceSteps.push({
      tool: 'read_prd_file',
      summary: `精读 ${codeSlices.length} 处核心源码上下文窗口 (${codeSlices.map((s) => `${s.repo}/${ path.posix.basename(s.path)}`).join(', ')})`,
    });
  }

  const quotedPhrases = Array.from(
    rawText.matchAll(/[「“"【]([\u4e00-\u9fa5A-Za-z0-9_-]{2,14})[」”"】]/g)
  ).map((m) => m[1]);
  const suggestedNewTerms = Array.from(
    new Set([...quotedPhrases, ...englishTokens])
  )
    .filter(
      (cand) =>
        !allTerms.some(
          (t) =>
            t.title.toLowerCase() === cand.toLowerCase() ||
            (t.aliases || []).some((a) => a.toLowerCase() === cand.toLowerCase())
        )
    )
    .slice(0, 6);

  const baseSystemPrompt = buildSkillSystemPrompt(skillId, allTerms);
  const systemPrompt =
    priorTurns.length > 0
      ? [
          baseSystemPrompt,
          '',
          `【多轮连续参谋会话指令】：当前处于连续对话的第 ${
            Math.floor(priorTurns.length / 2) + 1
          } 轮。请紧密衔接前序对话上下文，直接、深入地回答用户本轮追问（可根据追问性质灵活组织小标题、表格或代码/规则实证，不必重复首轮已经铺陈过的通用背景）。`,
        ].join('\n')
      : baseSystemPrompt;

  const richLexiconContext = rankedTermEntries.map(({ term, matchedPhrase }) => ({
    id: term.id,
    title: term.title,
    category: term.category,
    matchedPhrase,
    summary: term.summary,
    analogy: term.layman.analogy,
    plain: term.layman.plain,
    keyExcerpt: (term.articleMarkdown || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 520),
    topFaqs: (term.faqs || []).slice(0, 2),
  }));

  const historyTranscriptBlock =
    priorTurns.length > 0
      ? `【前序连续会话历史 (${priorTurns.length} 条消息)】：\n` +
        priorTurns
          .map(
            (m, idx) =>
              `[${idx + 1}] ${m.role === 'user' ? '用户提问' : '参谋结论'}：\n${m.content.slice(
                0,
                1200
              )}`
          )
          .join('\n\n')
      : '';

  const userContextPayload = [
    historyTranscriptBlock,
    `【本轮用户最新提问 / 待分析原文】：\n${rawText}`,
    `【当前激活参谋技能】：${skillId}`,
    `【领域词典全库统计画像】：\n${JSON.stringify(lexiconStats)}`,
    `【已召回的领域词典与流程实证词条 (${richLexiconContext.length} 项)】：\n${JSON.stringify(
      richLexiconContext,
      null,
      2
    )}`,
    matchedFields.length > 0
      ? `【已命中的库表字段映射 (${matchedFields.length} 项)】：\n${JSON.stringify(matchedFields)}`
      : '',
    codeHits.length > 0
      ? `【源码仓检索命中位置 (${codeHits.length} 处)】：\n${JSON.stringify(
          prioritizedHits.slice(0, 8)
        )}`
      : '',
    codeSlices.length > 0
      ? `【精读的真实源码上下文切片 (${codeSlices.length} 处)】：\n${codeSlices
          .map(
            (s) =>
              `--- [${s.repo}] ${s.path} (${s.lines}) ---\n${s.content}`
          )
          .join('\n\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const persistAdvisorTurnIfNeeded = async (answerMd: string, modeStr: string) => {
    if (!input.sessionId || !input.userId) return;
    try {
      await lexiconStore.saveChatTurn({
        sessionId: input.sessionId,
        userId: input.userId,
        question: rawText,
        answer: answerMd,
        trace: traceSteps,
        referencedCommits: Array.from(
          new Set(prioritizedHits.slice(0, 6).map((h) => `${h.repo}@${h.commit}`))
        ),
        mode: modeStr,
      });
    } catch {}
  };

  // 4. 引擎分支 A：若显式选择 codex-cli，调用本机 Codex CLI Harness 深度自主验证
  if (enginePreference === 'codex-cli') {
    const codexPrompt = [
      systemPrompt,
      '',
      '【极速实证指令】：我们已经为你从工作区源码库实时检索并附上了最核心的真实源码上下文切片（见下方「精读的真实源码上下文切片」）以及领域词典定义。请直接基于下方已提供的源码切片与词典证据立即撰写并输出 Markdown 报告，不要执行任何 shell 命令或额外文件搜索！',
      '',
      userContextPayload,
    ].join('\n');

    const codexOut = await runLocalCodexCliHarness(codexPrompt, 60_000);
    if (codexOut && codexOut.markdown) {
      traceSteps.push({
        tool: 'codex_cli_harness',
        summary: `Codex CLI 只读沙箱完成深度源码核验${
          codexOut.inspectedFiles.length > 0
            ? ` (附加检视: ${codexOut.inspectedFiles.slice(0, 3).join(', ')})`
            : ''
        }`,
      });
      await persistAdvisorTurnIfNeeded(codexOut.markdown, 'codex-cli');
      return {
        matchedTerms,
        matchedFields,
        codeHits: prioritizedHits.slice(0, 10),
        suggestedNewTerms,
        translationMarkdown: codexOut.markdown,
        mode: 'codex-cli',
        skillId,
        durationMs: Date.now() - startTime,
        traceSteps,
        lexiconStats,
      };
    }
  }

  // 5. 引擎分支 B：使用已预取词典 + 38 仓真实源码切片 + 技能护栏调用配置大模型
  const aiCfg = await lexiconStore.getServerAiConfig();
  if (aiCfg.hasKey && aiCfg.apiKey) {
    try {
      const safeBaseUrl = validateAllowedLlmBaseUrl(aiCfg.baseUrl);
      const endpoint = safeBaseUrl.endsWith('/v1')
        ? `${safeBaseUrl}/chat/completions`
        : `${safeBaseUrl}/v1/chat/completions`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiCfg.apiKey}`,
        },
        body: JSON.stringify({
          model: aiCfg.model || 'deepseek-chat',
          temperature: 0.15,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            ...priorTurns.map((m) => ({
              role: m.role,
              content: m.content.slice(0, 1600),
            })),
            {
              role: 'user',
              content: userContextPayload,
            },
          ],
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        const content = String(data?.choices?.[0]?.message?.content || '').trim();
        if (content) {
          traceSteps.push({
            tool: 'advisor_skill_synthesis',
            summary: `基于 ${matchedTerms.length} 个词条与 ${codeSlices.length} 处真实源码切片完成「${skillId}」参谋推演`,
          });
          await persistAdvisorTurnIfNeeded(content, 'llm-decoded');
          return {
            matchedTerms,
            matchedFields,
            codeHits: prioritizedHits.slice(0, 10),
            suggestedNewTerms,
            translationMarkdown: content,
            mode: 'llm-decoded',
            skillId,
            durationMs: Date.now() - startTime,
            traceSteps,
            lexiconStats,
          };
        }
      }
    } catch {
      // Fallback below
    }
  }

  // 6. 引擎分支 C：若未配置 API Key 且处于 auto 模式，尝试本机 Codex CLI 兜底
  if (enginePreference === 'auto' && fs.existsSync(CODEBASE_PRD_ROOT)) {
    const codexPrompt = [systemPrompt, '', userContextPayload].join('\n');
    const codexOut = await runLocalCodexCliHarness(codexPrompt, 45_000);
    if (codexOut && codexOut.markdown) {
      traceSteps.push({
        tool: 'codex_cli_harness',
        summary: `Codex CLI 完成源码实证参谋推演`,
      });
      return {
        matchedTerms,
        matchedFields,
        codeHits: prioritizedHits.slice(0, 10),
        suggestedNewTerms,
        translationMarkdown: codexOut.markdown,
        mode: 'codex-cli',
        skillId,
        durationMs: Date.now() - startTime,
        traceSteps,
        lexiconStats,
      };
    }
  }

  const fallbackMarkdown = [
    `### 业务参谋拆解报告（共召回 ${matchedTerms.length} 个领域概念，命中 ${codeHits.length} 处源码证据）`,
    '',
    matchedTerms.length > 0
      ? [
          '| 命中概念 | 通俗生活比喻 | 核心业务规则 |',
          '| :--- | :--- | :--- |',
          ...matchedTerms.map(
            (m) => `| **${m.title}** (\`${m.matchedPhrase}\`) | ${m.analogy} | ${m.plain} |`
          ),
        ].join('\n')
      : '> 当前段落暂未直接命中已收录词条，可在下方将新名词一键交由 AI 提炼建词。',
  ].join('\n');

  return {
    matchedTerms,
    matchedFields,
    codeHits: prioritizedHits.slice(0, 10),
    suggestedNewTerms,
    translationMarkdown: fallbackMarkdown,
    mode: 'lexicon-rule-only',
    skillId,
    durationMs: Date.now() - startTime,
    traceSteps,
    lexiconStats,
  };
}
