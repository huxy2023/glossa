import crypto from 'node:crypto';
import fs from 'node:fs';
import { CODEBASE_PRD_ROOT } from '../codebase-probe.js';
import {
  pgQuery,
  pgExecute,
  getDbDriverMode,
  verifyPassword,
  hashSessionToken,
  encryptApiKey,
  decryptApiKey,
} from '../pg-database.js';

export interface AuthSessionUser {
  userId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'editor' | 'reader';
  expiresAt: string;
}

export interface PublicAiConfig {
  protocol: 'openai-compatible' | 'anthropic-messages';
  baseUrl: string;
  model: string;
  hasKey: boolean;
  maskedKey: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface ServerAiConfig extends PublicAiConfig {
  apiKey: string;
}

export interface ChatTurnMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  trace: any[];
  referencedCommits: string[];
  mode: string;
  createdAt: string;
}

export interface WorkerNodeStatus {
  workerId: string;
  hostname: string;
  codebaseRoot: string;
  repoCount: number;
  status: string;
  lastHeartbeatAt: string;
  startedAt: string;
  isAlive: boolean;
}

// ==========================================================================
// 服务端鉴权会话管理 (lexicon_users + lexicon_sessions)
// ==========================================================================

export async function authenticateUserSql(
  username: string,
  password: string,
  userAgent = ''
): Promise<{ token: string; user: AuthSessionUser } | null> {
  const cleanUser = String(username || '').trim();
  if (!cleanUser || !password) return null;

  const users = await pgQuery(
    `SELECT * FROM lexicon_users WHERE username = $1 AND disabled = FALSE LIMIT 1`,
    [cleanUser]
  );
  if (users.length === 0) return null;
  const u = users[0];

  if (!verifyPassword(password, u.password_hash)) {
    return null;
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

  await pgExecute(
    `INSERT INTO lexicon_sessions (token_hash, user_id, username, role, expires_at, revoked_at, user_agent, created_at)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
    [
      tokenHash,
      u.id,
      u.username,
      u.role,
      expires.toISOString(),
      userAgent.slice(0, 250),
      now.toISOString(),
    ]
  );

  return {
    token: rawToken,
    user: {
      userId: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      expiresAt: expires.toISOString(),
    },
  };
}

export async function verifySessionTokenSql(rawToken: string): Promise<AuthSessionUser | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = hashSessionToken(rawToken);
  const rows = await pgQuery(
    `SELECT s.user_id, s.username, s.role, s.expires_at, s.revoked_at, u.display_name, u.disabled
     FROM lexicon_sessions s
     JOIN lexicon_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  const isDisabled =
    row.disabled === true ||
    row.disabled === 't' ||
    row.disabled === 'true' ||
    row.disabled === 1 ||
    row.disabled === '1';
  if (isDisabled || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    expiresAt: row.expires_at,
  };
}

export async function revokeSessionTokenSql(rawToken: string): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  await pgExecute(
    `UPDATE lexicon_sessions SET revoked_at = $1 WHERE token_hash = $2`,
    [new Date().toISOString(), tokenHash]
  );
}

// ==========================================================================
// AI Provider 配置持久化与密文管理 (lexicon_ai_configs)
// ==========================================================================

export async function getPublicAiConfigSql(): Promise<PublicAiConfig> {
  const rows = await pgQuery(`SELECT * FROM lexicon_ai_configs WHERE id = 'default' LIMIT 1`);
  const r = rows[0];
  if (!r) {
    return {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      hasKey: false,
      maskedKey: '',
      enabled: true,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    protocol: (r.protocol as any) || 'openai-compatible',
    baseUrl: r.base_url || 'https://api.deepseek.com',
    model: r.model || 'deepseek-chat',
    hasKey: Boolean(r.api_key_cipher),
    maskedKey: r.masked_key || '',
    enabled: Boolean(r.enabled),
    updatedBy: r.updated_by || 'system',
    updatedAt: r.updated_at || '',
  };
}

export async function getServerAiConfigSql(): Promise<ServerAiConfig> {
  const rows = await pgQuery(`SELECT * FROM lexicon_ai_configs WHERE id = 'default' LIMIT 1`);
  const r = rows[0];
  const decrypted = r
    ? decryptApiKey(r.api_key_cipher, r.api_key_iv, r.api_key_tag)
    : '';
  const effectiveKey =
    decrypted || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';

  return {
    protocol: (r?.protocol as any) || 'openai-compatible',
    baseUrl: r?.base_url || 'https://api.deepseek.com',
    model: r?.model || 'deepseek-chat',
    hasKey: Boolean(effectiveKey),
    maskedKey: r?.masked_key || (effectiveKey ? 'env-****' : ''),
    enabled: r ? Boolean(r.enabled) : true,
    updatedBy: r?.updated_by || 'system',
    updatedAt: r?.updated_at || '',
    apiKey: effectiveKey,
  };
}

export async function updateAiConfigSql(
  input: {
    protocol: 'openai-compatible' | 'anthropic-messages';
    baseUrl: string;
    model: string;
    apiKey?: string;
  },
  operator = 'admin'
): Promise<PublicAiConfig> {
  const nowIso = new Date().toISOString();
  const existingRows = await pgQuery(
    `SELECT * FROM lexicon_ai_configs WHERE id = 'default' LIMIT 1`
  );
  const existing = existingRows[0];

  let cipher = existing?.api_key_cipher || '';
  let iv = existing?.api_key_iv || '';
  let tag = existing?.api_key_tag || '';
  let masked = existing?.masked_key || '';

  if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
    const enc = encryptApiKey(input.apiKey.trim());
    cipher = enc.cipher;
    iv = enc.iv;
    tag = enc.tag;
    masked = enc.masked;
  }

  await pgExecute(
    `INSERT INTO lexicon_ai_configs (
       id, protocol, base_url, model, api_key_cipher, api_key_iv, api_key_tag, masked_key, enabled, updated_by, updated_at
     ) VALUES ('default', $1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       protocol = EXCLUDED.protocol,
       base_url = EXCLUDED.base_url,
       model = EXCLUDED.model,
       api_key_cipher = EXCLUDED.api_key_cipher,
       api_key_iv = EXCLUDED.api_key_iv,
       api_key_tag = EXCLUDED.api_key_tag,
       masked_key = EXCLUDED.masked_key,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
    [input.protocol, input.baseUrl, input.model, cipher, iv, tag, masked, operator, nowIso]
  );

  return getPublicAiConfigSql();
}

// ==========================================================================
// PostgreSQL 源码快照检索 (lexicon_code_snapshots)
// ==========================================================================

export async function getCodeSnapshotFromPgSql(
  repo: string,
  filePath: string,
  commit?: string
): Promise<{
  id: string;
  repo: string;
  branch: string;
  commitSha: string;
  filePath: string;
  lineRange: string;
  content: string;
} | null> {
  const rows = await pgQuery(
    `SELECT * FROM lexicon_code_snapshots WHERE repo = $1 AND file_path = $2 LIMIT 5`,
    [repo, filePath]
  );
  if (rows.length === 0) return null;
  const matched = commit
    ? rows.find(
        (r) =>
          r.commit_sha === commit ||
          String(r.commit_sha || '').startsWith(commit) ||
          commit.startsWith(String(r.commit_sha || ''))
      )
    : rows[0];
  if (!matched) return null;
  return {
    id: matched.id,
    repo: matched.repo,
    branch: matched.branch || 'prd',
    commitSha: matched.commit_sha,
    filePath: matched.file_path,
    lineRange: matched.line_range,
    content: matched.content,
  };
}

export async function getAllCodeSnapshotsFromPgSql(repo?: string): Promise<
  Array<{
    id: string;
    repo: string;
    branch: string;
    commitSha: string;
    filePath: string;
    lineRange: string;
    content: string;
  }>
> {
  const rows = repo
    ? await pgQuery(`SELECT * FROM lexicon_code_snapshots WHERE repo = $1`, [repo])
    : await pgQuery(`SELECT * FROM lexicon_code_snapshots`);
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    branch: r.branch || 'prd',
    commitSha: r.commit_sha,
    filePath: r.file_path,
    lineRange: r.line_range,
    content: r.content,
  }));
}

// ==========================================================================
// AI 伴读多轮会话历史持久化 (lexicon_chat_sessions + lexicon_chat_messages)
// ==========================================================================

export async function listChatSessionsSql(
  userId: string,
  limit = 15
): Promise<
  Array<{
    id: string;
    userId: string;
    title: string;
    activeTermId?: string;
    createdAt: string;
    updatedAt: string;
  }>
> {
  if (!userId) return [];
  const rows = await pgQuery(
    `SELECT * FROM lexicon_chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    activeTermId: r.active_term_id || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getChatMessagesSql(
  sessionId: string,
  limit = 12,
  userId?: string
): Promise<ChatTurnMessage[]> {
  if (!sessionId) return [];
  const sessRows = await pgQuery(
    `SELECT user_id FROM lexicon_chat_sessions WHERE id = $1 LIMIT 1`,
    [sessionId]
  );
  if (sessRows.length === 0) return [];
  if (userId && sessRows[0].user_id !== userId) {
    const err: any = new Error('无权访问其他用户的伴读会话历史 (403)');
    err.status = 403;
    throw err;
  }

  const rows = await pgQuery(
    `SELECT * FROM lexicon_chat_messages WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [sessionId, limit]
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    trace: (() => {
      try {
        return JSON.parse(r.trace_json || '[]');
      } catch {
        return [];
      }
    })(),
    referencedCommits: (() => {
      try {
        return JSON.parse(r.referenced_commits_json || '[]');
      } catch {
        return [];
      }
    })(),
    mode: r.mode || 'llm-tool-loop',
    createdAt: r.created_at,
  }));
}

export async function saveChatTurnSql(params: {
  sessionId: string;
  userId: string;
  activeTermId?: string;
  question: string;
  answer: string;
  trace: any[];
  referencedCommits: string[];
  mode: string;
}): Promise<void> {
  const existingSess = await pgQuery(
    `SELECT user_id FROM lexicon_chat_sessions WHERE id = $1 LIMIT 1`,
    [params.sessionId]
  );
  if (existingSess.length > 0 && existingSess[0].user_id !== params.userId) {
    const err: any = new Error('无权写入其他用户的伴读会话 (403)');
    err.status = 403;
    throw err;
  }

  const now1 = new Date().toISOString();
  const now2 = new Date(Date.now() + 1).toISOString();
  const randSuffix = crypto.randomBytes(3).toString('hex');

  await pgExecute(
    `INSERT INTO lexicon_chat_sessions (id, user_id, title, active_term_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (id) DO UPDATE SET updated_at = $5, active_term_id = COALESCE($4, lexicon_chat_sessions.active_term_id)
     WHERE lexicon_chat_sessions.user_id = $2`,
    [
      params.sessionId,
      params.userId,
      params.question.slice(0, 60),
      params.activeTermId || null,
      now1,
    ]
  );

  await pgExecute(
    `INSERT INTO lexicon_chat_messages (id, session_id, role, content, trace_json, referenced_commits_json, mode, created_at)
     VALUES ($1, $2, 'user', $3, '[]', '[]', $4, $5),
            ($6, $2, 'assistant', $7, $8, $9, $4, $10)`,
    [
      `msg_${Date.now()}_${randSuffix}_u`,
      params.sessionId,
      params.question,
      params.mode,
      now1,
      `msg_${Date.now()}_${randSuffix}_a`,
      params.answer,
      JSON.stringify(params.trace || []),
      JSON.stringify(params.referencedCommits || []),
      now2,
    ]
  );
}

// ==========================================================================
// 内网源码探针 Worker 注册、心跳、快照同步与跨网任务队列
// ==========================================================================

export async function upsertCodeSnapshotSql(snap: {
  repo: string;
  branch: string;
  commitSha: string;
  filePath: string;
  lineRange: string;
  content: string;
}): Promise<void> {
  const id = `${snap.repo}:${snap.filePath}@${snap.commitSha}#${snap.lineRange}`;
  const nowIso = new Date().toISOString();
  const hash = crypto
    .createHash('sha256')
    .update(snap.content, 'utf8')
    .digest('hex')
    .slice(0, 16);

  await pgExecute(
    `INSERT INTO lexicon_code_snapshots (id, repo, branch, commit_sha, file_path, line_range, content, content_hash, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       branch = EXCLUDED.branch,
       commit_sha = EXCLUDED.commit_sha,
       line_range = EXCLUDED.line_range,
       content = EXCLUDED.content,
       content_hash = EXCLUDED.content_hash,
       indexed_at = EXCLUDED.indexed_at`,
    [
      id,
      snap.repo,
      snap.branch || 'prd',
      snap.commitSha,
      snap.filePath,
      snap.lineRange,
      snap.content,
      hash,
      nowIso,
    ]
  );
}

export async function registerWorkerHeartbeatSql(input: {
  workerId: string;
  hostname: string;
  codebaseRoot: string;
  repoCount: number;
}): Promise<WorkerNodeStatus> {
  const nowIso = new Date().toISOString();
  await pgExecute(
    `INSERT INTO lexicon_worker_nodes (worker_id, hostname, codebase_root, repo_count, status, last_heartbeat_at, started_at)
     VALUES ($1, $2, $3, $4, 'ONLINE', $5, $5)
     ON CONFLICT (worker_id) DO UPDATE SET
       hostname = EXCLUDED.hostname,
       codebase_root = EXCLUDED.codebase_root,
       repo_count = EXCLUDED.repo_count,
       status = 'ONLINE',
       last_heartbeat_at = EXCLUDED.last_heartbeat_at`,
    [input.workerId, input.hostname, input.codebaseRoot, input.repoCount, nowIso]
  );
  return {
    workerId: input.workerId,
    hostname: input.hostname,
    codebaseRoot: input.codebaseRoot,
    repoCount: input.repoCount,
    status: 'ONLINE',
    lastHeartbeatAt: nowIso,
    startedAt: nowIso,
    isAlive: true,
  };
}

export async function getWorkerStatusSql(): Promise<{
  online: boolean;
  activeWorkers: WorkerNodeStatus[];
  pendingTasks: number;
  completedTasks: number;
  localWorktreeReady: boolean;
  localRepoCount: number;
  dbDriverMode: 'drizzle-pg-tcp' | 'drizzle-cloudbase-http';
}> {
  const rows = await pgQuery(
    `SELECT * FROM lexicon_worker_nodes ORDER BY last_heartbeat_at DESC LIMIT 10`
  );
  const nowMs = Date.now();
  const nodes: WorkerNodeStatus[] = rows.map((r) => {
    const hbMs = new Date(r.last_heartbeat_at || 0).getTime();
    const isAlive = Number.isFinite(hbMs) && nowMs - hbMs <= 90_000 && r.status === 'ONLINE';
    return {
      workerId: r.worker_id,
      hostname: r.hostname,
      codebaseRoot: r.codebase_root,
      repoCount: Number(r.repo_count || 0),
      status: isAlive ? 'ONLINE' : 'STALE',
      lastHeartbeatAt: r.last_heartbeat_at,
      startedAt: r.started_at,
      isAlive,
    };
  });

  const taskStatRows = await pgQuery(
    `SELECT status, count(*) AS cnt FROM lexicon_worker_tasks GROUP BY status`
  );
  let pendingTasks = 0;
  let completedTasks = 0;
  for (const r of taskStatRows) {
    if (r.status === 'PENDING' || r.status === 'RUNNING') {
      pendingTasks += Number(r.cnt || 0);
    } else if (r.status === 'COMPLETED') {
      completedTasks += Number(r.cnt || 0);
    }
  }

  const localWorktreeReady = fs.existsSync(CODEBASE_PRD_ROOT);
  let localRepoCount = 0;
  if (localWorktreeReady) {
    try {
      localRepoCount = fs
        .readdirSync(CODEBASE_PRD_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;
    } catch {
      localRepoCount = 0;
    }
  }

  const activeWorkers = nodes.filter((n) => n.isAlive);
  return {
    online: localWorktreeReady || activeWorkers.length > 0,
    activeWorkers,
    pendingTasks,
    completedTasks,
    localWorktreeReady,
    localRepoCount,
    dbDriverMode: getDbDriverMode(),
  };
}

export async function enqueueWorkerTaskSql(
  taskType:
    | 'GREP_CODE'
    | 'READ_FILE'
    | 'INSPECT_DRIFT'
    | 'HARNESS_DISSECT'
    | 'HARNESS_RESOLVE'
    | 'HARNESS_CONSULT',
  payload: Record<string, any>,
  requester = 'cloud-api'
): Promise<string> {
  const id = `wtask_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();
  await pgExecute(
    `INSERT INTO lexicon_worker_tasks (id, task_type, status, payload_json, requester, created_at)
     VALUES ($1, $2, 'PENDING', $3, $4, $5)`,
    [id, taskType, JSON.stringify(payload), requester, nowIso]
  );
  return id;
}

export async function waitForWorkerTaskSql(taskId: string, timeoutMs = 5500): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await pgQuery(
      `SELECT status, result_json, error_message FROM lexicon_worker_tasks WHERE id = $1 LIMIT 1`,
      [taskId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.status === 'COMPLETED' && row.result_json) {
      try {
        return JSON.parse(row.result_json);
      } catch {
        return null;
      }
    }
    if (row.status === 'FAILED') {
      return null;
    }
    await new Promise((r) => setTimeout(r, 320));
  }
  return null;
}

export async function claimNextWorkerTaskSql(
  workerId: string
): Promise<{ id: string; taskType: string; payload: any } | null> {
  const rows = await pgExecute(
    `UPDATE lexicon_worker_tasks
     SET status = 'RUNNING', worker_id = $1
     WHERE status = 'PENDING' AND id = (
       SELECT id FROM lexicon_worker_tasks
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, task_type, payload_json`,
    [workerId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  let payload: any = {};
  try {
    payload = JSON.parse(r.payload_json || '{}');
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    taskType: r.task_type,
    payload,
  };
}

export async function completeWorkerTaskSql(
  taskId: string,
  workerId: string,
  result: any,
  errorMessage?: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  await pgExecute(
    `UPDATE lexicon_worker_tasks
     SET status = $1,
         result_json = $3,
         error_message = $4,
         completed_at = $5
     WHERE id = $6 AND worker_id = $2 AND status = 'RUNNING'`,
    [
      errorMessage ? 'FAILED' : 'COMPLETED',
      workerId,
      result !== undefined ? JSON.stringify(result) : null,
      errorMessage || null,
      nowIso,
      taskId,
    ]
  );
}
