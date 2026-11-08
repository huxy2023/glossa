import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { lexiconStore, type AuthSessionUser } from './services/lexicon-store.js';
import { setInjectedDbClient } from './services/pg-database.js';
import {
  getPrdManifest,
  grepPrdCode,
  readPrdFile,
  inspectTermsDrift,
} from './services/codebase-probe.js';
import {
  runAgentAsk,
  streamAgentAsk,
  generateTermWithHarness,
  testAiProviderConnection,
  validateAllowedLlmBaseUrl,
  decodeJargonParagraph,
  dissectTermSproutsWithHarness,
  expandCandidateWithHarness,
  runSproutWaveWithHarness,
} from './services/agent-harness.js';
import { runWorkerCycle } from './worker.js';

type Variables = {
  user: AuthSessionUser;
};

export const app = new Hono<{ Variables: Variables }>();

app.use(
  '*',
  cors({
    origin: (origin) => origin || '*',
    credentials: true,
  })
);

function extractRequestToken(c: any): string {
  const cookieToken = getCookie(c, 'glossa_session');
  if (cookieToken) return cookieToken;
  const authHeader = String(c.req.header('Authorization') || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

// ============================================================================
// 公开健康检查与鉴权接口 (/api/health, /api/auth/*)
// ============================================================================

app.get('/api/health', async (c) => {
  await lexiconStore.ensureInitialized();
  return c.json({
    ok: true,
    service: 'glossa-api',
    storageDriver: lexiconStore.driverName,
    authRequired: true,
  });
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || 'admin').trim();
  const password = String(body.password || '');
  const ua = c.req.header('user-agent') || '';

  const session = await lexiconStore.authenticateUser(username, password, ua);
  if (!session) {
    return c.json({ ok: false, error: '账号或访问口令错误，拒绝访问' }, 401);
  }

  const isHttps =
    c.req.url.startsWith('https://') ||
    c.req.header('x-forwarded-proto') === 'https';

  setCookie(c, 'glossa_session', session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps,
    maxAge: 7 * 24 * 3600,
  });

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    ok: true,
    token: session.token,
    user: session.user,
  });
});

app.get('/api/auth/me', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const token = extractRequestToken(c);
  const user = await lexiconStore.verifySessionToken(token);
  if (!user) {
    return c.json({ ok: false, authenticated: false, error: '未登录或会话已过期' }, 401);
  }
  const aiConfig = await lexiconStore.getPublicAiConfig();
  return c.json({
    ok: true,
    authenticated: true,
    user,
    aiConfig,
  });
});

app.post('/api/auth/logout', async (c) => {
  const token = extractRequestToken(c);
  if (token) {
    await lexiconStore.revokeSessionToken(token);
  }
  deleteCookie(c, 'glossa_session', { path: '/' });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ ok: true });
});

// ============================================================================
// 强制鉴权中间件：拦截一切匿名访问业务 API
// ============================================================================

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (
    path === '/api/health' ||
    path === '/api/auth/login' ||
    path === '/api/auth/me' ||
    path === '/api/auth/logout'
  ) {
    return next();
  }

  c.header('Cache-Control', 'private, no-store');
  const token = extractRequestToken(c);
  const user = await lexiconStore.verifySessionToken(token);
  if (!user) {
    return c.json(
      { ok: false, error: '未授权访问：请先通过内部账号或口令登录' },
      401
    );
  }
  c.set('user', user);
  return next();
});

// 1. 获取全量词典、领域分类、38 仓清单、源码快照与 AI 配置状态 (仅限已登录用户，并行化查询缩短首屏响应时间)
app.get('/api/lexicon', async (c) => {
  const categories = lexiconStore.getCategories();
  const prdManifest = getPrdManifest();
  const [
    terms,
    revisions,
    feedbackTickets,
    aiConfig,
    dbSnapshotRows,
    workerStatus,
  ] = await Promise.all([
    lexiconStore.getTermsAsync(),
    lexiconStore.getRevisionsAsync(),
    lexiconStore.getFeedbackTicketsAsync(),
    lexiconStore.getPublicAiConfig(),
    lexiconStore.getAllCodeSnapshotsFromPg(),
    lexiconStore.getWorkerStatus(),
  ]);
  const driftSummary = await inspectTermsDrift(terms);
  const codeSnapshots: Record<string, string> = {};
  for (const row of dbSnapshotRows) {
    codeSnapshots[`${row.repo}:${row.filePath}`] = row.content;
  }

  return c.json({
    ok: true,
    categories,
    terms,
    prdManifest,
    codeSnapshots,
    driftSummary,
    aiConfig,
    workerStatus,
    feedbackTickets,
    meta: {
      storageDriver: lexiconStore.driverName,
      totalTerms: terms.length,
      revisionCount: revisions.length,
      openFeedbackCount: feedbackTickets.filter((t) => t.status === 'OPEN').length,
      indexedSnapshotCount: dbSnapshotRows.length,
      workerOnline: workerStatus.online,
    },
  });
});

