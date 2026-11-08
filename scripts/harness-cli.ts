import { lexiconStore } from '../apps/api/src/services/lexicon-store.js';
import { pgExecute } from '../apps/api/src/services/pg-database.js';
import { inspectTermsDrift } from '../apps/api/src/services/codebase-probe.js';
import {
  generateTermWithHarness,
  decodeJargonParagraph,
  dissectTermSproutsWithHarness,
  expandCandidateWithHarness,
  runSproutWaveWithHarness,
  auditLexiconQuality,
} from '../apps/api/src/services/agent-harness.js';
import type { AdvisorSkillId } from '../apps/api/src/services/advisor-skills.js';
import type { CandidateAction, CategoryId } from '@glossa/schema';

function parseArgFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';

  if (cmd === 'reset') {
    await lexiconStore.ensureInitialized();
    const dropTermId = parseArgFlag(args, '--term');
    if (dropTermId) {
      await lexiconStore.deleteTermAsync(dropTermId, 'antigravity-cli');
      await pgExecute(`DELETE FROM lexicon_term_revisions WHERE term_id = $1`, [dropTermId]);
    }
    await pgExecute('DELETE FROM lexicon_expansion_candidates');
    await pgExecute('DELETE FROM lexicon_expansion_runs');
    console.log(
      JSON.stringify(
        { ok: true, command: 'reset', message: '已清空繁衍记忆账本与波次记录' },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (cmd === 'status' || cmd === 'overview') {
    const termId = parseArgFlag(args, '--term');
    const overview = await lexiconStore.getHarnessOverviewAsync({
      sourceTermId: termId,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'status',
          stats: overview.stats,
          runs: overview.runs.slice(0, 5),
          candidates: (termId ? overview.termCandidates : overview.candidates).slice(0, 25),
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (cmd === 'list') {
    const terms = await lexiconStore.getTermsAsync();
    const categories = lexiconStore.getCategories();
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'list',
          totalTerms: terms.length,
          categories,
          terms: terms.map((t) => ({
            id: t.id,
            title: t.title,
            category: t.category,
            status: t.meta?.status || 'PUBLISHED',
            pointersCount: (t.engineering?.pointers || []).length,
            relationsCount: (t.relations || []).length,
            faqsCount: (t.faqs || []).length,
          })),
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (cmd === 'generate') {
    const title = args[1] || parseArgFlag(args, '--title') || '';
    const category = parseArgFlag(args, '--category') as CategoryId | undefined;
    const preferredId = parseArgFlag(args, '--id');
    const contextSnippet = parseArgFlag(args, '--context');
    const aiExplanation = parseArgFlag(args, '--explanation');
    const sourceTermId = parseArgFlag(args, '--source');
    const publish = args.includes('--publish');
    if (!title) {
      console.error(
        '用法: pnpm glossa generate "<词条或攻略名称>" [--category core|asop|...] [--id <termId>] [--context "<上下文或代码标识符>"] [--publish]'
      );
      process.exit(1);
    }
    const res = await generateTermWithHarness(title, 'antigravity-cli', {
      preferredId,
      category,
      contextSnippet,
      aiExplanation,
      sourceTermId,
    });
    let finalTerm = res.term;
    if (publish && res.grounded && finalTerm.meta?.status !== 'PUBLISHED') {
      finalTerm = await lexiconStore.saveTermAsync(
        {
          ...finalTerm,
          meta: {
            ...(finalTerm.meta || {
              updatedAt: new Date().toISOString().slice(0, 10),
              maintainedBy: 'antigravity-cli',
              revision: 1,
            }),
            status: 'PUBLISHED',
          },
        },
        'CLI 源码实证通过并发布词条',
        'antigravity-cli',
        finalTerm.meta?.revision
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'generate',
          grounded: res.grounded,
          hitCount: res.hitCount,
          trace: res.trace,
          term: finalTerm,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (cmd === 'consult') {
    const text = args[1] || parseArgFlag(args, '--text') || '';
    const skillId = parseArgFlag(args, '--skill') as AdvisorSkillId | undefined;
    if (!text) {
      console.error(
        '用法: pnpm glossa consult "<业务问题或需求描述>" [--skill troubleshooting|solution-design|metrics-analytics|jargon-demystify]'
      );
      process.exit(1);
    }
    const res = await decodeJargonParagraph({
      text,
      skillId,
      enginePreference: 'llm-api',
    });
    console.log(JSON.stringify({ ok: true, command: 'consult', ...res }, null, 2));
    process.exit(0);
  }

  if (cmd === 'lookup') {
    const query = args[1] || parseArgFlag(args, '--query') || '';
    const category = parseArgFlag(args, '--category') as CategoryId | undefined;
    if (!query) {
      console.error('用法: pnpm glossa lookup "<概念名称>" [--category core]');
      process.exit(1);
    }
    const res = await lexiconStore.lookupConceptAsync(query, category);
    console.log(JSON.stringify({ ok: true, command: 'lookup', ...res }, null, 2));
    process.exit(0);
  }

  if (cmd === 'dissect') {
    const allTerms = await lexiconStore.getTermsAsync();
    const rawText = parseArgFlag(args, '--text');
    const sourceTitle = parseArgFlag(args, '--title');
    const sourceTermId =
      (!args[1]?.startsWith('--') ? args[1] : undefined) ||
      parseArgFlag(args, '--term') ||
      (!rawText ? allTerms[0]?.id : undefined) ||
      '';
    if (!sourceTermId && !rawText) {
      console.error(
        '用法: pnpm glossa dissect <termId> 或 pnpm glossa dissect --text "<业务规则文本>" [--title "<来源标题>"]'
      );
      process.exit(1);
    }
    const res = await dissectTermSproutsWithHarness({
      sourceTermId: sourceTermId || undefined,
      rawText,
      sourceTitle,
      operator: 'antigravity-cli',
    });
    console.log(JSON.stringify({ ok: true, command: 'dissect', ...res }, null, 2));
    process.exit(0);
  }

  if (cmd === 'resolve') {
    const candidateId = args[1] || parseArgFlag(args, '--id') || '';
    const action = (parseArgFlag(args, '--action') || '') as CandidateAction | '';
    const targetTermId = parseArgFlag(args, '--target');
    const decisionNote = parseArgFlag(args, '--note');
    const customJson = parseArgFlag(args, '--json');
    if (!candidateId) {
      console.error(
        '用法: pnpm harness resolve <candidateId或概念名称> [--action MERGE_AS_ALIAS|GENERATE_TERM|REJECT] [--target <termId>] [--note "<说明>"]'
      );
      process.exit(1);
    }
    const customTerm = customJson ? JSON.parse(customJson) : undefined;
    const res = await expandCandidateWithHarness(candidateId, {
      action: action || undefined,
      targetTermId,
      decisionNote,
      customTerm,
      publishImmediately: true,
      autoDissectNextLayer: args.includes('--next-layer'),
      operator: 'antigravity-cli',
    });
    console.log(JSON.stringify({ ok: true, command: 'resolve', ...res }, null, 2));
    process.exit(0);
  }

  if (cmd === 'run-wave') {
    const allTerms = await lexiconStore.getTermsAsync();
    const seedTermId = args[1] || parseArgFlag(args, '--seed') || allTerms[0]?.id || '';
    if (!seedTermId) {
      console.error('用法: pnpm glossa run-wave <seedTermId>');
      process.exit(1);
    }
    const maxDepth = Number(parseArgFlag(args, '--depth') || 2);
    const maxDrafts = Number(parseArgFlag(args, '--max-drafts') || 5);
    const res = await runSproutWaveWithHarness({
      seedTermId,
      maxDepth,
      maxDrafts,
      autoResolve: !args.includes('--no-auto-resolve'),
      operator: 'antigravity-cli',
    });
    console.log(JSON.stringify({ ok: true, command: 'run-wave', ...res }, null, 2));
    process.exit(0);
  }

  if (cmd === 'audit') {
    const autoFix = args.includes('--fix') || args.includes('--auto-fix');
    const res = await auditLexiconQuality({
      autoFix,
      operator: 'antigravity-cli',
    });
    console.log(JSON.stringify({ ok: true, command: 'audit', ...res }, null, 2));
    process.exit(0);
  }

  if (cmd === 'drift') {
    const termId = args[1] || parseArgFlag(args, '--term');
    const allTerms = await lexiconStore.getTermsAsync();
    const targetTerms = termId
      ? allTerms.filter((t) => t.id === termId)
      : allTerms;
    const driftSummary = await inspectTermsDrift(targetTerms);
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'drift',
          ...driftSummary,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  console.error(
    [
      'Glossa AI Agent Harness CLI (双入口主控端)',
      '可用命令:',
      '  pnpm glossa status [--term <termId>]                 查看繁衍记忆账本与待裂变触手队列',
      '  pnpm glossa list                                     查看当前词库分类与已收录词条概览',
      '  pnpm glossa lookup "<概念名>" [--category <cat>]     查重并召回 Top-5 相似词条（区分同义别名 vs 新词分叉）',
      '  pnpm glossa generate "<名称>" [--category ...]       基于源码探针考据合成新词条或端到端攻略草稿',
      '  pnpm glossa dissect <termId> [--text "<种子文本>"]   顺藤摸瓜剖析指定词条或种子文本，将候选触手写入记忆账本',
      '  pnpm glossa resolve <candId或名称> [--action ...]    执行三路决议（GENERATE_TERM / MERGE_AS_ALIAS / REJECT）',
      '  pnpm glossa run-wave [seedTermId]                    从引爆点执行有界 BFS 触手裂变与同义词自动归并',
      '  pnpm glossa consult "<业务问题>" [--skill ...]       调用业务参谋引擎（词典召回 + 源码切片 + 技能推演）',
      '  pnpm glossa audit [--fix]                            执行词库质量巡检与自动修复（台前净化/分类纠偏/双向血缘）',
      '  pnpm glossa drift [termId]                           检查词条关联的源码指针与当前工作区 Git Commit 是否漂移',
    ].join('\n')
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('Harness CLI 执行异常:', err?.message || err);
  process.exit(1);
});
