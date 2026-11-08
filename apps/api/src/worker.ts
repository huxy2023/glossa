import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CODEBASE_PRD_ROOT,
  grepPrdCode,
  readPrdFile,
  inspectTermsDrift,
} from './services/codebase-probe.js';
import {
  dissectTermSproutsWithHarness,
  expandCandidateWithHarness,
  decodeJargonParagraph,
} from './services/agent-harness.js';
import { lexiconStore } from './services/lexicon-store.js';

export const DEFAULT_WORKER_ID =
  process.env.LEXICON_WORKER_ID || `worker_${os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_')}`;

/**
 * 方案 A：内网源码探针 Worker 单轮执行器
 * 1. 发送内网节点心跳至 CloudBase PostgreSQL (lexicon_worker_nodes)
 * 2. 可选：将所有词条关联的 .codebase-prd 真实源码切片同步至 lexicon_code_snapshots
 * 3. 消费公网端投递的实时源码检索 (GREP_CODE)、文件读取 (READ_FILE)、漂移巡检 (INSPECT_DRIFT) 任务
 */
export async function runWorkerCycle(options?: {
  workerId?: string;
  syncAllTermPointers?: boolean;
  maxTasks?: number;
}): Promise<{
  workerId: string;
  localWorktreeReady: boolean;
  repoCount: number;
  syncedSnapshots: number;
  processedTasks: number;
}> {
  const workerId = options?.workerId || DEFAULT_WORKER_ID;
  const localWorktreeReady = fs.existsSync(CODEBASE_PRD_ROOT);
  let repoCount = 0;

  if (localWorktreeReady) {
    try {
      repoCount = fs
        .readdirSync(CODEBASE_PRD_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;
    } catch {
      repoCount = 0;
    }
  }

  if (!localWorktreeReady || repoCount === 0) {
    return {
      workerId,
      localWorktreeReady: false,
      repoCount: 0,
      syncedSnapshots: 0,
      processedTasks: 0,
    };
  }

  await lexiconStore.registerWorkerHeartbeat({
    workerId,
    hostname: os.hostname(),
    codebaseRoot: CODEBASE_PRD_ROOT,
    repoCount,
  });

  let syncedSnapshots = 0;
  const syncTermPointersHelper = async () => {
    const terms = await lexiconStore.getTermsAsync();
    for (const term of terms) {
      for (const ptr of term.engineering?.pointers || []) {
        const res = await readPrdFile({
          repo: ptr.repo,
          filePath: ptr.path,
          lines: ptr.lines,
          commit: ptr.commit,
          allowRemoteWorker: false,
        });
        if (res && res.source === 'worktree-git') {
          await lexiconStore.upsertCodeSnapshot({
            repo: res.repo,
            branch: res.branch,
            commitSha: res.resolvedCommit,
            filePath: res.path,
            lineRange: `L${res.startLine}-L${res.endLine}`,
            content: res.content,
          });
          syncedSnapshots++;
        }
      }
    }
  };

  if (options?.syncAllTermPointers) {
    await syncTermPointersHelper();
  }

  let processedTasks = 0;
  const maxTasks = options?.maxTasks ?? 10;

  for (let i = 0; i < maxTasks; i++) {
    const task = await lexiconStore.claimNextWorkerTask(workerId);
    if (!task) break;

    try {
      if (task.taskType === 'GREP_CODE') {
        const q = String(task.payload?.query || '').trim();
        const repoFilter = task.payload?.repoFilter
          ? String(task.payload.repoFilter)
          : undefined;
        const limit = Number(task.payload?.limit || 15);
        const hits = await grepPrdCode(q, repoFilter, limit, false);

        // 自动将命中的前 4 处源码上下文窗口同步入 CloudBase PG 快照表，实现公网划词/检索后的快照自生长
        if (localWorktreeReady) {
          for (const h of hits.slice(0, 4)) {
            const winStart = Math.max(1, h.line - 10);
            const winEnd = h.line + 25;
            const slice = await readPrdFile({
              repo: h.repo,
              filePath: h.path,
              lines: `L${winStart}-L${winEnd}`,
              commit: h.commit,
              allowRemoteWorker: false,
            });
            if (slice && slice.source === 'worktree-git') {
              await lexiconStore.upsertCodeSnapshot({
                repo: slice.repo,
                branch: slice.branch,
                commitSha: slice.resolvedCommit,
                filePath: slice.path,
                lineRange: `L${slice.startLine}-L${slice.endLine}`,
                content: slice.content,
              });
              syncedSnapshots++;
            }
          }
        }

        await lexiconStore.completeWorkerTask(task.id, workerId, hits);
      } else if (task.taskType === 'READ_FILE') {
        const res = await readPrdFile({
          repo: String(task.payload?.repo || ''),
          filePath: String(task.payload?.filePath || ''),
          lines: task.payload?.lines ? String(task.payload.lines) : undefined,
          commit: task.payload?.commit ? String(task.payload.commit) : undefined,
          allowRemoteWorker: false,
        });

        if (res && res.source === 'worktree-git') {
          await lexiconStore.upsertCodeSnapshot({
            repo: res.repo,
            branch: res.branch,
            commitSha: res.resolvedCommit,
            filePath: res.path,
            lineRange: `L${res.startLine}-L${res.endLine}`,
            content: res.content,
          });
          syncedSnapshots++;
        }

        await lexiconStore.completeWorkerTask(
          task.id,
          workerId,
          res,
          res ? undefined : '内网 .codebase-prd 未找到对应文件或行号区间'
        );
      } else if (task.taskType === 'INSPECT_DRIFT') {
        if (task.payload?.syncAllTermPointers) {
          await syncTermPointersHelper();
        }
        const terms = await lexiconStore.getTermsAsync();
        const report = await inspectTermsDrift(terms);
        await lexiconStore.completeWorkerTask(task.id, workerId, {
          ...report,
          syncedSnapshots,
        });
      } else if (task.taskType === 'HARNESS_DISSECT') {
        const res = await dissectTermSproutsWithHarness(task.payload || {});
        await lexiconStore.completeWorkerTask(task.id, workerId, res);
      } else if (task.taskType === 'HARNESS_RESOLVE') {
        const res = await expandCandidateWithHarness(
          String(task.payload?.candidateId || ''),
          task.payload?.options || {}
        );
        await lexiconStore.completeWorkerTask(task.id, workerId, res);
      } else if (task.taskType === 'HARNESS_CONSULT') {
        const res = await decodeJargonParagraph({
          text: String(task.payload?.text || ''),
          userId: task.payload?.userId ? String(task.payload.userId) : undefined,
          sessionId: task.payload?.sessionId ? String(task.payload.sessionId) : undefined,
          history: Array.isArray(task.payload?.history) ? task.payload.history : undefined,
          skillId: task.payload?.skillId,
          enginePreference: task.payload?.enginePreference || 'codex-cli',
          allowWorkerDelegation: false,
        });
        await lexiconStore.completeWorkerTask(task.id, workerId, res);
      } else {
        await lexiconStore.completeWorkerTask(
          task.id,
          workerId,
          null,
          `不支持的任务类型: ${task.taskType}`
        );
      }
      processedTasks++;
    } catch (err: any) {
      await lexiconStore.completeWorkerTask(
        task.id,
        workerId,
        null,
        err?.message || 'Worker 任务执行异常'
      );
    }
  }

  return {
    workerId,
    localWorktreeReady,
    repoCount,
    syncedSnapshots,
    processedTasks,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const once = process.argv.includes('--once');
  (async () => {
    console.log(
      `🛰️ [Glossa Worker] 启动内网源码探针与 Harness Worker (${DEFAULT_WORKER_ID})...`
    );
    const first = await runWorkerCycle({ syncAllTermPointers: true, maxTasks: 20 });
    console.log(
      `✅ 初始同步完成: 本地工作区就绪=${first.localWorktreeReady} (${first.repoCount}仓), 同步快照=${first.syncedSnapshots}处, 消费任务=${first.processedTasks}个`
    );
    if (once) {
      process.exit(0);
    }
    console.log(`🔄 进入常驻轮询模式 (每 2.5s 轮询 PostgreSQL 任务队列)...`);
    setInterval(async () => {
      try {
        const res = await runWorkerCycle({ syncAllTermPointers: false, maxTasks: 10 });
        if (res.processedTasks > 0) {
          console.log(
            `⚡ [Worker] 已处理公网源码检索/读取任务 ${res.processedTasks} 个, 新增快照 ${res.syncedSnapshots} 处`
          );
        }
      } catch (err: any) {
        console.error(`⚠️ [Worker] 轮询异常:`, err?.message || err);
      }
    }, 2500);
  })();
}