// 2. 读取与更新持久化在 CloudBase PostgreSQL 中的 AI Provider 配置（修改仅限管理员）
app.get('/api/settings/ai', async (c) => {
  const aiConfig = await lexiconStore.getPublicAiConfig();
  return c.json({ ok: true, aiConfig });
});

app.put('/api/settings/ai', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.json(
      { ok: false, error: '权限不足：仅管理员 (admin) 可修改全局 AI Provider 配置' },
      403
    );
  }
  const body = await c.req.json();
  try {
    const safeUrl = validateAllowedLlmBaseUrl(body.baseUrl || 'https://api.deepseek.com');
    const updated = await lexiconStore.updateAiConfig(
      {
        protocol:
          body.protocol === 'anthropic-messages'
            ? 'anthropic-messages'
            : 'openai-compatible',
        baseUrl: safeUrl,
        model: String(body.model || 'deepseek-chat').trim(),
        apiKey: body.apiKey,
      },
      user.username
    );
    return c.json({ ok: true, aiConfig: updated });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message || 'AI 配置校验失败' }, 400);
  }
});

app.post('/api/settings/ai/test', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.json(
      { ok: false, error: '权限不足：仅管理员 (admin) 可测试全局 AI Provider 配置' },
      403
    );
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await testAiProviderConnection({
      protocol: body.protocol,
      baseUrl: body.baseUrl,
      model: body.model,
      apiKey: body.apiKey,
    });
    return c.json(result, result.ok ? 200 : 400);
  } catch (err: any) {
    return c.json(
      { ok: false, latencyMs: 0, error: err?.message || 'AI 连通性测试失败' },
      400
    );
  }
});

// 3. 读取 .codebase-prd 指定仓库、指定 Commit 与行号的真实源码（带严格路径白名单与 PG 快照行号区间核验）
app.get('/api/code/read', async (c) => {
  const repo = c.req.query('repo') || '';
  const filePath = c.req.query('path') || '';
  const lines = c.req.query('lines');
  const commit = c.req.query('commit');

  const result = await readPrdFile({ repo, filePath, lines, commit });
  if (!result) {
    return c.json(
      { ok: false, error: '未找到指定源码文件或非法的路径/Commit/行号区间参数' },
      404
    );
  }
  return c.json({ ok: true, result });
});

// 4. 在 .codebase-prd / 数据库快照中执行纯代码检索
app.get('/api/code/search', async (c) => {
  const q = c.req.query('q') || '';
  const repo = c.req.query('repo');
  const hits = await grepPrdCode(q, repo, 15);
  return c.json({ ok: true, query: q, hits });
});

// 5. 月度 PRD Commit 增量巡检接口
app.get('/api/code/drift', async (c) => {
  const terms = await lexiconStore.getTermsAsync();
  const report = await inspectTermsDrift(terms);
  return c.json({ ok: true, report });
});

// 6. Agent Harness 伴读问答（带多轮历史、会话归属校验、真实工具调用循环与数据库持久化）
app.post('/api/agent/ask', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  try {
    const output = await runAgentAsk({
      sessionId: body.sessionId,
      userId: user.username,
      question: body.question || '',
      activeTermId: body.activeTermId,
      selectedText: body.selectedText,
    });
    return c.json({ ok: true, ...output });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '伴读问答请求失败' },
      err?.status === 403 ? 403 : 400
    );
  }
});

