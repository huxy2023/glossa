import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../index.js';
import { lexiconStore } from '../services/lexicon-store.js';
import { pgExecute, encryptApiKey } from '../services/pg-database.js';
import {
  readPrdFile,
  grepPrdCode,
  inspectTermsDrift,
  getPrdManifest,
  validateRepoAndRelativePath,
  WORKSPACE_ROOT,
} from '../services/codebase-probe.js';
import {
  extractTextSproutCandidates,
  isNoiseOrTechCandidate,
  auditLexiconQuality,
} from '../services/sprout-engine.js';
import {
  runAgentAsk,
  generateTermWithHarness,
  sanitizeBusinessProse,
  validateAllowedLlmBaseUrl,
  decodeJargonParagraph,
  extractDsmlToolCalls,
  stripDsmlMarkup,
  dissectTermSproutsWithHarness,
  expandCandidateWithHarness,
  runSproutWaveWithHarness,
} from '../services/agent-harness.js';
import { runWorkerCycle } from '../worker.js';
import {
  sanitizeRichHtml,
  compileMermaidToSvg,
  buildKeywordMatchers,
  renderChatMarkdownHtml,
} from '../../../web/src/components/v5ArticleHtml.js';

const FIXTURE_TERM_A = 'ut-fixture-credit-pool';
const FIXTURE_TERM_B = 'ut-fixture-order-split';

async function setupNeutralTestFixtures() {
  await lexiconStore.ensureInitialized();
  await lexiconStore.saveTermAsync(
    {
      id: FIXTURE_TERM_A,
      title: '单元测试授信资金池',
      pinyin: 'DYCSSXZJC',
      category: 'finance',
      aliases: ['测试授信池'],
      summary: '用于控制客户下单可用余额与返利抵扣上限的统一账务账户体系。',
      layman: {
        analogy: '就像企业专属的多币种储值卡，现款、返利和授信额度分池管理。',
        plain: '下单时系统实时校验可用授信池余额，余额不足则拦截拆单。',
      },
      articleMarkdown: '## 核心规则\n\n当客户发起订单时，优先校验 **单元测试订单拆单** 与额度池可用余额。',
      engineering: { repos: [], pointers: [], dataMappings: [] },
      relations: [{ target: FIXTURE_TERM_B, label: '前置额度校验' }],
      faqs: [
        { q: '为什么授信资金池余额充足却提示无法下单？', a: '请检查专项返利池抵扣比例上限与冻结状态。' },
        { q: '授信资金池何时释放占用额度？', a: '订单取消或冲红审核通过后实时释放。' },
        { q: '如何核对账务流水？', a: '通过日终凭证对账单核验每一笔扣减记录。' },
      ],
      meta: {
        updatedAt: '2026-11-08',
        maintainedBy: 'glossa-test',
        status: 'PUBLISHED',
        revision: 1,
      },
    },
    '单元测试初始化',
    'unit-test'
  );

  await lexiconStore.saveTermAsync(
    {
      id: FIXTURE_TERM_B,
      title: '单元测试订单拆单',
      pinyin: 'DYCSDDCD',
      category: 'workflow',
      aliases: ['测试自动拆单'],
      summary: '根据仓库发货地、账套归属与价格策略将主订单自动拆分为子履约单的规则引擎。',
      layman: {
        analogy: '就像跨省电商包裹按发货仓自动拆成多个子包裹分别发货。',
        plain: '不同核算主体或不同发货仓的商品会自动拆分为独立子单进入履约流水线。',
      },
      articleMarkdown: '## 核心规则\n\n拆单前必须通过 **单元测试授信资金池** 的额度预占校验。',
      engineering: { repos: [], pointers: [], dataMappings: [] },
      relations: [{ target: FIXTURE_TERM_A, label: '依赖额度预占' }],
      faqs: [
        { q: '为什么一笔订单被拆成了多张子单？', a: '因商品分属不同发货仓或不同结算账套触发自动拆单。' },
      ],
      meta: {
        updatedAt: '2026-11-08',
        maintainedBy: 'glossa-test',
        status: 'PUBLISHED',
        revision: 1,
      },
    },
    '单元测试初始化',
    'unit-test'
  );
}

