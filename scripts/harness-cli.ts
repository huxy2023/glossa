import { lexiconStore } from '../apps/api/src/services/lexicon-store.js';
import { pgExecute } from '../apps/api/src/services/pg-database.js';
import {
  dissectTermSproutsWithHarness,
  expandCandidateWithHarness,
  runSproutWaveWithHarness,
} from '../apps/api/src/services/agent-harness.js';
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
    const sourceTermId = args[1] || parseArgFlag(args, '--term') || allTerms[0]?.id || '';
    if (!sourceTermId) {
      console.error('用法: pnpm glossa dissect <termId>');
      process.exit(1);
    }
    const res = await dissectTermSproutsWithHarness({
      sourceTermId,
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

  console.error(
    [
      'Glossa AI Agent Harness CLI (双入口主控端)',
      '可用命令:',
      '  pnpm glossa status [--term <termId>]                 查看繁衍记忆账本与待裂变触手队列',
      '  pnpm glossa lookup "<概念名>" [--category <cat>]     查重并召回 Top-5 相似词条（区分同义别名 vs 新词分叉）',
      '  pnpm glossa dissect <termId>                         顺藤摸瓜剖析指定词条，将候选触手写入记忆账本',
      '  pnpm glossa resolve <candId或名称> [--action ...]    执行三路决议（GENERATE_TERM / MERGE_AS_ALIAS / REJECT）',
      '  pnpm glossa run-wave [seedTermId]                    从引爆点执行有界 BFS 触手裂变与同义词自动归并',
    ].join('\n')
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('Harness CLI 执行异常:', err?.message || err);
  process.exit(1);
});