// 6.1 Agent Harness 原生 SSE 流式伴读问答（实时推送工具取证进度 + DeepSeek 逐字流式 Markdown 渲染）
app.post('/api/agent/ask/stream', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  return streamSSE(c, async (stream) => {
    await streamAgentAsk(
      {
        sessionId: body.sessionId,
        userId: user.username,
        question: body.question || '',
        activeTermId: body.activeTermId,
        selectedText: body.selectedText,
      },
      async (event, payload) => {
        await stream.writeSSE({
          event,
          data: JSON.stringify(payload),
        });
      }
    );
  });
});

// 7. 获取指定会话的多轮对话历史与用户的近期会话列表（严格校验当前用户会话归属）
app.get('/api/agent/sessions', async (c) => {
  const user = c.get('user');
  const sessions = await lexiconStore.listChatSessions(user.username, 20);
  return c.json({ ok: true, sessions });
});

app.get('/api/agent/history', async (c) => {
  const user = c.get('user');
  const sessionId = c.req.query('sessionId') || '';
  try {
    const messages = await lexiconStore.getChatMessages(sessionId, 20, user.username);
    return c.json({ ok: true, sessionId, messages });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '读取会话历史失败' },
      err?.status === 403 ? 403 : 400
    );
  }
});

// 7.5 业务参谋与多技能智能咨询接口 (/api/agent/decode & /api/agent/consult)
const handleAdvisorConsult = async (c: any) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.text || body.question || '').trim();
  if (!text) {
    return c.json({ ok: false, error: '待分析文本或问题不能为空' }, 400);
  }
  const validSkills = [
    'troubleshooting',
    'solution-design',
    'metrics-analytics',
    'jargon-demystify',
  ];
  const validEngines = ['auto', 'codex-cli', 'llm-api'];
  const skillId = validSkills.includes(body.skillId) ? body.skillId : undefined;
  const enginePreference = validEngines.includes(body.enginePreference)
    ? body.enginePreference
    : 'auto';
  const result = await decodeJargonParagraph({
    text,
    userId: user.username,
    sessionId: body.sessionId ? String(body.sessionId) : undefined,
    history: Array.isArray(body.history) ? body.history : undefined,
    skillId,
    enginePreference,
  });
  return c.json({ ok: true, ...result });
};

app.post('/api/agent/decode', handleAdvisorConsult);
app.post('/api/agent/consult', handleAdvisorConsult);

// 8. Agent Harness 考据生成新词条草稿并写入 PostgreSQL（支持划词上下文演化、采纳伴读解释与内网 Worker 实时联动）
const handleEvolveTerm = async (c: any) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || body.phrase || '').trim();
  if (!title) {
    return c.json({ ok: false, error: '词条名称不能为空' }, 400);
  }
  const { term, trace } = await generateTermWithHarness(title, user.username, {
    contextSnippet: body.contextSnippet ? String(body.contextSnippet) : undefined,
    sourceTermId: body.sourceTermId ? String(body.sourceTermId) : undefined,
    category: body.category,
    aiExplanation: body.aiExplanation ? String(body.aiExplanation) : undefined,
  });
  return c.json({ ok: true, term, trace });
};

app.post('/api/agent/generate-term', handleEvolveTerm);
app.post('/api/terms/evolve', handleEvolveTerm);

const canEditTerms = (role?: string) =>
  role === 'admin' || role === 'editor' || role === 'maintainer';

// 8.05 词条草稿转正发布、在线编辑微调与删除管理（全量存储于 PostgreSQL）
app.post('/api/terms/:id/publish', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：当前只读账号无权转正发布词条' },
      403
    );
  }
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  try {
    const updated = await lexiconStore.publishTermAsync(
      id,
      user.username,
      body.expectedRevision ?? body.revision
    );
    if (!updated) return c.json({ ok: false, error: '词条不存在' }, 404);
    return c.json({ ok: true, term: updated });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '发布失败' },
      err?.status === 409 ? 409 : 400
    );
  }
});

app.put('/api/terms/:id', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：当前只读账号无权编辑修改词条' },
      403
    );
  }
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  try {
    const updated = await lexiconStore.updateTermFieldsAsync(
      id,
      {
        title: body.title,
        subtitle: body.subtitle,
        pinyin: body.pinyin,
        category: body.category,
        aliases: body.aliases,
        summary: body.summary,
        laymanAnalogy: body.laymanAnalogy ?? body.layman?.analogy,
        laymanPlain: body.laymanPlain ?? body.layman?.plain,
        articleMarkdown: body.articleMarkdown,
        status: body.status,
        expectedRevision: body.expectedRevision ?? body.revision,
      },
      user.username
    );
    if (!updated) return c.json({ ok: false, error: '词条不存在' }, 404);
    return c.json({ ok: true, term: updated });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '保存修订失败' },
      err?.status === 409 ? 409 : 400
    );
  }
});