async function cleanupNeutralTestFixtures() {
  for (const tid of [FIXTURE_TERM_A, FIXTURE_TERM_B]) {
    await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id = $1`, [tid]);
    await pgExecute(`DELETE FROM lexicon_terms WHERE id = $1`, [tid]);
  }
  await lexiconStore.refreshFromPg();
}

test('1. Drizzle ORM + PostgreSQL 初始化、领域词条读写与版本快照校验', async () => {
  await setupNeutralTestFixtures();
  assert.ok(
    ['drizzle-pg-tcp', 'drizzle-cloudbase-http'].includes(lexiconStore.driverName),
    '应使用 Drizzle ORM 驱动'
  );
  assert.ok(lexiconStore.schema.lexiconTerms, 'Drizzle schema 应导出 lexiconTerms 表定义');

  const termA = await lexiconStore.getTermByIdAsync(FIXTURE_TERM_A);
  assert.ok(termA, '测试词条应在 PostgreSQL 中存在');
  assert.equal(termA.meta?.status, 'PUBLISHED');
  assert.ok((termA.meta?.revision || 0) >= 1);
  assert.ok((termA.faqs || []).length >= 3, '词条应包含排障 FAQ');

  const revisions = await lexiconStore.getRevisionsAsync(FIXTURE_TERM_A);
  assert.ok(revisions.length >= 1, 'lexicon_term_revisions 表应包含词条的版本快照');
});

test('2. 源码探针路径越界防护 (Path Traversal)、行号越界防护与缺失仓库漂移误报防护', async () => {
  await lexiconStore.upsertCodeSnapshot({
    repo: 'demo-billing-service',
    branch: 'main',
    commitSha: 'a1b2c3d4',
    filePath: 'src/services/CreditPoolService.ts',
    lineRange: 'L10-L25',
    content: [
      '   10 | export class CreditPoolService {',
      '   11 |   public verifyAvailableQuota(accountId: string): boolean {',
      '   12 |     return hasActiveCreditSnapshot(accountId);',
      '   13 |   }',
      '   14 | }',
    ].join('\n'),
  });

  // 验证路径穿越攻击被拦截
  const traversalAttempt = await readPrdFile({
    repo: 'demo-billing-service',
    filePath: '../../package.json',
  });
  assert.equal(traversalAttempt, null, '路径穿越攻击 (../../package.json) 必须被拒绝并返回 null');

  const invalidRepoAttempt = await readPrdFile({
    repo: '../etc',
    filePath: 'passwd',
  });
  assert.equal(invalidRepoAttempt, null, '非法仓库名必须被拒绝');

  // 验证敏感文件（.env / .pem / .key / credentials / secret）被严格阻断
  assert.equal(
    validateRepoAndRelativePath('demo-billing-service', '.env'),
    null,
    '.env 敏感配置文件必须被拦截'
  );
  assert.equal(
    validateRepoAndRelativePath('demo-billing-service', 'config/.env.production'),
    null,
    '.env.production 敏感配置文件必须被拦截'
  );
  assert.equal(
    validateRepoAndRelativePath('demo-billing-service', 'certs/server.key'),
    null,
    '私钥文件必须被拦截'
  );

  // 验证单仓库 GLOSSA_WORKSPACE_ROOT 模式（根目录本身含 .git）可正常发现并读取受控源码且拦截 .env
  const prevWsRoot = process.env.GLOSSA_WORKSPACE_ROOT;
  process.env.GLOSSA_WORKSPACE_ROOT = WORKSPACE_ROOT;
  try {
    const singleRepoManifest = getPrdManifest();
    assert.ok(singleRepoManifest['glossa'], '单 Git 仓库作为 GLOSSA_WORKSPACE_ROOT 时应自动识别');
    const pkgSlice = await readPrdFile({
      repo: 'glossa',
      filePath: 'package.json',
      lines: 'L1-L10',
    });
    assert.ok(pkgSlice && pkgSlice.content.includes('"name": "glossa"'), '单仓库模式下应能正常读取源码');
    const envAttempt = await readPrdFile({
      repo: 'glossa',
      filePath: '.env',
    });
    assert.equal(envAttempt, null, '单仓库模式下同样必须拦截 .env 读取');
    const singleRepoDrift = await inspectTermsDrift([
      {
        id: 'single-repo-term',
        title: '单仓漂移巡检测试',
        pinyin: 'SCPYXJ',
        category: 'core',
        aliases: [],
        summary: 'test',
        layman: { analogy: 'a', plain: 'b' },
        articleMarkdown: 'test',
        engineering: {
          repos: ['glossa'],
          pointers: [
            {
              repo: 'glossa',
              branch: singleRepoManifest['glossa'].branch,
              commit: singleRepoManifest['glossa'].commit,
              path: 'package.json',
              desc: 'root package',
            },
          ],
          dataMappings: [],
        },
        relations: [],
        faqs: [],
      },
    ]);
    assert.equal(singleRepoDrift.syncedCount, 1, '单仓库模式下漂移巡检应正常识别 Git 仓库并判为 synced');
  } finally {
    if (prevWsRoot !== undefined) {
      process.env.GLOSSA_WORKSPACE_ROOT = prevWsRoot;
    } else {
      delete process.env.GLOSSA_WORKSPACE_ROOT;
    }
  }

  // 验证数据库快照搜索同样拦截敏感路径 (config/credentials.json)
  await lexiconStore.upsertCodeSnapshot({
    repo: 'demo-billing-service',
    branch: 'main',
    commitSha: 'a1b2c3d4',
    filePath: 'config/credentials.json',
    lineRange: 'L1-L3',
    content: '    1 | {"secretLeakMarker": "DO_NOT_RETURN_THIS"}',
  });
  const sensitiveHits = await grepPrdCode('secretLeakMarker', 'demo-billing-service', 10, false);
  assert.equal(sensitiveHits.length, 0, '数据库快照搜索必须过滤敏感路径 config/credentials.json');
  await pgExecute(`DELETE FROM lexicon_code_snapshots WHERE file_path = 'config/credentials.json'`);

  // 验证跨行业通用概念触手提取（不限于快消后缀，教育/AI/SaaS 概念均可提取）
  const nonFmcgSprouts = extractTextSproutCandidates(
    {
      id: 'edu-course-center',
      title: '智能教务中心',
      pinyin: 'ZNJWZX',
      category: 'core',
      aliases: [],
      summary: '负责 **课程排期** 与 **模型训练** 任务调度的教务中台。',
      layman: { analogy: 'a', plain: '支持【学分核算】与【算力配额】联动。' },
      articleMarkdown: '通过 **课程排期** 触发【学分核算】。',
      relations: [],
      faqs: [],
    },
    []
  );
  const sproutNames = nonFmcgSprouts.map((s) => s.name);
  assert.ok(sproutNames.includes('课程排期'), '应能提取非快消领域概念「课程排期」');
  assert.ok(sproutNames.includes('模型训练'), '应能提取非快消领域概念「模型训练」');

  // 验证越界行号返回 null
  const outOfRangeAttempt = await readPrdFile({
    repo: 'demo-billing-service',
    filePath: 'src/services/CreditPoolService.ts',
    lines: 'L900000-L900001',
    commit: 'a1b2c3d4',
  });
  assert.equal(outOfRangeAttempt, null, '超出真实文件或快照覆盖范围的行号请求必须返回 null');

  // 验证不存在的仓库在漂移检查中绝不能误报为 synced
  const fakeDrift = await inspectTermsDrift([
    {
      id: 'fake-term',
      title: '测试假词条',
      pinyin: 'CS',
      category: 'core',
      aliases: [],
      summary: 'test',
      layman: { analogy: 'a', plain: 'b' },
      articleMarkdown: 'test',
      engineering: {
        repos: ['non-existent-repo'],
        pointers: [
          {
            repo: 'non-existent-repo',
            branch: 'main',
            commit: 'deadbeef',
            path: 'src/Main.ts',
            desc: 'test',
          },
        ],
        dataMappings: [],
      },
      relations: [],
      faqs: [],
    },
  ]);
  assert.equal(fakeDrift.errorCount, 1, '不存在的仓库必须标记为 error 而非 synced');
  assert.equal(fakeDrift.syncedCount, 0);
});

test('3. AI Base URL 白名单防 SSRF 校验、会话归属校验与最近消息窗口验证', async () => {
  assert.throws(
    () => validateAllowedLlmBaseUrl('http://127.0.0.1:8080'),
    /HTTPS|白名单/,
    '内网或非 HTTPS 地址必须被拦截'
  );
  assert.throws(
    () => validateAllowedLlmBaseUrl('https://evil-attacker.example.com'),
    /白名单/,
    '非白名单外部域名必须被拦截，防止服务端密钥泄露'
  );
  assert.equal(
    validateAllowedLlmBaseUrl('https://api.deepseek.com/'),
    'https://api.deepseek.com'
  );

  const testSessionId = `test_sess_${Date.now()}`;
  const res = await runAgentAsk({
    sessionId: testSessionId,
    userId: 'admin',
    question: '为什么单元测试授信资金池与单元测试订单拆单强关联？',
    activeTermId: FIXTURE_TERM_A,
  });
  assert.ok(res.trace.length >= 1, 'Agent Harness 应记录工具调用轨迹');
  assert.ok(res.answer.length > 10, '回答应包含有效业务信息');

  // 连续写入多轮消息，验证 getChatMessages 取最近 N 条并保持时间正序
  await lexiconStore.saveChatTurn({
    sessionId: testSessionId,
    userId: 'admin',
    question: '第二轮问题 Q2',
    answer: '第二轮回答 A2',
    trace: [],
    referencedCommits: [],
    mode: 'code-search-only-no-key',
  });

  const recent2 = await lexiconStore.getChatMessages(testSessionId, 2, 'admin');
  assert.equal(recent2.length, 2);
  assert.equal(recent2[0].content, '第二轮问题 Q2', 'getChatMessages 应取最近的消息而非最早的消息');
  assert.equal(recent2[1].content, '第二轮回答 A2');

  // 验证跨用户读取或写入该 sessionId 被 403 拦截
  await assert.rejects(
    () => lexiconStore.getChatMessages(testSessionId, 8, 'other_user'),
    /403|无权/,
    '非会话所有者读取历史必须抛出 403'
  );
  await assert.rejects(
    () =>
      lexiconStore.saveChatTurn({
        sessionId: testSessionId,
        userId: 'other_user',
        question: '越权写入',
        answer: '越权回答',
        trace: [],
        referencedCommits: [],
        mode: 'code-search-only-no-key',
      }),
    /403|无权/,
    '非会话所有者追加消息必须抛出 403'
  );

  // 清理测试会话数据
  await pgExecute(`DELETE FROM lexicon_chat_messages WHERE session_id = $1`, [testSessionId]);
  await pgExecute(`DELETE FROM lexicon_chat_sessions WHERE id = $1`, [testSessionId]);
});

test('4. 公网强制鉴权门禁、XSS 白名单净化与无默认主密钥安全校验', async () => {
  const dirtyHtml = `<div class="layer-card" onmouseover="alert(1)"><img src="x" onerror="alert(2)"><script>evil()</script><p>安全正文</p></div>`;
  const cleanHtml = sanitizeRichHtml(dirtyHtml);
  assert.ok(!cleanHtml.includes('onmouseover'), '必须剥离事件处理器属性');
  assert.ok(!cleanHtml.includes('<img'), '必须转义非白名单 img 标签');
  assert.ok(!cleanHtml.includes('<script'), '必须移除 script 块');
  assert.ok(cleanHtml.includes('<p>安全正文</p>'));

  const prevGloMaster = process.env.GLOSSA_MASTER_KEY;
  const prevLexMaster = process.env.LEXICON_MASTER_KEY;
  delete process.env.GLOSSA_MASTER_KEY;
  delete process.env.LEXICON_MASTER_KEY;
  assert.throws(
    () => encryptApiKey('sk-test-secret-123456'),
    /MASTER_KEY/,
    '缺少 MASTER_KEY 时必须拒绝加密，严禁退回可预测默认主密钥'
  );
  if (prevGloMaster) process.env.GLOSSA_MASTER_KEY = prevGloMaster;
  if (prevLexMaster) process.env.LEXICON_MASTER_KEY = prevLexMaster;

  const anonRes = await app.request('/api/lexicon');
  assert.equal(anonRes.status, 401, '匿名访问 /api/lexicon 必须返回 401 Unauthorized');

  const badLogin = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
  });
  assert.equal(badLogin.status, 401);
});

test('5. 内网源码探针 Worker 心跳注册、跨网任务队列消费与词条乐观锁生命周期验证', async () => {
  const testWorkerId = `test_worker_${Date.now()}`;
  const taskId = await lexiconStore.enqueueWorkerTask(
    'GREP_CODE',
    { query: 'hasActiveCreditSnapshot', limit: 3 },
    'unit-test'
  );
  assert.ok(taskId.startsWith('wtask_'));

  await lexiconStore.upsertCodeSnapshot({
    repo: 'demo-billing-service',
    branch: 'main',
    commitSha: 'a1b2c3d4',
    filePath: 'src/services/CreditPoolService.ts',
    lineRange: 'L30-L45',
    content: '   30 | export function settleRebatePool() { return true; }',
  });

  const cycleRes = await runWorkerCycle({
    workerId: testWorkerId,
    syncAllTermPointers: false,
    maxTasks: 10,
  });
  assert.equal(cycleRes.workerId, testWorkerId);

  const allTermSnaps = await lexiconStore.getAllCodeSnapshotsFromPg('demo-billing-service');
  const serviceSnaps = allTermSnaps.filter((s) =>
    s.filePath.endsWith('CreditPoolService.ts')
  );
  assert.ok(
    serviceSnaps.length >= 2,
    '同一文件不同区间快照应按 commit+lineRange 独立保留，不得互相覆盖'
  );

  const evolvedA = await generateTermWithHarness(
    '单元测试衍生概念甲',
    'unit-test',
    {
      sourceTermId: FIXTURE_TERM_A,
      category: 'finance',
      aiExplanation: '这是伴读助手针对单元测试衍生概念甲给出的详细白话解释。',
    }
  );
  const evolvedB = await generateTermWithHarness('单元测试衍生概念乙', 'unit-test');
  assert.notEqual(evolvedA.term.id, evolvedB.term.id, '同前缀中文新词条必须生成不同主键');
  assert.equal(evolvedA.term.meta?.status, 'DRAFT');

  const editedA = await lexiconStore.updateTermFieldsAsync(
    evolvedA.term.id,
    {
      summary: '经人工审阅微调后的一句话定义',
      laymanAnalogy: '更新后的生活比喻',
      laymanPlain: '更新后的白话解释',
      expectedRevision: evolvedA.term.meta?.revision,
    },
    'unit-test'
  );
  assert.equal(editedA?.summary, '经人工审阅微调后的一句话定义');

  await assert.rejects(
    () =>
      lexiconStore.updateTermFieldsAsync(
        evolvedA.term.id,
        { summary: '过期表单覆盖尝试', expectedRevision: 1 },
        'unit-test'
      ),
    /409|冲突/,
    '携带旧版本号提交编辑必须返回 409 冲突'
  );

  const publishedA = await lexiconStore.publishTermAsync(
    evolvedA.term.id,
    'unit-test',
    editedA?.meta?.revision
  );
  assert.equal(publishedA?.meta?.status, 'PUBLISHED', '草稿应成功转正为 PUBLISHED');

  await lexiconStore.deleteTermAsync(evolvedA.term.id, 'unit-test');
  await lexiconStore.deleteTermAsync(evolvedB.term.id, 'unit-test');
  await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id IN ($1, $2)`, [
    evolvedA.term.id,
    evolvedB.term.id,
  ]);

  const status = await lexiconStore.getWorkerStatus();
  assert.equal(status.online, true);

  await pgExecute(`DELETE FROM lexicon_code_snapshots WHERE repo = 'demo-billing-service'`);
  await pgExecute(`DELETE FROM lexicon_worker_tasks WHERE id = $1`, [taskId]);
  await pgExecute(`DELETE FROM lexicon_worker_nodes WHERE worker_id = $1`, [testWorkerId]);
});

