import './load-dotenv.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePgProxy } from 'drizzle-orm/pg-proxy';
import * as schema from '../db/schema.js';

const { Pool } = pg;

export interface DbRow {
  [key: string]: any;
}

export interface MyShipDbClient {
  provider?: string;
  query: (sql: string, params?: any[]) => Promise<any>;
  execute: (sql: string, params?: any[]) => Promise<any>;
}

const DEFAULT_TCB_ENV_ID = process.env.TCB_ENV_ID || '';
const DEFAULT_TCB_REGION = process.env.TCB_REGION || 'ap-shanghai';
export const DEFAULT_PG_SCHEMA =
  process.env.GLOSSA_DB_SCHEMA || process.env.PG_SCHEMA || 'glossa';
export const DEFAULT_LOCAL_PG_URL =
  'postgresql://glossa:glossa_local_dev@127.0.0.1:54329/glossa';

let activeInjectedDb: MyShipDbClient | null = null;
let tcpPool: pg.Pool | null = null;
let activePoolUrl = '';

export function setInjectedDbClient(db: MyShipDbClient | null) {
  activeInjectedDb = db;
}

export function getDatabaseUrl(): string {
  if (process.env.LEXICON_DB_MODE === 'cloudbase-http') {
    return '';
  }
  return String(
    process.env.DATABASE_URL ||
      process.env.PG_CONNECTION_STRING ||
      process.env.CLOUDBASE_PG_URL ||
      DEFAULT_LOCAL_PG_URL
  ).trim();
}

export function getDbDriverMode(): 'drizzle-pg-tcp' | 'drizzle-cloudbase-http' {
  return getDatabaseUrl() ? 'drizzle-pg-tcp' : 'drizzle-cloudbase-http';
}

function getOrInitTcpPool(): pg.Pool | null {
  const connUrl = getDatabaseUrl();
  if (!connUrl) return null;
  if (!tcpPool || activePoolUrl !== connUrl) {
    const safeSchema = DEFAULT_PG_SCHEMA.replace(/[^a-zA-Z0-9_]/g, '');
    tcpPool = new Pool({
      connectionString: connUrl,
      options: `-c search_path=${safeSchema},public`,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      allowExitOnIdle: true,
    });
    activePoolUrl = connUrl;
  }
  return tcpPool;
}

/**
 * 获取 Drizzle ORM 实例：
 * - 若已配置 DATABASE_URL (postgresql://...)，走原生 node-postgres (pg.Pool) TCP 连接池；
 * - 若未配置 DATABASE_URL，自动回退至 CloudBase PostgreSQL ExecutePGSql HTTP 代理模式，开箱即用。
 */
export function getDrizzleDb() {
  const pool = getOrInitTcpPool();
  if (pool) {
    return drizzleNodePg(pool, { schema });
  }
  return drizzlePgProxy(
    async (sqlStr, params, method) => {
      const rows = await pgQuery(sqlStr, params);
      if (method === 'all') {
        return {
          rows: rows.map((r) => Object.values(r)),
        };
      }
      return { rows: rows as any };
    },
    { schema }
  );
}

