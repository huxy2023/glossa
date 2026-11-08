import './load-dotenv.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TermEntry } from '@glossa/schema';
import { pgQuery, pgExecute } from './pg-database.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
export const CODEBASE_PRD_ROOT = path.resolve(
  process.env.GLOSSA_WORKSPACE_ROOT ||
    process.env.LEXICON_WORKSPACE_ROOT ||
    path.join(WORKSPACE_ROOT, '.codebase-prd')
);

export interface RepoCommitInfo {
  name: string;
  group?: string;
  ref?: string;
  branch: string;
  commit: string;
  commitFull?: string;
  committedAt: string;
}

export interface CodeSearchHit {
  repo: string;
  branch: string;
  commit: string;
  path: string;
  line: number;
  snippet: string;
}

export interface CodeReadResult {
  repo: string;
  branch: string;
  requestedCommit?: string;
  resolvedCommit: string;
  headCommit: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  driftStatus: 'synced' | 'drifted' | 'error';
  diffStat?: string;
  source: 'worktree-git' | 'db-snapshot';
}

const SAFE_REPO_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_COMMIT_RE = /^[a-fA-F0-9]{6,40}$/;

async function hasOnlineIntranetWorker(): Promise<boolean> {
  try {
    const rows = await pgQuery(
      `SELECT last_heartbeat_at, status FROM lexicon_worker_nodes WHERE status = 'ONLINE' ORDER BY last_heartbeat_at DESC LIMIT 1`
    );
    if (rows.length === 0) return false;
    const hbMs = new Date(rows[0].last_heartbeat_at || 0).getTime();
    return Number.isFinite(hbMs) && Date.now() - hbMs <= 90_000;
  } catch {
    return false;
  }
}

async function dispatchTaskToIntranetWorker(
  taskType: 'GREP_CODE' | 'READ_FILE' | 'INSPECT_DRIFT',
  payload: Record<string, any>,
  timeoutMs = 4500
): Promise<any | null> {
  if (!(await hasOnlineIntranetWorker())) return null;
  try {
    const id = `wtask_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const nowIso = new Date().toISOString();
    await pgExecute(
      `INSERT INTO lexicon_worker_tasks (id, task_type, status, payload_json, requester, created_at)
       VALUES ($1, $2, 'PENDING', $3, 'cloud-probe', $4)`,
      [id, taskType, JSON.stringify(payload), nowIso]
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await pgQuery(
        `SELECT status, result_json FROM lexicon_worker_tasks WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (rows.length === 0) return null;
      if (rows[0].status === 'COMPLETED' && rows[0].result_json) {
        return JSON.parse(rows[0].result_json);
      }
      if (rows[0].status === 'FAILED') return null;
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch {
    // fallback to PG snapshot query
  }
  return null;
}

let cachedScannedManifest: Record<string, RepoCommitInfo> | null = null;

export function getPrdManifest(): Record<string, RepoCommitInfo> {
  const manifestPath = path.join(CODEBASE_PRD_ROOT, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (raw.repos && Object.keys(raw.repos).length > 0) {
        return raw.repos;
      }
    } catch {
      // fall through to dynamic workspace scan
    }
  }

  if (cachedScannedManifest) {
    return cachedScannedManifest;
  }

  const discovered: Record<string, RepoCommitInfo> = {};
  if (fs.existsSync(CODEBASE_PRD_ROOT)) {
    try {
      const entries = fs.readdirSync(CODEBASE_PRD_ROOT, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (!SAFE_REPO_RE.test(entry.name)) continue;
        const repoDir = path.join(CODEBASE_PRD_ROOT, entry.name);
        if (!fs.existsSync(path.join(repoDir, '.git'))) continue;
        let commit = 'HEAD';
        let branch = 'main';
        try {
          commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
            cwd: repoDir,
            encoding: 'utf8',
            timeout: 1500,
          }).trim();
          branch =
            execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: repoDir,
              encoding: 'utf8',
              timeout: 1500,
            }).trim() || 'main';
        } catch {
          // ignore
        }
        discovered[entry.name] = {
          name: entry.name,
          branch,
          commit,
          committedAt: new Date().toISOString(),
        };
      }
    } catch {
      // ignore
    }
  }
  cachedScannedManifest = discovered;
  return discovered;
}

/**
 * 严格校验仓库名与仓库内相对路径，彻底阻断路径穿越 (Path Traversal) 与越界读取
 */
