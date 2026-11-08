import type { AgentTraceStep, TermEntry } from '@glossa/schema';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  streamingStatus?: string;
  selectedPhrase?: string;
  trace?: AgentTraceStep[];
  commits?: Array<{ repo: string; branch: string; commit: string; path: string }>;
  mode?: string;
  originTermId?: string;
  originTermTitle?: string;
  retryQuestion?: string;
  retrySnippet?: string;
}

export interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

export interface WorkerStatusState {
  online: boolean;
  activeWorkers: Array<{
    workerId: string;
    hostname: string;
    repoCount: number;
    lastHeartbeatAt: string;
  }>;
  pendingTasks: number;
  completedTasks: number;
  localWorktreeReady: boolean;
  localRepoCount: number;
  dbDriverMode: string;
}

export type MainTabType = 'article' | 'graph' | 'faq-hub' | 'decoder';
export type RightTabType = 'peek' | 'chat';
export type ScopeModeType = 'term' | 'category' | 'all';

const VALID_MAIN_TABS = new Set<MainTabType>([
  'article',
  'graph',
  'faq-hub',
  'decoder',
]);
const VALID_RIGHT_TABS = new Set<RightTabType>(['peek', 'chat']);
const VALID_SCOPES = new Set<ScopeModeType>(['term', 'category', 'all']);
const SESSION_BOOT_CACHE_KEY = 'glossa_boot_v1';

export function readUrlState() {
  if (typeof window === 'undefined') {
    return {
      tab: 'article' as MainTabType,
      term: 'fee-terminal',
      cat: 'all',
      rel: 'fee-terminal',
      vs: null as string | null,
      rtab: 'peek' as RightTabType,
      scope: 'term' as ScopeModeType,
      peek: ['marketing-activity'],
    };
  }
  const sp = new URLSearchParams(window.location.search);
  const rawTab = sp.get('tab') as MainTabType | null;
  const tab: MainTabType = rawTab && VALID_MAIN_TABS.has(rawTab) ? rawTab : 'article';
  const term = sp.get('term')?.trim() || 'fee-terminal';
  const cat = sp.get('cat')?.trim() || 'all';
  const rel = sp.get('rel')?.trim() || term;
  const vs = sp.get('vs')?.trim() || null;
  const rawRtab = sp.get('rtab') as RightTabType | null;
  const rtab: RightTabType = rawRtab && VALID_RIGHT_TABS.has(rawRtab) ? rawRtab : 'peek';
  const rawScope = sp.get('scope') as ScopeModeType | null;
  const scope: ScopeModeType = rawScope && VALID_SCOPES.has(rawScope) ? rawScope : 'term';
  const rawPeek = sp.get('peek')?.trim();
  const peek = rawPeek
    ? rawPeek
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [term || 'marketing-activity'];
  return {
    tab,
    term,
    cat,
    rel,
    vs,
    rtab,
    scope,
    peek: peek.length > 0 ? peek : ['marketing-activity'],
  };
}

export interface SessionBootCache {
  user: AuthUser;
  terms: TermEntry[];
  categories: Array<{ id: string; name: string }>;
}

export function readBootCache(): SessionBootCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_BOOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed?.user &&
      Array.isArray(parsed?.terms) &&
      parsed.terms.length > 0 &&
      Array.isArray(parsed?.categories)
    ) {
      return parsed as SessionBootCache;
    }
  } catch {}
  return null;
}

export function writeBootCache(cache: SessionBootCache) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_BOOT_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

export function clearBootCache() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SESSION_BOOT_CACHE_KEY);
  } catch {}
}

export function cleanCategoryLabel(rawName: string): string {
  return String(rawName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function cleanSidebarTermTitle(rawTitle: string): string {
  return String(rawTitle || '').replace(/^(?:攻略\s*ASOP|流程攻略)\s*[·•-]\s*/i, '').trim();
}

export function cleanBusinessSubtitle(raw?: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const afterDot = s.includes('·') ? s.split('·').slice(1).join('·').trim() : s;
  const cleaned = afterDot.replace(/跨\s*\d+\s*仓/g, '').trim();
  return /[\u4e00-\u9fa5]/.test(cleaned) ? cleaned : '';
}

export function isBusinessAlias(alias: string): boolean {
  const a = String(alias || '').trim();
  if (!a) return false;
  if (a.includes('=') || a.includes('_') || /^[a-z0-9]+-[a-z0-9-]+$/i.test(a) || /[a-z][A-Z]/.test(a)) {
    return false;
  }
  return /[\u4e00-\u9fa5]/.test(a) || /^[A-Z0-9]{2,8}$/i.test(a);
}
