-- =============================================================================
-- Glossa · PostgreSQL 生产 Schema (glossa)
-- 与 @glossa/schema 严格对齐，支持单语句 CTE 原子修订快照、会话鉴权与 AI 密文配置
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS glossa;
SET search_path TO glossa, public;

-- 0. 领域分类配置表
CREATE TABLE IF NOT EXISTS lexicon_categories (
  id             VARCHAR(64) PRIMARY KEY,
  name           VARCHAR(128) NOT NULL,
  sort_order     INTEGER      NOT NULL DEFAULT 100,
  created_at     VARCHAR(32)  NOT NULL
);

-- 1. 内部受控用户与访问口令表
CREATE TABLE IF NOT EXISTS lexicon_users (
  id             VARCHAR(64) PRIMARY KEY,
  username       VARCHAR(64) NOT NULL UNIQUE,
  display_name   VARCHAR(128) NOT NULL,
  password_hash   TEXT        NOT NULL,
  role           VARCHAR(32) NOT NULL DEFAULT 'admin',
  disabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     VARCHAR(32) NOT NULL,
  updated_at     VARCHAR(32) NOT NULL
);

-- 2. 服务端鉴权会话表 (仅存高熵随机 Token 的 SHA-256 哈希，支持即时吊销)
CREATE TABLE IF NOT EXISTS lexicon_sessions (
  token_hash     VARCHAR(128) PRIMARY KEY,
  user_id        VARCHAR(64)  NOT NULL,
  username       VARCHAR(64)  NOT NULL,
  role           VARCHAR(32)  NOT NULL,
  expires_at     VARCHAR(32)  NOT NULL,
  revoked_at     VARCHAR(32),
  user_agent     TEXT,
  created_at     VARCHAR(32)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_sessions_user_id
  ON lexicon_sessions (user_id);

-- 3. AI Provider 受控配置与 AES-256-GCM 密文密钥表
CREATE TABLE IF NOT EXISTS lexicon_ai_configs (
  id             VARCHAR(64) PRIMARY KEY,
  protocol       VARCHAR(32)  NOT NULL DEFAULT 'openai-compatible',
  base_url       VARCHAR(256) NOT NULL DEFAULT 'https://api.deepseek.com',
  model          VARCHAR(128) NOT NULL DEFAULT 'deepseek-chat',
  api_key_cipher TEXT         NOT NULL DEFAULT '',
  api_key_iv     VARCHAR(64)  NOT NULL DEFAULT '',
  api_key_tag    VARCHAR(64)  NOT NULL DEFAULT '',
  masked_key     VARCHAR(64)  NOT NULL DEFAULT '',
  enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
  updated_by     VARCHAR(64)  NOT NULL DEFAULT 'system',
  updated_at     VARCHAR(32)  NOT NULL
);

-- 4. 领域核心词条主表 (线上唯一可写事实源)
CREATE TABLE IF NOT EXISTS lexicon_terms (
  id                      VARCHAR(64) PRIMARY KEY,
  title                   VARCHAR(128) NOT NULL,
  subtitle                VARCHAR(256),
  pinyin                  VARCHAR(128) NOT NULL,
  category                VARCHAR(32)  NOT NULL,
  status                  VARCHAR(32)  NOT NULL DEFAULT 'PUBLISHED',
  revision                INTEGER      NOT NULL DEFAULT 1,
  summary                 TEXT         NOT NULL,
  layman_analogy          TEXT         NOT NULL,
  layman_plain            TEXT         NOT NULL,
  article_markdown        TEXT         NOT NULL,
  aliases_json            TEXT         NOT NULL DEFAULT '[]',
  relations_json          TEXT         NOT NULL DEFAULT '[]',
  faqs_json               TEXT         NOT NULL DEFAULT '[]',
  engineering_json        TEXT         NOT NULL DEFAULT '{}',
  ext_json                TEXT,
  source_commit_batch_id  VARCHAR(64),
  maintained_by           VARCHAR(64)  NOT NULL DEFAULT 'antigravity-v5',
  updated_at              VARCHAR(32)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_terms_category_status
  ON lexicon_terms (category, status);

-- 5. 词条完整历史版本快照审计表 (含完整词条 JSON 快照 + UNIQUE(term_id, revision))
CREATE TABLE IF NOT EXISTS lexicon_term_revisions (
  id                     VARCHAR(128) PRIMARY KEY,
  term_id                VARCHAR(64)  NOT NULL,
  revision               INTEGER      NOT NULL,
  status                 VARCHAR(32)  NOT NULL DEFAULT 'PUBLISHED',
  reason                 TEXT         NOT NULL,
  operator               VARCHAR(64)  NOT NULL DEFAULT 'antigravity-v5',
  term_snapshot_json     TEXT         NOT NULL,
  pointers_snapshot_json TEXT         NOT NULL DEFAULT '[]',
  created_at             VARCHAR(32)  NOT NULL,
  UNIQUE (term_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_lexicon_term_revisions_term_rev
  ON lexicon_term_revisions (term_id, revision DESC);

-- 6. 生产分支源码片段持久化索引表 (支撑云端 SCF 无本地 Worktree 时的精确代码读取与检索)
CREATE TABLE IF NOT EXISTS lexicon_code_snapshots (
  id             VARCHAR(256) PRIMARY KEY,
  repo           VARCHAR(96)  NOT NULL,
  branch         VARCHAR(64)  NOT NULL DEFAULT 'prd',
  commit_sha     VARCHAR(64)  NOT NULL,
  file_path      VARCHAR(512) NOT NULL,
  line_range     VARCHAR(64)  NOT NULL,
  content        TEXT         NOT NULL,
  content_hash   VARCHAR(64)  NOT NULL,
  indexed_at     VARCHAR(32)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_code_snapshots_repo_commit
  ON lexicon_code_snapshots (repo, commit_sha);

-- 7. 月度 PRD Commit 增量漂移巡检工单表
CREATE TABLE IF NOT EXISTS lexicon_drift_tasks (
  id                     VARCHAR(128) PRIMARY KEY,
  term_id                VARCHAR(64)  NOT NULL,
  repo                   VARCHAR(96)  NOT NULL,
  path                   VARCHAR(512) NOT NULL,
  recorded_commit        VARCHAR(64)  NOT NULL,
  head_commit            VARCHAR(64)  NOT NULL,
  status                 VARCHAR(32)  NOT NULL DEFAULT 'DRIFT_DETECTED',
  diff_stat              TEXT,
  resolution_note        TEXT,
  updated_at             VARCHAR(32)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_drift_tasks_status_repo
  ON lexicon_drift_tasks (status, repo);

-- 8. 全员搜索零命中缺词雷达与划词纠错工单表
CREATE TABLE IF NOT EXISTS lexicon_feedback_tickets (
  id                     VARCHAR(128) PRIMARY KEY,
  dedup_key              VARCHAR(256) NOT NULL UNIQUE,
  type                   VARCHAR(32)  NOT NULL,
  status                 VARCHAR(32)  NOT NULL DEFAULT 'OPEN',
  term_id                VARCHAR(64),
  term_revision          INTEGER,
  query_or_selection     TEXT         NOT NULL,
  comment                TEXT,
  reporter               VARCHAR(64)  NOT NULL DEFAULT 'anonymous',
  hit_count              INTEGER      NOT NULL DEFAULT 1,
  created_at             VARCHAR(32)  NOT NULL,
  updated_at             VARCHAR(32)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_feedback_type_status_hits
  ON lexicon_feedback_tickets (type, status, hit_count DESC);

-- 9. AI 伴读多轮会话表
CREATE TABLE IF NOT EXISTS lexicon_chat_sessions (
  id             VARCHAR(96) PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,
  title          VARCHAR(256) NOT NULL,
  active_term_id VARCHAR(64),
  created_at     VARCHAR(32) NOT NULL,
  updated_at     VARCHAR(32) NOT NULL
);

-- 10. AI 伴读多轮消息与真实工具调用轨迹表
CREATE TABLE IF NOT EXISTS lexicon_chat_messages (
  id                      VARCHAR(96) PRIMARY KEY,
  session_id              VARCHAR(96) NOT NULL,
  role                    VARCHAR(32) NOT NULL,
  content                 TEXT        NOT NULL,
  trace_json              TEXT        NOT NULL DEFAULT '[]',
  referenced_commits_json TEXT        NOT NULL DEFAULT '[]',
  mode                    VARCHAR(32) NOT NULL DEFAULT 'llm-tool-loop',
  created_at              VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lexicon_chat_messages_session
  ON lexicon_chat_messages (session_id, created_at ASC);
