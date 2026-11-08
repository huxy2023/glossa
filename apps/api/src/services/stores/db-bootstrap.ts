import {
  TermEntrySchema,
  type TermEntry,
} from '@glossa/schema';
import {
  DEFAULT_PG_SCHEMA,
  pgQuery,
  pgExecute,
  hashPassword,
  encryptApiKey,
} from '../pg-database.js';

export interface CategoryItem {
  id: string;
  name: string;
}

export const DEFAULT_CATEGORIES: CategoryItem[] = [
  { id: 'asop', name: '端到端业务流程攻略' },
  { id: 'core', name: '核心领域模型' },
  { id: 'workflow', name: '业务流转与状态' },
  { id: 'policy', name: '规则与风控策略' },
  { id: 'role', name: '组织与角色权限' },
  { id: 'finance', name: '计费、账务与结算' },
  { id: 'general', name: '通用业务概念' },
];

export function sortTerms(list: TermEntry[]): TermEntry[] {
  return [...list].sort((a, b) => {
    const aIsAsop = a.category === 'asop' || a.id.startsWith('asop-');
    const bIsAsop = b.category === 'asop' || b.id.startsWith('asop-');
    if (aIsAsop && !bIsAsop) return -1;
    if (!aIsAsop && bIsAsop) return 1;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}

export function rowToTermEntry(row: any): TermEntry {
  const safeJson = (str: any, fallback: any) => {
    if (!str) return fallback;
    if (typeof str === 'object') return str;
    try {
      return JSON.parse(String(str));
    } catch {
      return fallback;
    }
  };

  return TermEntrySchema.parse({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle || undefined,
    pinyin: row.pinyin,
    category: row.category || 'general',
    aliases: safeJson(row.aliases_json, []),
    summary: row.summary,
    layman: {
      analogy: row.layman_analogy,
      plain: row.layman_plain,
    },
    articleMarkdown: row.article_markdown,
    engineering: safeJson(row.engineering_json, {
      repos: [],
      pointers: [],
      dataMappings: [],
    }),
    relations: safeJson(row.relations_json, []),
    faqs: safeJson(row.faqs_json, []),
    meta: {
      updatedAt: row.updated_at || new Date().toISOString().slice(0, 10),
      maintainedBy: row.maintained_by || 'glossa-engine',
      status: row.status || 'PUBLISHED',
      revision: Number(row.revision || 1),
      sourceCommitBatchId: row.source_commit_batch_id || undefined,
      ext: safeJson(row.ext_json, undefined),
    },
  });
}

export function loadLocalSeedTerms(): TermEntry[] {
  return [];
}

/**
 * 幂等初始化 Glossa PostgreSQL 表结构（纯空壳引擎，不内置任何特定项目私有词条）
 */
export async function bootstrapDatabaseTablesAndSeeds(seedTerms: TermEntry[] = []): Promise<void> {
  const safeSchema = DEFAULT_PG_SCHEMA.replace(/[^a-zA-Z0-9_]/g, '') || 'glossa';
  await pgExecute(`
    DO LANGUAGE plpgsql $$
    BEGIN
      CREATE SCHEMA IF NOT EXISTS ${safeSchema};
      SET LOCAL search_path TO ${safeSchema}, public;

      CREATE TABLE IF NOT EXISTS lexicon_categories (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 100,
        created_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        display_name VARCHAR(128) NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'admin',
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_sessions (
        token_hash VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        username VARCHAR(64) NOT NULL,
        role VARCHAR(32) NOT NULL,
        expires_at VARCHAR(32) NOT NULL,
        revoked_at VARCHAR(32),
        user_agent TEXT,
        created_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_ai_configs (
        id VARCHAR(64) PRIMARY KEY,
        protocol VARCHAR(32) NOT NULL DEFAULT 'openai-compatible',
        base_url VARCHAR(256) NOT NULL DEFAULT 'https://api.deepseek.com',
        model VARCHAR(128) NOT NULL DEFAULT 'deepseek-chat',
        api_key_cipher TEXT NOT NULL DEFAULT '',
        api_key_iv VARCHAR(64) NOT NULL DEFAULT '',
        api_key_tag VARCHAR(64) NOT NULL DEFAULT '',
        masked_key VARCHAR(64) NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
        updated_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_terms (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(128) NOT NULL,
        subtitle VARCHAR(256),
        pinyin VARCHAR(128) NOT NULL,
        category VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PUBLISHED',
        revision INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL,
        layman_analogy TEXT NOT NULL,
        layman_plain TEXT NOT NULL,
        article_markdown TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        relations_json TEXT NOT NULL DEFAULT '[]',
        faqs_json TEXT NOT NULL DEFAULT '[]',
        engineering_json TEXT NOT NULL DEFAULT '{}',
        ext_json TEXT,
        source_commit_batch_id VARCHAR(64),
        maintained_by VARCHAR(64) NOT NULL DEFAULT 'glossa-engine',
        updated_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_term_revisions (
        id VARCHAR(128) PRIMARY KEY,
        term_id VARCHAR(64) NOT NULL,
        revision INTEGER NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PUBLISHED',
        reason TEXT NOT NULL,
        operator VARCHAR(64) NOT NULL DEFAULT 'glossa-engine',
        term_snapshot_json TEXT NOT NULL,
        pointers_snapshot_json TEXT NOT NULL DEFAULT '[]',
        created_at VARCHAR(32) NOT NULL,
        UNIQUE (term_id, revision)
      );

      CREATE TABLE IF NOT EXISTS lexicon_code_snapshots (
        id VARCHAR(256) PRIMARY KEY,
        repo VARCHAR(96) NOT NULL,
        branch VARCHAR(64) NOT NULL DEFAULT 'main',
        commit_sha VARCHAR(64) NOT NULL,
        file_path VARCHAR(512) NOT NULL,
        line_range VARCHAR(64) NOT NULL,
        content TEXT NOT NULL,
        content_hash VARCHAR(64) NOT NULL,
        indexed_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_drift_tasks (
        id VARCHAR(128) PRIMARY KEY,
        term_id VARCHAR(64) NOT NULL,
        repo VARCHAR(96) NOT NULL,
        path VARCHAR(512) NOT NULL,
        recorded_commit VARCHAR(64) NOT NULL,
        head_commit VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'DRIFT_DETECTED',
        diff_stat TEXT,
        resolution_note TEXT,
        updated_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_feedback_tickets (
        id VARCHAR(128) PRIMARY KEY,
        dedup_key VARCHAR(256) NOT NULL UNIQUE,
        type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
        term_id VARCHAR(64),
        term_revision INTEGER,
        query_or_selection TEXT NOT NULL,
        comment TEXT,
        resolution_term_id VARCHAR(64),
        resolution_note TEXT,
        resolved_by VARCHAR(64),
        reporter VARCHAR(64) NOT NULL DEFAULT 'anonymous',
        hit_count INTEGER NOT NULL DEFAULT 1,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      );

      ALTER TABLE lexicon_feedback_tickets ADD COLUMN IF NOT EXISTS resolution_term_id VARCHAR(64);
      ALTER TABLE lexicon_feedback_tickets ADD COLUMN IF NOT EXISTS resolution_note TEXT;
      ALTER TABLE lexicon_feedback_tickets ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(64);

      CREATE TABLE IF NOT EXISTS lexicon_chat_sessions (
        id VARCHAR(96) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        title VARCHAR(256) NOT NULL,
        active_term_id VARCHAR(64),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_chat_messages (
        id VARCHAR(96) PRIMARY KEY,
        session_id VARCHAR(96) NOT NULL,
        role VARCHAR(32) NOT NULL,
        content TEXT NOT NULL,
        trace_json TEXT NOT NULL DEFAULT '[]',
        referenced_commits_json TEXT NOT NULL DEFAULT '[]',
        mode VARCHAR(32) NOT NULL DEFAULT 'llm-tool-loop',
        created_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_worker_nodes (
        worker_id VARCHAR(96) PRIMARY KEY,
        hostname VARCHAR(128) NOT NULL,
        codebase_root VARCHAR(512) NOT NULL,
        repo_count INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'ONLINE',
        last_heartbeat_at VARCHAR(32) NOT NULL,
        started_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_worker_tasks (
        id VARCHAR(128) PRIMARY KEY,
        task_type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        error_message TEXT,
        worker_id VARCHAR(96),
        requester VARCHAR(64) NOT NULL DEFAULT 'cloud-api',
        created_at VARCHAR(32) NOT NULL,
        completed_at VARCHAR(32)
      );

      CREATE TABLE IF NOT EXISTS lexicon_expansion_runs (
        id VARCHAR(96) PRIMARY KEY,
        root_seed_type VARCHAR(32) NOT NULL DEFAULT 'term',
        root_seed_ref VARCHAR(128) NOT NULL,
        title VARCHAR(256) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
        max_depth INTEGER NOT NULL DEFAULT 2,
        max_drafts INTEGER NOT NULL DEFAULT 20,
        generated_count INTEGER NOT NULL DEFAULT 0,
        merged_alias_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        memory_summary TEXT NOT NULL DEFAULT '',
        operator VARCHAR(64) NOT NULL DEFAULT 'glossa-harness',
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lexicon_expansion_candidates (
        id VARCHAR(128) PRIMARY KEY,
        run_id VARCHAR(96) NOT NULL,
        name VARCHAR(128) NOT NULL,
        normalized_name VARCHAR(128) NOT NULL UNIQUE,
        category VARCHAR(32) NOT NULL DEFAULT 'general',
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        depth INTEGER NOT NULL DEFAULT 1,
        origins_json TEXT NOT NULL DEFAULT '[]',
        recommended_action VARCHAR(32) NOT NULL DEFAULT 'GENERATE_TERM',
        recommended_target_term_id VARCHAR(64),
        recommended_target_term_title VARCHAR(128),
        recommendation_reason TEXT NOT NULL DEFAULT '',
        decision_action VARCHAR(32),
        decision_note TEXT,
        target_term_id VARCHAR(64),
        operator VARCHAR(64) NOT NULL DEFAULT 'glossa-harness',
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      );
    END $$;
  `);

  const nowIso = new Date().toISOString();
  const existingCats = await pgQuery(`SELECT count(*) AS cnt FROM lexicon_categories`);
  if (Number(existingCats[0]?.cnt || 0) === 0) {
    let idx = 10;
    for (const cat of DEFAULT_CATEGORIES) {
      await pgExecute(
        `INSERT INTO lexicon_categories (id, name, sort_order, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [cat.id, cat.name, idx, nowIso]
      );
      idx += 10;
    }
  }

  const envAdminPwd = String(
    process.env.GLOSSA_ADMIN_PASSWORD || process.env.LEXICON_ADMIN_PASSWORD || ''
  ).trim();
  if (envAdminPwd.length >= 8) {
    const adminHash = hashPassword(envAdminPwd);
    await pgExecute(
      `INSERT INTO lexicon_users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'admin', FALSE, $5, $6)
       ON CONFLICT (username) DO NOTHING`,
      ['usr_admin_01', 'admin', 'Glossa 领域维护管理员', adminHash, nowIso, nowIso]
    );
  }

  const envKey = String(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const masterKey = String(
    process.env.GLOSSA_MASTER_KEY || process.env.LEXICON_MASTER_KEY || ''
  ).trim();
  const hasMasterKey = masterKey.length >= 16;
  const enc =
    envKey && hasMasterKey
      ? encryptApiKey(envKey)
      : { cipher: '', iv: '', tag: '', masked: '' };
  await pgExecute(
    `INSERT INTO lexicon_ai_configs (id, protocol, base_url, model, api_key_cipher, api_key_iv, api_key_tag, masked_key, enabled, updated_by, updated_at)
     VALUES ('default', 'openai-compatible', 'https://api.deepseek.com', 'deepseek-chat', $1, $2, $3, $4, TRUE, 'system-init', $5)
     ON CONFLICT (id) DO NOTHING`,
    [enc.cipher, enc.iv, enc.tag, enc.masked, nowIso]
  );

  for (const seed of seedTerms) {
    await pgExecute(
      `INSERT INTO lexicon_terms (
         id, title, subtitle, pinyin, category, status, revision, summary,
         layman_analogy, layman_plain, article_markdown, aliases_json,
         relations_json, faqs_json, engineering_json, ext_json, maintained_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', 1, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO NOTHING`,
      [
        seed.id,
        seed.title,
        seed.subtitle || null,
        seed.pinyin,
        seed.category,
        seed.summary,
        seed.layman.analogy,
        seed.layman.plain,
        seed.articleMarkdown,
        JSON.stringify(seed.aliases || []),
        JSON.stringify(seed.relations || []),
        JSON.stringify(seed.faqs || []),
        JSON.stringify(seed.engineering || { repos: [], pointers: [], dataMappings: [] }),
        seed.meta?.ext ? JSON.stringify(seed.meta.ext) : null,
        seed.meta?.maintainedBy || 'glossa-engine',
        seed.meta?.updatedAt || nowIso.slice(0, 10),
      ]
    );
  }
}