app.delete('/api/terms/:id', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：当前只读账号无权删除词条' },
      403
    );
  }
  const id = c.req.param('id');
  const ok = await lexiconStore.deleteTermAsync(id, user.username);
  if (!ok) return c.json({ ok: false, error: '词条不存在' }, 404);
  return c.json({ ok: true, deletedId: id });
});

app.post('/api/terms/:id/rollback', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：当前只读账号无权回滚词条历史版本' },
      403
    );
  }
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const targetRevision = Number(body.targetRevision ?? body.revision);
  if (!Number.isFinite(targetRevision) || targetRevision < 1) {
    return c.json({ ok: false, error: '无效的目标版本号 targetRevision' }, 400);
  }
  try {
    const restored = await lexiconStore.rollbackTermRevisionAsync(
      id,
      targetRevision,
      user.username,
      body.expectedRevision
    );
    if (!restored) {
      return c.json({ ok: false, error: '未找到指定词条或目标历史版本快照' }, 404);
    }
    return c.json({ ok: true, term: restored });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '回滚版本失败' },
      err?.status === 409 ? 409 : 400
    );
  }
});

// 8.1 方案 A：内网源码探针 Worker 状态查询与主动同步触发接口
app.get('/api/worker/status', async (c) => {
  const workerStatus = await lexiconStore.getWorkerStatus();
  return c.json({ ok: true, workerStatus });
});

app.post('/api/worker/sync', async (c) => {
  const user = c.get('user');
  const currentStatus = await lexiconStore.getWorkerStatus();
  if (currentStatus.localWorktreeReady && currentStatus.localRepoCount > 0) {
    const result = await runWorkerCycle({ syncAllTermPointers: true, maxTasks: 15 });
    const workerStatus = await lexiconStore.getWorkerStatus();
    return c.json({ ok: true, result, workerStatus });
  }
  const taskId = await lexiconStore.enqueueWorkerTask(
    'INSPECT_DRIFT',
    { syncAllTermPointers: true },
    user.username
  );
  const remoteResult = await lexiconStore.waitForWorkerTask(taskId, 4500);
  const workerStatus = await lexiconStore.getWorkerStatus();
  return c.json({
    ok: true,
    enqueuedTaskId: taskId,
    result: remoteResult || { syncedSnapshots: 0, processedTasks: 0, queued: true },
    workerStatus,
  });
});

// 9. 将优质问答一键沉淀到当前词条 FAQ (PostgreSQL 单语句 CTE 原子更新 + 快照记录)
app.post('/api/lexicon/faq', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：当前只读账号无权修改词条 FAQ' },
      403
    );
  }
  const body = await c.req.json();
  try {
    const updated = await lexiconStore.addFaqAsync(
      body.termId,
      body.q,
      body.a,
      user.username
    );
    if (!updated) return c.json({ ok: false, error: '词条不存在' }, 404);
    return c.json({ ok: true, term: updated });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '保存失败' },
      err?.status === 409 ? 409 : 500
    );
  }
});

// 10. 查询词条历史版本修订审计快照 (lexicon_term_revisions)
app.get('/api/revisions', async (c) => {
  const termId = c.req.query('termId');
  const revisions = await lexiconStore.getRevisionsAsync(termId);
  return c.json({ ok: true, revisions });
});

// 11. 提交/查询/结案缺词雷达与划词纠错工单 (lexicon_feedback_tickets)
app.get('/api/feedback', async (c) => {
  const tickets = await lexiconStore.getFeedbackTicketsAsync();
  return c.json({ ok: true, tickets });
});

// 12. 「抓到触手，引爆全场，处处生花」AI Agent Harness 触手裂变与繁衍记忆契约接口 (/api/harness/*)
app.get('/api/harness/overview', async (c) => {
  const termId = c.req.query('termId') || undefined;
  const runId = c.req.query('runId') || undefined;
  const status = c.req.query('status') || undefined;
  const overview = await lexiconStore.getHarnessOverviewAsync({
    sourceTermId: termId,
    runId,
    status,
  });
  return c.json({ ok: true, ...overview });
});