test('6. 工单处理闭环、版本时光机回滚、业务参谋引擎与 DSML 富文本净化验证', async () => {
  const terms = await lexiconStore.getTermsAsync();
  const matchers = buildKeywordMatchers(terms);
  const svgHtml = compileMermaidToSvg(
    'flowchart LR\nA[单元测试授信资金池] --> B[单元测试订单拆单]',
    matchers
  );
  assert.ok(svgHtml.includes('data-mermaid-code='), 'Mermaid 流程图应生成带 data-mermaid-code 的官方引擎挂载容器');
  assert.ok(
    svgHtml.includes('class="mermaid-panzoom-scene"'),
    'Mermaid 容器应包含供 panzoom 挂载的画布节点'
  );

  const fbTicket = await lexiconStore.recordFeedbackAsync({
    type: 'MISSING_TERM',
    queryOrSelection: '单元测试缺词闭环验证词',
    comment: '测试提报',
    reporter: 'test_reporter',
  });
  assert.equal(fbTicket.status, 'OPEN');

  const resolvedTicket = await lexiconStore.resolveFeedbackTicketAsync(
    fbTicket.id,
    {
      status: 'RESOLVED_UPDATED',
      resolutionTermId: FIXTURE_TERM_A,
      resolutionNote: '已关联至授信资金池词条',
    },
    'admin'
  );
  assert.ok(resolvedTicket);
  assert.equal(resolvedTicket.status, 'RESOLVED_UPDATED');
  assert.equal(resolvedTicket.resolutionTermId, FIXTURE_TERM_A);

  await pgExecute(`DELETE FROM lexicon_feedback_tickets WHERE id = $1`, [fbTicket.id]);

  const tempDraft = await generateTermWithHarness('版本回滚测试词条', 'unit-test');
  const v1Summary = tempDraft.term.summary;
  const v2Term = await lexiconStore.updateTermFieldsAsync(
    tempDraft.term.id,
    {
      summary: '第 2 版被修改的一句话定义',
      expectedRevision: 1,
    },
    'unit-test'
  );
  assert.equal(v2Term?.meta?.revision, 2);

  const rolledBack = await lexiconStore.rollbackTermRevisionAsync(
    tempDraft.term.id,
    1,
    'unit-test',
    2
  );
  assert.ok(rolledBack, '应成功回滚至 v1 快照');
  assert.equal(rolledBack.meta?.revision, 3, '回滚应生成递增审计版本 v3');
  assert.equal(rolledBack.summary, v1Summary, '回滚后内容应恢复为 v1 快照定义');

  await lexiconStore.deleteTermAsync(tempDraft.term.id, 'unit-test');
  await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id = $1`, [tempDraft.term.id]);

  const decoded = await decodeJargonParagraph({
    text: '为什么单元测试授信资金池余额充足，但在执行单元测试订单拆单时仍然看不到可执行单据？',
    userId: 'admin',
  });
  assert.equal(decoded.skillId, 'troubleshooting', '应自动识别为现场疑难排障技能');
  assert.ok(decoded.matchedTerms.length >= 1, '业务参谋应识别出段落中的领域词条');
  assert.ok(decoded.translationMarkdown.length > 20, '业务参谋应返回非空分析报告');

  const sampleDsml = [
    '先看下源码：',
    '< | | DSML | | calls>',
    '< | | DSML | | invoke name="read_prd_file">',
    '< | | DSML | | parameter name="lines" string="true">L10-L25</ | | DSML | | parameter>',
    '< | | DSML | | parameter name="path" string="true">src/services/CreditPoolService.ts</ | | DSML | | parameter>',
    '< | | DSML | | parameter name="repo" string="true">demo-billing-service</ | | DSML | | parameter>',
    '</ | | DSML | | invoke>',
    '</ | | DSML | | calls>',
  ].join('\n');

  const parsedCalls = extractDsmlToolCalls(sampleDsml);
  assert.equal(parsedCalls.length, 1, '应准确提取出 DSML 工具调用');
  assert.equal(parsedCalls[0].function.name, 'read_prd_file');
  const parsedArgs = JSON.parse(parsedCalls[0].function.arguments);
  assert.equal(parsedArgs.lines, 'L10-L25');
  assert.equal(parsedArgs.repo, 'demo-billing-service');

  const strippedText = stripDsmlMarkup(sampleDsml);
  assert.ok(!strippedText.includes('DSML'), 'stripDsmlMarkup 应彻底剥离 DSML 内部标签');

  const chatHtml = renderChatMarkdownHtml(
    '### 原因分析\n**单元测试授信资金池**与`credit_pool_code`在 **单元测试订单拆单** 中常联动。\n\n' + sampleDsml,
    matchers,
    FIXTURE_TERM_B
  );
  assert.ok(chatHtml.includes('<h3>原因分析</h3>'), 'marked 应将 ### 渲染为 h3');
  assert.ok(chatHtml.includes('<code>credit_pool_code</code>'), '行内代码内部不应被注入双链标签');
  assert.ok(!chatHtml.includes('DSML'), '前端渲染结果绝不能包含 DSML 标签');
});

test('7. AI Agent Harness 触手裂变、多父节点记忆归并与同义词别名双链闭环验证', async () => {
  const testRunId = `run_unit_test_${Date.now()}`;
  const testSynName = '单元测试信用资金池';
  const testSynName2 = '单元测试授信额度池';
  const testNoiseName = '单元测试日常寒暄语';
  const testUnverifiedName = '单元测试零实证生僻概念词';

  await pgExecute(
    `DELETE FROM lexicon_expansion_candidates WHERE normalized_name IN ($1, $2, $3, $4)`,
    [
      lexiconStore.normalizeConceptName(testSynName),
      lexiconStore.normalizeConceptName(testSynName2),
      lexiconStore.normalizeConceptName(testNoiseName),
      lexiconStore.normalizeConceptName(testUnverifiedName),
    ]
  );
  await pgExecute(
    `DELETE FROM lexicon_term_revisions WHERE term_id IN (SELECT id FROM lexicon_terms WHERE title = $1)`,
    [testUnverifiedName]
  );
  await pgExecute(`DELETE FROM lexicon_terms WHERE title = $1`, [testUnverifiedName]);

  const [enq1, enq2] = await Promise.all([
    dissectTermSproutsWithHarness({
      sourceTermId: FIXTURE_TERM_A,
      runId: testRunId,
      operator: 'unit-test',
      customSprouts: [
        {
          name: testSynName,
          category: 'finance',
          quote: '在结算对账时也常将单元测试授信资金池称为单元测试信用资金池。',
          relationLabel: '同义简称',
          whyItMatters: '高频同物异名，需归并入标准别名',
          recommendedAction: 'MERGE_AS_ALIAS',
          recommendedTargetTermId: FIXTURE_TERM_A,
        },
        {
          name: testSynName2,
          category: 'finance',
          quote: '部分模块也将单元测试授信资金池简称为单元测试授信额度池。',
          relationLabel: '同义简称',
          whyItMatters: '验证并发别名归并乐观锁',
          recommendedAction: 'MERGE_AS_ALIAS',
          recommendedTargetTermId: FIXTURE_TERM_A,
        },
        {
          name: testNoiseName,
          category: 'general',
          quote: '沟通时的单元测试日常寒暄语。',
          relationLabel: '日常沟通',
          whyItMatters: '无独立业务规则',
          recommendedAction: 'REJECT',
        },
        {
          name: testUnverifiedName,
          category: 'finance',
          quote: '一段完全无源码命中且无预置模板的单元测试零实证生僻概念词。',
          relationLabel: '待考据概念',
          whyItMatters: '验证零实证兜底门禁与幂等锁',
          recommendedAction: 'GENERATE_TERM',
        },
      ],
    }),
    dissectTermSproutsWithHarness({
      sourceTermId: FIXTURE_TERM_B,
      runId: testRunId,
      operator: 'unit-test',
      customSprouts: [
        {
          name: testSynName,
          category: 'finance',
          quote: '订单拆单与单元测试信用资金池在额度扣减上紧密耦合。',
          relationLabel: '额度关联',
          whyItMatters: '跨词条共同提及的同义概念',
        },
      ],
    }),
  ]);
  assert.ok(enq1.enqueued.length + enq2.enqueued.length >= 4, '应成功入队新候选触手');

  const synCandAfterConcurrent = await lexiconStore.getCandidateByIdOrNameAsync(testSynName);
  assert.ok(synCandAfterConcurrent, '并发入队后应存在该候选触手');
  assert.equal(
    synCandAfterConcurrent.origins.length,
    2,
    '并发 ON CONFLICT DO UPDATE 必须原子保留两个父节点来源'
  );

  const [resolvedAlias1, resolvedAlias2] = await Promise.all([
    expandCandidateWithHarness(testSynName, {
      action: 'MERGE_AS_ALIAS',
      targetTermId: FIXTURE_TERM_A,
      operator: 'unit-test',
    }),
    expandCandidateWithHarness(testSynName2, {
      action: 'MERGE_AS_ALIAS',
      targetTermId: FIXTURE_TERM_A,
      operator: 'unit-test',
    }),
  ]);
  assert.equal(resolvedAlias1.candidate.status, 'MERGED_ALIAS');
  assert.equal(resolvedAlias2.candidate.status, 'MERGED_ALIAS');

  const termAfterAliases = await lexiconStore.getTermByIdAsync(FIXTURE_TERM_A);
  assert.ok(
    termAfterAliases?.aliases.includes(testSynName) &&
      termAfterAliases?.aliases.includes(testSynName2),
    '并发并入两个同义别名后，目标词条 aliases 必须同时保留两者'
  );

  const lookupAfter = await lexiconStore.lookupConceptAsync(testSynName, 'finance');
  assert.ok(lookupAfter.exactMatch, '并入别名后 lookupConceptAsync 应返回 exactMatch');
  assert.equal(lookupAfter.exactMatch?.termId, FIXTURE_TERM_A);
  assert.equal(lookupAfter.exactMatch?.matchedVia, 'alias');

  const updatedTerms = await lexiconStore.getTermsAsync();
  const updatedMatchers = buildKeywordMatchers(updatedTerms);
  const linkedSample = renderChatMarkdownHtml(
    `当账户开通${testSynName}后即可自动放行。`,
    updatedMatchers,
    FIXTURE_TERM_B
  );
  assert.ok(
    linkedSample.includes(`data-term-id="${FIXTURE_TERM_A}"`),
    '并入别名后全站出现该同义词处应自动渲染为指向目标词条的可点击双链'
  );

  const [genAttempt1, genAttempt2] = await Promise.all([
    expandCandidateWithHarness(testUnverifiedName, {
      action: 'GENERATE_TERM',
      publishImmediately: true,
      autoDissectNextLayer: true,
      operator: 'unit-test',
    }),
    expandCandidateWithHarness(testUnverifiedName, {
      action: 'GENERATE_TERM',
      publishImmediately: true,
      autoDissectNextLayer: true,
      operator: 'unit-test',
    }),
  ]);
  assert.ok(genAttempt1.affectedTerm && genAttempt2.affectedTerm);
  assert.equal(
    genAttempt1.affectedTerm.id,
    genAttempt2.affectedTerm.id,
    '并发或重复对同一候选执行 GENERATE_TERM 必须幂等返回同一个词条 ID'
  );
  assert.equal(
    genAttempt1.affectedTerm.meta?.status,
    'DRAFT',
    '零代码命中且无 AI 实证的兜底词条必须被 Value Gate 拦截保留为 DRAFT'
  );

  const resolvedNoise = await expandCandidateWithHarness(testNoiseName, {
    action: 'REJECT',
    operator: 'unit-test',
  });
  assert.equal(resolvedNoise.candidate.status, 'REJECTED');

  // 清理本次测试产生的数据
  const generatedUnverifiedId = genAttempt1.affectedTerm.id;
  await lexiconStore.deleteTermAsync(generatedUnverifiedId, 'unit-test-cleanup');
  await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id = $1`, [generatedUnverifiedId]);
  await pgExecute(
    `DELETE FROM lexicon_expansion_candidates WHERE normalized_name IN ($1, $2, $3, $4)`,
    [
      lexiconStore.normalizeConceptName(testSynName),
      lexiconStore.normalizeConceptName(testSynName2),
      lexiconStore.normalizeConceptName(testNoiseName),
      lexiconStore.normalizeConceptName(testUnverifiedName),
    ]
  );
  await pgExecute(`DELETE FROM lexicon_expansion_runs WHERE id = $1`, [testRunId]);
  await cleanupNeutralTestFixtures();
});