function sha256HexStr(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256Buf(key: string | Buffer, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function hmacSha256Hex(key: string | Buffer, msg: string): string {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

function loadTencentCloudCredentials(): {
  secretId: string;
  secretKey: string;
  token?: string;
} | null {
  const envId =
    process.env.TENCENTCLOUD_SECRET_ID ||
    process.env.TENCENT_SECRET_ID ||
    process.env.QCLOUD_SECRET_ID;
  const envKey =
    process.env.TENCENTCLOUD_SECRET_KEY ||
    process.env.TENCENT_SECRET_KEY ||
    process.env.QCLOUD_SECRET_KEY;
  const envToken =
    process.env.TENCENTCLOUD_SESSION_TOKEN ||
    process.env.TENCENT_SESSION_TOKEN ||
    process.env.QCLOUD_SESSION_TOKEN;

  if (envId && envKey) {
    return { secretId: envId, secretKey: envKey, token: envToken };
  }

  try {
    const tccliPath = path.join(os.homedir(), '.tccli', 'default.credential');
    if (fs.existsSync(tccliPath)) {
      const parsed = JSON.parse(fs.readFileSync(tccliPath, 'utf8'));
      if (parsed.secretId && parsed.secretKey) {
        return {
          secretId: parsed.secretId,
          secretKey: parsed.secretKey,
          token: parsed.token || undefined,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function sqlLiteral(val: any): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : 'NULL';
  }
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return `'${str.replace(/'/g, "''")}'`;
}

export function bindSqlParams(sql: string, params: any[] = []): string {
  if (!params || params.length === 0) return sql;
  if (/\$\d+/.test(sql)) {
    return sql.replace(/\$(\d+)/g, (_, numStr) => {
      const idx = Number(numStr) - 1;
      return idx >= 0 && idx < params.length ? sqlLiteral(params[idx]) : 'NULL';
    });
  }
  let idx = 0;
  return sql.replace(/\?/g, () => {
    const v = params[idx++];
    return sqlLiteral(v);
  });
}

const DDL_RE = /^\s*(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT|SET|RESET)\b/i;

function wrapPlpgsqlDdl(sql: string, schemaName: string): string {
  const cleaned = String(sql || '')
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/'/g, "''");
  if (schemaName && schemaName !== 'public' && !/^\s*CREATE\s+SCHEMA\b/i.test(sql)) {
    const safeSchema = schemaName.replace(/"/g, '""').replace(/'/g, "''");
    return `DO LANGUAGE plpgsql $$ BEGIN EXECUTE 'SET LOCAL search_path TO "${safeSchema}", public'; EXECUTE '${cleaned}'; END $$`;
  }
  return `DO LANGUAGE plpgsql $$ BEGIN EXECUTE '${cleaned}'; END $$`;
}

function parseTcbResponseRows(resp: any): DbRow[] {
  const cols: string[] = Array.isArray(resp?.Columns)
    ? resp.Columns.map((c: any) => (typeof c === 'string' ? c : c?.Name || String(c)))
    : [];
  const rawRows: any[] = Array.isArray(resp?.Rows) ? resp.Rows : [];

  return rawRows.map((r) => {
    const arr = typeof r === 'string' ? JSON.parse(r) : Array.isArray(r) ? r : [];
    const obj: DbRow = {};
    cols.forEach((col, i) => {
      obj[col] = arr[i] !== undefined ? arr[i] : null;
    });
    return obj;
  });
}

async function callCloudBaseExecutePgSql(
  rawSql: string,
  retryWithWrap = true
): Promise<DbRow[]> {
  const creds = loadTencentCloudCredentials();
  if (!creds) {
    throw new Error('未找到腾讯云访问凭证或 DATABASE_URL，无法连接 CloudBase PostgreSQL');
  }

  const schemaName = DEFAULT_PG_SCHEMA;
  const trimmed = rawSql.trim();
  const shouldApplySchema =
    schemaName &&
    schemaName !== 'public' &&
    !/^\s*CREATE\s+SCHEMA\b/i.test(trimmed) &&
    !/\bsearch_path\b/i.test(trimmed) &&
    !/^\s*DO\s+LANGUAGE\s+plpgsql\b/i.test(trimmed);

  const effectiveSql = shouldApplySchema
    ? `SET search_path TO "${schemaName}", public; ${trimmed}`
    : trimmed;

  const host = 'tcb.tencentcloudapi.com';
  const service = 'tcb';
  const action = 'ExecutePGSql';
  const version = '2018-06-08';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const bodyStr = JSON.stringify({
    EnvId: DEFAULT_TCB_ENV_ID,
    Sql: effectiveSql,
  });

  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256HexStr(bodyStr),
  ].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256HexStr(canonicalRequest),
  ].join('\n');

  const secretDate = hmacSha256Buf(`TC3${creds.secretKey}`, date);
  const secretService = hmacSha256Buf(secretDate, service);
  const secretSigning = hmacSha256Buf(secretService, 'tc3_request');
  const signature = hmacSha256Hex(secretSigning, stringToSign);
  const authorization = `TC3-HMAC-SHA256 Credential=${creds.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    Authorization: authorization,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Region': DEFAULT_TCB_REGION,
    'X-TC-Timestamp': String(timestamp),
  };
  if (creds.token) {
    headers['X-TC-Token'] = creds.token;
  }

  try {
    const res = await fetch('https://tcb.tencentcloudapi.com/', {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    const data: any = await res.json();
    if (data?.Response?.Error) {
      throw new Error(
        `CloudBase PG 错误 (${data.Response.Error.Code}): ${data.Response.Error.Message}`
      );
    }
    return parseTcbResponseRows(data?.Response || data);
  } catch (err) {
    if (retryWithWrap && DDL_RE.test(trimmed)) {
      return callCloudBaseExecutePgSql(wrapPlpgsqlDdl(trimmed, schemaName), false);
    }
    throw err;
  }
}

export async function pgQuery(sql: string, params: any[] = []): Promise<DbRow[]> {
  // 1. 若配置了标准 postgresql:// 连接串，优先走原生 pg.Pool TCP 参数化协议
  const pool = getOrInitTcpPool();
  if (pool) {
    const res = await pool.query(sql, params);
    return Array.isArray(res?.rows) ? res.rows : [];
  }

  // 2. 否则走注入的 context.db 或腾讯云 CloudBase ExecutePGSql HTTP API
  const bound = bindSqlParams(sql, params);
  if (activeInjectedDb && activeInjectedDb.provider === 'cloudbase-pg') {
    const res = await activeInjectedDb.query(bound);
    return Array.isArray(res) ? res : Array.isArray(res?.rows) ? res.rows : [];
  }
  return callCloudBaseExecutePgSql(bound);
}

export async function pgExecute(sql: string, params: any[] = []): Promise<DbRow[]> {
  return pgQuery(sql, params);
}

// ============================================================================
// 密码哈希 (scrypt)、会话 Token 哈希 (SHA-256) 与 API Key 加解密 (AES-256-GCM)
// ============================================================================

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function hashSessionToken(token: string): string {
  const prefix = process.env.GLOSSA_SESSION_PREFIX || 'glossa-session-v1';
  return sha256HexStr(`${prefix}:${token}`);
}

function getMasterEncryptionKey(): Buffer {
  const secretSeed = String(
    process.env.GLOSSA_MASTER_KEY || process.env.LEXICON_MASTER_KEY || ''
  ).trim();
  if (secretSeed.length < 16) {
    throw new Error(
      'GLOSSA_MASTER_KEY environment variable (at least 16 characters) is required to encrypt or decrypt AI API keys'
    );
  }
  const kdfSalt = process.env.GLOSSA_KDF_SALT || 'glossa-aes-gcm-salt';
  return crypto.scryptSync(secretSeed, kdfSalt, 32);
}

export function encryptApiKey(plainKey: string): {
  cipher: string;
  iv: string;
  tag: string;
  masked: string;
} {
  const clean = String(plainKey || '').trim();
  if (!clean) {
    return { cipher: '', iv: '', tag: '', masked: '' };
  }
  const key = getMasterEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipherObj = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipherObj.update(clean, 'utf8'), cipherObj.final()]);
  const tag = cipherObj.getAuthTag();
  const masked =
    clean.length > 8
      ? `${clean.slice(0, 4)}****${clean.slice(-4)}`
      : `${clean.slice(0, 2)}****`;
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    masked,
  };
}

export function decryptApiKey(cipher: string, iv: string, tag: string): string {
  if (!cipher || !iv || !tag) return '';
  try {
    const key = getMasterEncryptionKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipher, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}