export function validateRepoAndRelativePath(
  repo: string,
  rawFilePath: string
): { cleanRepo: string; cleanPath: string } | null {
  const cleanRepo = String(repo || '').trim();
  if (!SAFE_REPO_RE.test(cleanRepo)) return null;

  const manifest = getPrdManifest();
  if (Object.keys(manifest).length > 0 && !manifest[cleanRepo]) return null;

  const withoutHash = String(rawFilePath || '').split('#')[0].trim().replace(/^\.\//, '');
  if (!withoutHash || withoutHash.startsWith('/') || withoutHash.includes('\0')) {
    return null;
  }

  const normalized = path.posix.normalize(withoutHash.replace(/\\/g, '/'));
  if (
    normalized.startsWith('..') ||
    normalized.includes('/../') ||
    normalized === '.' ||
    normalized.includes('docs/') ||
    normalized.includes('docs-site/') ||
    normalized.endsWith('.md')
  ) {
    return null;
  }

  const repoRoot = path.resolve(CODEBASE_PRD_ROOT, cleanRepo);
  const absCandidate = path.resolve(repoRoot, normalized);
  if (!absCandidate.startsWith(repoRoot + path.sep)) {
    return null;
  }

  return { cleanRepo, cleanPath: normalized };
}

/**
 * 在 .codebase-prd 纯代码库（或 PostgreSQL lexicon_code_snapshots 表）中执行纯代码检索
 */
export async function grepPrdCode(
  query: string,
  repoFilter?: string,
  limit = 15,
  allowRemoteWorker = true
): Promise<CodeSearchHit[]> {
  const q = String(query || '').trim();
  if (!q) return [];

  const manifest = getPrdManifest();
  if (repoFilter && !SAFE_REPO_RE.test(repoFilter)) {
    return [];
  }
  if (repoFilter && Object.keys(manifest).length > 0 && !manifest[repoFilter]) {
    return [];
  }
  const targetRepos = repoFilter ? [repoFilter] : Object.keys(manifest);
  const hits: CodeSearchHit[] = [];

  if (fs.existsSync(CODEBASE_PRD_ROOT)) {
    if (!repoFilter) {
      try {
        const out = execFileSync(
          'rg',
          [
            '--no-heading',
            '-n',
            '--no-ignore',
            '--max-count',
            '2',
            '-g',
            '!**/docs/**',
            '-g',
            '!**/docs-site/**',
            '-g',
            '!**/*.md',
            '-g',
            '!**/scripts/**',
            '-g',
            '!**/generated/**',
            '-g',
            '!**/target/**',
            '-g',
            '!**/dist/**',
            '-g',
            '!**/build/**',
            '-g',
            '!**/node_modules/**',
            '-g',
            '!**/.git/**',
            q,
            '.',
          ],
          { cwd: CODEBASE_PRD_ROOT, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
        );

        for (const line of out.split('\n')) {
          if (!line.trim() || hits.length >= limit) continue;
          const match = line.match(/^(?:\.\/)?([^/]+)\/([^:]+):(\d+):(.*)$/);
          if (match) {
            const repo = match[1];
            if (!manifest[repo]) continue;
            hits.push({
              repo,
              branch: manifest[repo]?.branch || 'prd',
              commit: manifest[repo]?.commit || 'unknown',
              path: match[2],
              line: Number(match[3]),
              snippet: match[4].trim().slice(0, 220),
            });
          }
        }
      } catch {
        // Fallback or no match
      }
    } else {
      for (const repo of targetRepos) {
        if (hits.length >= limit) break;
        const repoDir = path.join(CODEBASE_PRD_ROOT, repo);
        if (!fs.existsSync(repoDir)) continue;

        try {
          const out = execFileSync(
            'rg',
            [
              '--no-heading',
              '-n',
              '--no-ignore',
              '--max-count',
              '5',
              '-g',
              '!**/docs/**',
              '-g',
              '!**/docs-site/**',
              '-g',
              '!**/*.md',
              '-g',
              '!**/scripts/**',
              '-g',
              '!**/generated/**',
              '-g',
              '!**/target/**',
              '-g',
              '!**/dist/**',
              '-g',
              '!**/build/**',
              '-g',
              '!**/node_modules/**',
              '-g',
              '!**/.git/**',
              q,
              '.',
            ],
            { cwd: repoDir, encoding: 'utf8', timeout: 4000 }
          );

          for (const line of out.split('\n')) {
            if (!line.trim() || hits.length >= limit) continue;
            const match = line.match(/^(?:\.\/)?([^:]+):(\d+):(.*)$/);
            if (match) {
              hits.push({
                repo,
                branch: manifest[repo]?.branch || 'prd',
                commit: manifest[repo]?.commit || 'unknown',
                path: match[1],
                line: Number(match[2]),
                snippet: match[3].trim().slice(0, 220),
              });
            }
          }
        } catch {
          // No match in this repo
        }
      }
    }
  } else if (allowRemoteWorker) {
    // 方案 A：公网云函数无本地 .codebase-prd 时，若内网 Worker 在线则实时派发 GREP_CODE 任务至内网机器检索 38 仓
    const remoteHits = await dispatchTaskToIntranetWorker('GREP_CODE', {
      query: q,
      repoFilter,
      limit,
    });
    if (Array.isArray(remoteHits)) {
      for (const rh of remoteHits) {
        if (hits.length < limit) hits.push(rh);
      }
    }
  }

  // 云端 SCF 无本地 Worktree 或补充匹配时，真实查询 PostgreSQL lexicon_code_snapshots 表
  if (hits.length < limit) {
    const lowerQ = q.toLowerCase();
    const likePattern = `%${lowerQ}%`;
    const dbRows = repoFilter
      ? await pgQuery(
          `SELECT repo, branch, commit_sha, file_path, line_range, content
           FROM lexicon_code_snapshots
           WHERE repo = $1 AND (LOWER(content) LIKE $2 OR LOWER(file_path) LIKE $2)
           LIMIT $3`,
          [repoFilter, likePattern, limit]
        )
      : await pgQuery(
          `SELECT repo, branch, commit_sha, file_path, line_range, content
           FROM lexicon_code_snapshots
           WHERE LOWER(content) LIKE $1 OR LOWER(file_path) LIKE $1
           LIMIT $2`,
          [likePattern, limit]
        );

    for (const row of dbRows) {
      if (hits.length >= limit) break;
      const snapRepo = String(row.repo || '');
      const snapPath = String(row.file_path || '');
      const snapContent = String(row.content || '');
      const matchedLine =
        snapContent
          .split('\n')
          .find((l) => l.toLowerCase().includes(lowerQ)) ||
        snapContent.split('\n')[0] ||
        '';
      const lineNumMatch = matchedLine.match(/^\s*(\d+)\s*\|/);
      const lineNum = lineNumMatch ? Number(lineNumMatch[1]) : 1;
      const alreadyExists = hits.some(
        (h) => h.repo === snapRepo && h.path === snapPath && h.line === lineNum
      );
      if (!alreadyExists) {
        hits.push({
          repo: snapRepo,
          branch: row.branch || manifest[snapRepo]?.branch || 'prd',
          commit: row.commit_sha || manifest[snapRepo]?.commit || 'unknown',
          path: snapPath,
          line: lineNum,
          snippet: matchedLine.replace(/^\s*\d+\s*\|\s*/, '').trim().slice(0, 220),
        });
      }
    }
  }

  return hits;
}

/**
 * 读取 .codebase-prd 中指定仓库、指定文件与行号范围的真实代码
 * 若本地无 Git Worktree，则按 repo + file_path + commit_sha + 行号范围真实查询 PostgreSQL lexicon_code_snapshots；
 * 若请求行号范围超出快照覆盖范围，明确返回 null (不可用)，且在无本地 Git 时绝不伪标 synced。
 */
export async function readPrdFile(params: {
  repo: string;
  filePath: string;
  lines?: string;
  commit?: string;
  allowRemoteWorker?: boolean;
}): Promise<CodeReadResult | null> {
  const validated = validateRepoAndRelativePath(params.repo, params.filePath);
  if (!validated) return null;

  const { cleanRepo, cleanPath } = validated;
  const manifest = getPrdManifest();
  const repoInfo = manifest[cleanRepo];
  if (!repoInfo) return null;

  const requestedCommit = params.commit ? params.commit.trim() : undefined;
  if (requestedCommit && !SAFE_COMMIT_RE.test(requestedCommit)) {
    return null;
  }

  const explicitLinesRaw = params.lines || params.filePath.split('#')[1];
  const lineRangeStr = explicitLinesRaw || 'L1-L60';
  const rangeMatch = lineRangeStr.match(/L?(\d+)(?:-L?(\d+))?/i);
  const startLine = rangeMatch ? Math.max(1, Number(rangeMatch[1])) : 1;
  const endLine =
    rangeMatch && rangeMatch[2] ? Math.max(startLine, Number(rangeMatch[2])) : startLine + 35;

  const headCommit = repoInfo.commit;
  const repoDir = path.join(CODEBASE_PRD_ROOT, cleanRepo);

  // 1. 本地 .codebase-prd Git Worktree 实证读取
  if (fs.existsSync(repoDir)) {
    let rawText = '';
    const targetCommit = requestedCommit || headCommit;

    try {
      if (targetCommit === headCommit) {
        const absFile = path.join(repoDir, cleanPath);
        if (!fs.existsSync(absFile)) return null;
        rawText = fs.readFileSync(absFile, 'utf8');
      } else {
        rawText = execFileSync('git', ['show', `${targetCommit}:${cleanPath}`], {
          cwd: repoDir,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
      }
    } catch {
      return null;
    }

    const allLines = rawText.split(/\r?\n/);
    if (startLine > allLines.length) {
      return null;
    }
    const sliced = allLines
      .slice(startLine - 1, endLine)
      .map((text, idx) => `${String(startLine + idx).padStart(4, ' ')} | ${text}`)
      .join('\n');

    let driftStatus: 'synced' | 'drifted' | 'error' = 'synced';
    let diffStat = '';

    if (requestedCommit && requestedCommit !== headCommit) {
      try {
        diffStat = execFileSync(
          'git',
          ['diff', '--stat', `${requestedCommit}..HEAD`, '--', cleanPath],
          { cwd: repoDir, encoding: 'utf8' }
        ).trim();
        driftStatus = diffStat ? 'drifted' : 'synced';
      } catch {
        driftStatus = 'error';
      }
    }

    return {
      repo: cleanRepo,
      branch: repoInfo.branch || 'prd',
      requestedCommit,
      resolvedCommit: targetCommit,
      headCommit,
      path: cleanPath,
      startLine,
      endLine: Math.min(endLine, allLines.length),
      content: sliced,
      driftStatus,
      diffStat,
      source: 'worktree-git',
    };
  }

  // 2. 云端/无工作区环境：真实查询 PostgreSQL lexicon_code_snapshots（严格校验 repo + path + commit + 行号范围覆盖）
  let snapRows = await pgQuery(
    `SELECT repo, branch, commit_sha, file_path, line_range, content
     FROM lexicon_code_snapshots
     WHERE repo = $1 AND file_path = $2`,
    [cleanRepo, cleanPath]
  );

  // 方案 A：若云端 PG 快照未收录此文件，且内网 Worker 在线，立即派发 READ_FILE 任务让内网机器从 .codebase-prd 实时提取并回写 PG 快照
  if (snapRows.length === 0 && params.allowRemoteWorker !== false) {
    const workerRes = await dispatchTaskToIntranetWorker('READ_FILE', {
      repo: cleanRepo,
      filePath: cleanPath,
      lines: lineRangeStr,
      commit: requestedCommit,
    });
    if (workerRes && workerRes.content) {
      return workerRes as CodeReadResult;
    }
    snapRows = await pgQuery(
      `SELECT repo, branch, commit_sha, file_path, line_range, content
       FROM lexicon_code_snapshots
       WHERE repo = $1 AND file_path = $2`,
      [cleanRepo, cleanPath]
    );
  }
  if (snapRows.length === 0) return null;

  const commitMatchedRows = snapRows.filter((r) => {
    const sha = String(r.commit_sha || '');
    if (!sha || sha === 'HEAD') return false;
    if (!requestedCommit) return true;
    return (
      sha === requestedCommit ||
      sha.startsWith(requestedCommit) ||
      requestedCommit.startsWith(sha)
    );
  });

  for (const row of commitMatchedRows) {
    const snapCommit = String(row.commit_sha || '');
    const snapLines = String(row.content || '')
      .split(/\r?\n/)
      .map((raw) => {
        const m = raw.match(/^\s*(\d+)\s*\|\s?(.*)$/);
        return m ? { lineNo: Number(m[1]), raw } : null;
      })
      .filter((item): item is { lineNo: number; raw: string } => item !== null);

    if (snapLines.length === 0) continue;

    const snapMinLine = Math.min(...snapLines.map((l) => l.lineNo));
    const snapMaxLine = Math.max(...snapLines.map((l) => l.lineNo));

    const effectiveStart = explicitLinesRaw ? startLine : snapMinLine;
    const effectiveEnd = explicitLinesRaw ? endLine : snapMaxLine;

    if (explicitLinesRaw && (effectiveStart < snapMinLine || effectiveEnd > snapMaxLine)) {
      continue;
    }

    const coveredSlice = snapLines
      .filter((l) => l.lineNo >= effectiveStart && l.lineNo <= effectiveEnd)
      .map((l) => l.raw)
      .join('\n');

    if (!coveredSlice) continue;

    return {
      repo: cleanRepo,
      branch: String(row.branch || repoInfo.branch || 'prd'),
      requestedCommit,
      resolvedCommit: snapCommit,
      headCommit,
      path: cleanPath,
      startLine: effectiveStart,
      endLine: effectiveEnd,
      content: coveredSlice,
      driftStatus: 'error',
      diffStat: '当前仅读取 PostgreSQL 静态快照，未挂载实时 Git 仓库，无法验证最新 HEAD 漂移状态',
      source: 'db-snapshot',
    };
  }

  // 若请求了明确行号范围但没有任何数据库快照覆盖该区间，若内网 Worker 在线则委托内网 Worker 实时提取；否则明确返回不可用 (null)
  if (params.allowRemoteWorker !== false) {
    const workerRes = await dispatchTaskToIntranetWorker('READ_FILE', {
      repo: cleanRepo,
      filePath: cleanPath,
      lines: lineRangeStr,
      commit: requestedCommit,
    });
    if (workerRes && workerRes.content) {
      return workerRes as CodeReadResult;
    }
  }
  return null;
}

/**
 * 批量巡检所有词条的 Commit 保鲜度
 * 严禁把不存在的仓库、非法路径、无本地 Git 工作区或 Git 错误静默判为 synced
 */
export async function inspectTermsDrift(terms: TermEntry[]) {
  const manifest = getPrdManifest();
  const report: Array<{
    termId: string;
    termTitle: string;
    repo: string;
    branch: string;
    recordedCommit: string;
    headCommit: string;
    path: string;
    status: 'synced' | 'drifted' | 'error';
    diffStat?: string;
    errorReason?: string;
  }> = [];

  for (const term of terms) {
    for (const ptr of term.engineering?.pointers || []) {
      const validated = validateRepoAndRelativePath(ptr.repo, ptr.path);
      const repoInfo = manifest[ptr.repo];
      if (!validated || !repoInfo) {
        report.push({
          termId: term.id,
          termTitle: term.title,
          repo: ptr.repo,
          branch: ptr.branch || 'prd',
          recordedCommit: ptr.commit,
          headCommit: repoInfo?.commit || 'UNKNOWN',
          path: ptr.path,
          status: 'error',
          errorReason: !repoInfo ? `仓库 ${ptr.repo} 不在受控清单中` : `非法的源码路径 ${ptr.path}`,
        });
        continue;
      }

      const { cleanRepo, cleanPath } = validated;
      const headCommit = repoInfo.commit;
      const repoDir = path.join(CODEBASE_PRD_ROOT, cleanRepo);

      let status: 'synced' | 'drifted' | 'error' = 'synced';
      let diffStat = '';
      let errorReason: string | undefined;

      if (fs.existsSync(repoDir)) {
        try {
          execFileSync('git', ['cat-file', '-e', `${ptr.commit}:${cleanPath}`], {
            cwd: repoDir,
            stdio: 'ignore',
          });
          if (ptr.commit !== headCommit) {
            diffStat = execFileSync(
              'git',
              ['diff', '--stat', `${ptr.commit}..HEAD`, '--', cleanPath],
              { cwd: repoDir, encoding: 'utf8' }
            ).trim();
            if (diffStat) status = 'drifted';
          }
        } catch (err: any) {
          status = 'error';
          errorReason = `Git 校验失败 (${ptr.commit}:${cleanPath}): ${err?.message || '未知错误'}`;
        }
      } else {
        // 无本地 Git 工作区时查询 PG 快照做存在性辅助说明，但无法验证最新 HEAD，统一标记 status='error'
        const snapRows = await pgQuery(
          `SELECT commit_sha, line_range FROM lexicon_code_snapshots WHERE repo = $1 AND file_path = $2 LIMIT 1`,
          [cleanRepo, cleanPath]
        );
        status = 'error';
        if (snapRows.length === 0) {
          errorReason = `本地 Git 仓库不可用且 PostgreSQL 快照表未收录 ${cleanRepo}:${cleanPath}`;
        } else {
          errorReason = `本地 Git 仓库 (${cleanRepo}) 未挂载，仅存 PG 快照 (${snapRows[0].commit_sha} ${snapRows[0].line_range})，无法核验最新 HEAD 是否发生漂移`;
        }
      }

      report.push({
        termId: term.id,
        termTitle: term.title,
        repo: cleanRepo,
        branch: ptr.branch || repoInfo.branch || 'prd',
        recordedCommit: ptr.commit,
        headCommit,
        path: cleanPath,
        status,
        diffStat,
        errorReason,
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    totalPointers: report.length,
    syncedCount: report.filter((r) => r.status === 'synced').length,
    driftedCount: report.filter((r) => r.status === 'drifted').length,
    errorCount: report.filter((r) => r.status === 'error').length,
    items: report,
  };
}