app.post('/api/harness/lookup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const query = String(body.query || body.name || '').trim();
  if (!query) {
    return c.json({ ok: false, error: '查询概念名称 query 不能为空' }, 400);
  }
  const result = await lexiconStore.lookupConceptAsync(query, body.category);
  return c.json({ ok: true, ...result });
});

app.post('/api/harness/dissect', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：仅管理员或编审员可执行触手剖析' },
      403
    );
  }
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await dissectTermSproutsWithHarness({
      sourceTermId: body.sourceTermId ? String(body.sourceTermId) : undefined,
      rawText: body.rawText ? String(body.rawText) : undefined,
      sourceTitle: body.sourceTitle ? String(body.sourceTitle) : undefined,
      runId: body.runId ? String(body.runId) : undefined,
      depth: body.depth ? Number(body.depth) : 1,
      operator: user.username,
      customSprouts: Array.isArray(body.customSprouts) ? body.customSprouts : undefined,
    });
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '顺藤摸瓜剖析失败' },
      400
    );
  }
});

app.post('/api/harness/resolve', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：仅管理员或编审员可决议候选触手' },
      403
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const candidateId = String(body.candidateId || body.name || '').trim();
  if (!candidateId) {
    return c.json({ ok: false, error: '候选触手 ID (candidateId) 不能为空' }, 400);
  }
  try {
    const result = await expandCandidateWithHarness(candidateId, {
      action: body.action,
      targetTermId: body.targetTermId ? String(body.targetTermId) : undefined,
      decisionNote: body.decisionNote ? String(body.decisionNote) : undefined,
      customTerm: body.customTerm,
      publishImmediately: body.publishImmediately !== false,
      autoDissectNextLayer: Boolean(body.autoDissectNextLayer),
      operator: user.username,
    });
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '候选触手决议执行失败' },
      400
    );
  }
});

app.post('/api/harness/run-wave', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：仅管理员或编审员可触发波次引爆' },
      403
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const seedTermId = String(body.seedTermId || 'fee-terminal').trim();
  try {
    const result = await runSproutWaveWithHarness({
      seedTermId,
      maxDepth: body.maxDepth ? Number(body.maxDepth) : 2,
      maxDrafts: body.maxDrafts ? Number(body.maxDrafts) : 5,
      autoResolve: body.autoResolve !== false,
      operator: user.username,
    });
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    return c.json(
      { ok: false, error: err?.message || '一键引爆波次执行失败' },
      400
    );
  }
});

app.post('/api/feedback', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const queryOrSelection = String(body.queryOrSelection || '').trim();
  if (!queryOrSelection) {
    return c.json({ ok: false, error: '反馈内容不能为空' }, 400);
  }
  const ticket = await lexiconStore.recordFeedbackAsync({
    type: body.type || 'MISSING_TERM',
    termId: body.termId,
    termRevision: body.termRevision,
    queryOrSelection,
    comment: body.comment,
    reporter: user.username,
  });
  return c.json({ ok: true, ticket });
});

app.patch('/api/feedback/:id', async (c) => {
  const user = c.get('user');
  if (!canEditTerms(user.role)) {
    return c.json(
      { ok: false, error: '权限不足：仅管理员或编审员可处理反馈工单' },
      403
    );
  }
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const validStatuses = ['OPEN', 'TRIAGING', 'RESOLVED_UPDATED', 'REJECTED'];
  const nextStatus = validStatuses.includes(body.status) ? body.status : 'RESOLVED_UPDATED';
  const updated = await lexiconStore.resolveFeedbackTicketAsync(
    id,
    {
      status: nextStatus,
      resolutionTermId: body.resolutionTermId,
      resolutionNote: body.resolutionNote,
    },
    user.username
  );
  if (!updated) {
    return c.json({ ok: false, error: '工单不存在' }, 404);
  }
  return c.json({ ok: true, ticket: updated });
});

export async function handleMyShipFetch(request: Request, context?: any): Promise<Response> {
  if (context?.db) {
    setInjectedDbClient(context.db);
  }
  return app.fetch(request);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT || 8790);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `🚀 Glossa API (PostgreSQL + Auth Gate) running at http://localhost:${info.port}`
    );
  });
}