test('10. Harness 全链路增强闭环：噪音/技术词过滤、真实代码指针沉淀、多轮参谋搭桥与 auditLexiconQuality 自愈', async () => {
  for (const tid of ['ut-synth-quota-freeze', 'term-sprout-ut-polluted']) {
    await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id = $1`, [tid]);
    await pgExecute(`DELETE FROM lexicon_terms WHERE id = $1`, [tid]);
  }
  await lexiconStore.refreshFromPg();
  await setupNeutralTestFixtures();

  // (A) 验证 isNoiseOrTechCandidate 与 extractTextSproutCandidates 过滤表格角色列头与技术名词，放行中英文合法业务概念，且不继承 asop
  assert.equal(isNoiseOrTechCandidate('填报角色'), true, '表格列头「填报角色」应被拦截');
  assert.equal(isNoiseOrTechCandidate('复盘角色'), true, '表格列头「复盘角色」应被拦截');
  assert.equal(isNoiseOrTechCandidate('操作步骤'), true, '表格列头「操作步骤」应被拦截');
  assert.equal(isNoiseOrTechCandidate('分布式锁'), true, '技术词「分布式锁」应被拦截');
  assert.equal(isNoiseOrTechCandidate('OrderController'), true, '类名「OrderController」应被拦截');
  assert.equal(isNoiseOrTechCandidate('verifyAvailableQuota'), true, 'camelCase 方法名应被拦截');
  assert.equal(isNoiseOrTechCandidate('order_split_flag'), true, 'snake_case 字段名应被拦截');
  assert.equal(isNoiseOrTechCandidate('Redis'), true, '中间件「Redis」应被拦截');
  assert.equal(isNoiseOrTechCandidate('专项返利冻结'), false, '合法中文业务概念「专项返利冻结」应放行');
  assert.equal(isNoiseOrTechCandidate('Subscription'), false, '合法英文业务概念「Subscription」应放行');
  assert.equal(isNoiseOrTechCandidate('Invoice'), false, '合法英文业务概念「Invoice」应放行');
  assert.equal(isNoiseOrTechCandidate('SKU'), false, '合法英文业务概念「SKU」应放行');

  const extractedFromAsop = extractTextSproutCandidates(
    {
      id: 'asop-order-fulfillment',
      title: '订单履约端到端攻略',
      pinyin: 'DDLYGL',
      category: 'asop',
      aliases: [],
      summary: '涉及 **填报角色**、**分布式锁**、**Subscription** 与 **专项返利冻结** 的协同。',
      layman: { analogy: 'a', plain: '包含【复盘角色】、【Redis】与【跨仓调拨核销】。' },
      articleMarkdown: '通过 **专项返利冻结** 联动【跨仓调拨核销】。',
      relations: [],
      faqs: [],
    },
    []
  );
  const extractedNames = extractedFromAsop.map((c) => c.name);
  assert.ok(!extractedNames.includes('填报角色'), 'extractTextSproutCandidates 必须过滤「填报角色」');
  assert.ok(!extractedNames.includes('复盘角色'), 'extractTextSproutCandidates 必须过滤「复盘角色」');
  assert.ok(!extractedNames.includes('分布式锁'), 'extractTextSproutCandidates 必须过滤「分布式锁」');
  assert.ok(!extractedNames.includes('Redis'), 'extractTextSproutCandidates 必须过滤「Redis」');
  assert.ok(extractedNames.includes('专项返利冻结'), '应保留真实业务概念「专项返利冻结」');
  assert.ok(extractedNames.includes('Subscription'), '应保留真实英文业务概念「Subscription」');
  assert.ok(
    extractedFromAsop.every((c) => c.category !== 'asop'),
    '从 asop 父词条提取的子概念严禁盲目继承 asop 分类'
  );

  // (B) 验证 generateTermWithHarness 真实沉淀 engineering.pointers、生成 >=2 条排障 FAQ、净化代码泄露并织入双向血缘
  await lexiconStore.upsertCodeSnapshot({
    repo: 'demo-billing-service',
    branch: 'main',
    commitSha: 'a1b2c3d4',
    filePath: 'src/services/CreditPoolService.ts',
    lineRange: 'L10-L25',
    content: [
      '   10 | // 专项额度预占核验：校验客户可用授信余额与冻结阈值',
      '   11 | export class CreditPoolService {',
      '   12 |   public verifyAvailableQuota(accountId: string): boolean {',
      '   13 |     return hasActiveCreditSnapshot(accountId);',
      '   14 |   }',
      '   15 | }',
    ].join('\n'),
  });

  const synthTermId = 'ut-synth-quota-freeze';
  const generated = await generateTermWithHarness('单元测试额度预占核验', 'unit-test', {
    preferredId: synthTermId,
    contextSnippet: '调用 verifyAvailableQuota 执行额度校验',
    aiExplanation:
      '用于下单前锁定单元测试授信资金池额度（详见 `CreditPoolService.ts` @a1b2c3d4）。',
  });

  assert.equal(generated.grounded, true, '命中源码快照时 grounded 应为 true');
  assert.ok(
    (generated.term.engineering?.pointers || []).length >= 1,
    'generateTermWithHarness 必须将真实命中的源码写入 engineering.pointers，严禁为空数组'
  );
  assert.ok(
    (generated.term.engineering?.repos || []).includes('demo-billing-service'),
    'generateTermWithHarness 必须记录命中的 repo'
  );
  assert.ok(
    (generated.term.faqs || []).length >= 2,
    'generateTermWithHarness 必须生成至少 2 条排障/协同 FAQ'
  );
  assert.ok(
    !generated.term.articleMarkdown.includes('CreditPoolService.ts') &&
      !generated.term.articleMarkdown.includes('@a1b2c3d4'),
    '台前正文必须自动剥离泄露的代码文件名与 @commit 哈希'
  );
  assert.ok(
    (generated.term.relations || []).some((r) => r.target === FIXTURE_TERM_A),
    '正文提及既有词条「单元测试授信资金池」时应自动织入 relations'
  );
  const fixtureAAfterSynth = await lexiconStore.getTermByIdAsync(FIXTURE_TERM_A);
  assert.ok(
    (fixtureAAfterSynth?.relations || []).some((r) => r.target === synthTermId),
    '被提及的目标词条应自动补齐反向血缘关联'
  );

  // 验证显式传入 category='asop' 且同时携带 sourceTermId 时，必须保留 'asop' 分类（支持“采纳为流程攻略”入口）
  const explicitAsopDraft = await generateTermWithHarness(
    '单元测试跨仓履约端到端攻略',
    'unit-test',
    {
      preferredId: 'asop-ut-explicit-playbook',
      category: 'asop',
      sourceTermId: FIXTURE_TERM_A,
      persistImmediately: false,
    }
  );
  assert.equal(
    explicitAsopDraft.term.category,
    'asop',
    '显式传入 category=asop 时，即使携带 sourceTermId 也必须保持 asop 分类'
  );

  // (C) 验证 decodeJargonParagraph 多轮主语继承 + dataMappings 与 pointers 源码探针搭桥
  if (fixtureAAfterSynth) {
    await lexiconStore.saveTermAsync(
      {
        ...fixtureAAfterSynth,
        engineering: {
          repos: ['demo-billing-service'],
          pointers: [
            {
              repo: 'demo-billing-service',
              branch: 'main',
              commit: 'a1b2c3d4',
              path: 'src/services/CreditPoolService.ts',
              lines: 'L10-L15',
              desc: '授信资金池可用额度校验实现',
            },
          ],
          dataMappings: [
            {
              db: 'billing_db',
              table: 't_credit_account_pool',
              field: 'verifyAvailableQuota',
              rule: '可用授信池余额实时校验标识',
            },
          ],
        },
      },
      '补充测试映射与指针',
      'unit-test',
      fixtureAAfterSynth.meta?.revision
    );
  }

  // 验证仅继承父词条指针但自身无任何代码命中时，grounded 必须为 false（保留 DRAFT 待审，不触发误自动转正）
  const inheritedOnlyDraft = await generateTermWithHarness(
    '单元测试无源码命中子概念',
    'unit-test',
    {
      preferredId: 'ut-inherited-ptr-only',
      sourceTermId: FIXTURE_TERM_A,
      persistImmediately: false,
    }
  );
  assert.equal(
    inheritedOnlyDraft.grounded,
    false,
    '仅继承父词条指针而自身零代码命中时，grounded 必须保持 false 以防未核实词条自动转正'
  );
  assert.ok(
    (inheritedOnlyDraft.term.engineering?.pointers || []).length >= 1,
    '无直接代码命中时仍应继承父词条参考指针供人工审阅溯源'
  );

  const followUpRes = await decodeJargonParagraph({
    text: '那怎么改它的阈值配置？',
    enginePreference: 'llm-api',
    history: [
      {
        role: 'user',
        content: '为什么单元测试授信资金池会拦截客户的订单？',
      },
      {
        role: 'assistant',
        content: '因为单元测试授信资金池在余额不足时会触发拦截。',
      },
    ],
  });

  assert.ok(
    followUpRes.matchedTerms.some((m) => m.id === FIXTURE_TERM_A),
    '省略主语的连续追问必须通过多轮 history 继承召回前序核心词条「单元测试授信资金池」'
  );
  assert.ok(
    followUpRes.matchedFields.some(
      (mf) => mf.table === 't_credit_account_pool' && mf.field === 'verifyAvailableQuota'
    ),
    '召回词条的 dataMappings 必须自动搭桥注入 matchedFields'
  );
  assert.ok(
    followUpRes.codeHits.some(
      (h) =>
        h.repo === 'demo-billing-service' &&
        h.path === 'src/services/CreditPoolService.ts'
    ),
    '召回词条的 engineering.pointers 与 dataMappings 标识符必须搭桥命中源码证据'
  );

  // (D) 验证 auditLexiconQuality({ autoFix: true }) 一键巡检与自愈
  const pollutedId = 'term-sprout-ut-polluted';
  await lexiconStore.saveTermAsync(
    {
      id: pollutedId,
      title: '单元测试异常冲正机制',
      pinyin: 'DYCSYCCZ',
      category: 'asop', // 故意错误设置为 asop
      aliases: [],
      summary: '在 OrderSplitService.java @deadbeef1234 中执行的冲正规则。',
      layman: {
        analogy: '就像超市退货后原路退回卡内额度。',
        plain: '触发冲正时会联动单元测试订单拆单回滚。',
      },
      articleMarkdown: [
        '## 核心规则',
        '',
        '通过 `OrderSplitService.java` (@deadbeef1234) 校验并联动单元测试订单拆单状态。',
        '```mermaid',
        'flowchart LR',
        'A[发起冲正(预审/复核)] --> B[额度回滚]',
        '```',
      ].join('\n'),
      engineering: { repos: [], pointers: [], dataMappings: [] },
      relations: [], // 故意漏掉与 FIXTURE_TERM_B（单元测试订单拆单）的关联
      faqs: [],
      meta: {
        updatedAt: '2026-11-08',
        maintainedBy: 'unit-test',
        status: 'PUBLISHED',
        revision: 1,
      },
    },
    '注入待自愈脏词条',
    'unit-test'
  );

  const auditReport = await auditLexiconQuality({
    autoFix: true,
    operator: 'unit-test',
  });

  assert.ok(
    auditReport.codeLeakageTerms.some((t) => t.id === pollutedId && t.fixed),
    'auditLexiconQuality 应检出并修复代码文件名/Commit哈希泄露'
  );
  assert.ok(
    auditReport.categoryMismatches.some(
      (t) => t.id === pollutedId && t.fromCategory === 'asop' && t.toCategory !== 'asop' && t.fixed
    ),
    'auditLexiconQuality 应检出并纠偏误设为 asop 的子词条分类'
  );
  assert.ok(
    auditReport.unlinkedMentions.some(
      (u) => u.sourceId === pollutedId && u.mentionedTargetId === FIXTURE_TERM_B && u.fixed
    ),
    'auditLexiconQuality 应检出并自动挂接正文提及但未建立 relations 的词条'
  );

  const healedTerm = await lexiconStore.getTermByIdAsync(pollutedId);
  assert.ok(healedTerm, '自愈后词条应存在');
  assert.equal(
    healedTerm.meta?.revision,
    2,
    'auditLexiconQuality 自愈写回必须携带 expectedRevision 并原子递增 revision'
  );
  assert.notEqual(healedTerm.category, 'asop', '自愈后分类不应再为 asop');
  assert.ok(
    !healedTerm.summary.includes('OrderSplitService.java') &&
      !healedTerm.articleMarkdown.includes('@deadbeef1234'),
    '自愈后台前文本不应包含代码文件名或 Commit 哈希'
  );
  assert.ok(
    healedTerm.articleMarkdown.includes('A["发起冲正(预审/复核)"]'),
    'sanitizeBusinessProse 应自动为含括号/斜杠的 Mermaid 节点补齐双引号'
  );
  assert.ok(
    (healedTerm.relations || []).some((r) => r.target === FIXTURE_TERM_B),
    '自愈后应自动补齐指向「单元测试订单拆单」的血缘关系'
  );
  const healedTargetB = await lexiconStore.getTermByIdAsync(FIXTURE_TERM_B);
  assert.ok(
    (healedTargetB?.relations || []).some((r) => r.target === pollutedId),
    '自愈后目标词条也应拥有反向血缘链接（双向闭环）'
  );

  // 验证携带过期 expectedRevision 保存词条时触发 REVISION_CONFLICT 乐观锁保护，绝不静默覆盖并发修改
  await assert.rejects(
    async () => {
      await lexiconStore.saveTermAsync(
        {
          ...healedTerm,
          summary: '试图用过期版本号覆盖并发修改',
        },
        '过期版本写回测试',
        'unit-test',
        1 // 当前实际版本已是 2，传入 1 必须抛出冲突
      );
    },
    /版本冲突 \(409\)/,
    '传入过期 expectedRevision 时必须触发 409 版本冲突乐观锁拦截'
  );

  // 清理本次测试新增数据
  for (const tid of [synthTermId, pollutedId]) {
    await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id = $1`, [tid]);
    await pgExecute(`DELETE FROM lexicon_terms WHERE id = $1`, [tid]);
  }
  await cleanupNeutralTestFixtures();
});
