import React, { useEffect, useRef } from 'react';
import type {
  AIConfig,
  FeedbackTicket,
  TermEntry,
} from '@glossa/schema';
import {
  hydrateMermaidDiagrams,
  type KeywordMatcher,
} from '../components/v5ArticleHtml';
import {
  type AuthUser,
  type ChatMessage,
  type MainTabType,
  type RightTabType,
  type ScopeModeType,
  type SessionBootCache,
  type WorkerStatusState,
  clearBootCache,
  readUrlState,
  writeBootCache,
} from '../components/lexiconUiHelpers';

export interface UseWorkbenchBootstrapAndEffectsParams {
  initialBoot: SessionBootCache | null;
  initialUrl: ReturnType<typeof readUrlState>;
  authStatus: 'checking' | 'unauthenticated' | 'authenticated';
  setAuthStatus: (s: 'checking' | 'unauthenticated' | 'authenticated') => void;
  authToken: string;
  setAuthToken: (t: string) => void;
  currentUser: AuthUser | null;
  setCurrentUser: (u: AuthUser | null) => void;
  loginUsername: string;
  loginPassword: string;
  setLoginPassword: (p: string) => void;
  setLoginError: (err: string) => void;
  setLoginLoading: (l: boolean) => void;
  setTerms: React.Dispatch<React.SetStateAction<TermEntry[]>>;
  setCategories: React.Dispatch<React.SetStateAction<Array<{ id: string; name: string }>>>;
  setWorkerStatus: React.Dispatch<React.SetStateAction<WorkerStatusState>>;
  setFeedbackTickets: React.Dispatch<React.SetStateAction<FeedbackTicket[]>>;
  setAiConfig: React.Dispatch<
    React.SetStateAction<AIConfig & { hasKey?: boolean; maskedKey?: string }>
  >;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  termMap: Map<string, TermEntry>;
  matchers: KeywordMatcher[];
  activeTerm: TermEntry | undefined;
  activeTermId: string;
  setActiveTermId: (id: string) => void;
  activeCategory: string;
  setActiveCategory: (cat: string) => void;
  mainTab: MainTabType;
  setMainTab: (tab: MainTabType) => void;
  rightTab: RightTabType;
  setRightTab: (tab: RightTabType) => void;
  rightDrawerOpen: boolean;
  setRightDrawerOpen: (open: boolean) => void;
  setExpandedTreeCats: React.Dispatch<React.SetStateAction<string[]>>;
  peekStack: string[];
  setPeekStack: React.Dispatch<React.SetStateAction<string[]>>;
  sidebarFocusTermId: string;
  graphCenterId: string;
  setGraphCenterId: (id: string) => void;
  compareTargetId: string | null;
  setCompareTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setComparePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  expandedAsopId: string | null;
  tabScopeMode: ScopeModeType;
  setTabScopeMode: (m: ScopeModeType) => void;
  setEgoExpandAll: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: (m: 'pc' | 'mobile') => void;
  mobileTab: 'read' | 'dir' | 'chat';
  mobileSheetOpen: boolean;
  setMobileSheetOpen: (open: boolean) => void;
  setCmdkOpen: (open: boolean) => void;
  setCmdkQuery: (q: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setEditModalOpen: (open: boolean) => void;
  setTopMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  chatMessages: ChatMessage[];
  decoderResult?: unknown;
  advisorTurnsCount?: number;
  lookupResult?: unknown;
  fullscreenMermaid: { code: string; title: string } | null;
  setFullscreenMermaid: (m: { code: string; title: string } | null) => void;
  pointerDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
}

export function useWorkbenchBootstrapAndEffects({
  initialBoot,
  initialUrl,
  authStatus,
  setAuthStatus,
  authToken,
  setAuthToken,
  currentUser,
  setCurrentUser,
  loginUsername,
  loginPassword,
  setLoginPassword,
  setLoginError,
  setLoginLoading,
  setTerms,
  setCategories,
  setWorkerStatus,
  setFeedbackTickets,
  setAiConfig,
  authHeaders,
  termMap,
  matchers,
  activeTerm,
  activeTermId,
  setActiveTermId,
  activeCategory,
  setActiveCategory,
  mainTab,
  setMainTab,
  rightTab,
  setRightTab,
  rightDrawerOpen,
  setRightDrawerOpen,
  setExpandedTreeCats,
  peekStack,
  setPeekStack,
  sidebarFocusTermId,
  graphCenterId,
  setGraphCenterId,
  compareTargetId,
  setCompareTargetId,
  setComparePickerOpen,
  expandedAsopId,
  tabScopeMode,
  setTabScopeMode,
  setEgoExpandAll,
  setViewMode,
  mobileTab,
  mobileSheetOpen,
  setMobileSheetOpen,
  setCmdkOpen,
  setCmdkQuery,
  setSettingsOpen,
  setEditModalOpen,
  setTopMenuOpen,
  chatMessages,
  decoderResult,
  advisorTurnsCount,
  lookupResult,
  fullscreenMermaid,
  setFullscreenMermaid,
  pointerDownPosRef,
}: UseWorkbenchBootstrapAndEffectsParams) {
  const prevActiveTermIdRef = useRef<string>(initialUrl.term);
  const isPopStateRef = useRef<boolean>(false);
  const lastMajorNavKeyRef = useRef<string>(
    `${initialUrl.tab}|${initialUrl.term}|${initialUrl.rel}|${initialUrl.vs || ''}`
  );

  // 加载受保护的全站词典数据
  const loadProtectedLexicon = async (tokenOverride?: string, userOverride?: AuthUser | null) => {
    const tkn = tokenOverride !== undefined ? tokenOverride : authToken;
    const headers: Record<string, string> = {};
    if (tkn) headers['Authorization'] = `Bearer ${tkn}`;

    const res = await fetch('/api/lexicon', {
      credentials: 'include',
      headers,
    });
    if (res.status === 401) {
      clearBootCache();
      setAuthStatus('unauthenticated');
      setTerms([]);
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (data?.ok) {
      const nextTerms = Array.isArray(data.terms) ? data.terms : [];
      const nextCategories = Array.isArray(data.categories) ? data.categories : [];
      if (nextTerms.length > 0) setTerms(nextTerms);
      if (nextCategories.length > 0) setCategories(nextCategories);
      const effectiveUser = userOverride !== undefined ? userOverride : currentUser;
      if (effectiveUser && nextTerms.length > 0) {
        writeBootCache({
          user: effectiveUser,
          terms: nextTerms,
          categories: nextCategories,
        });
      }
      if (data.workerStatus) {
        setWorkerStatus(data.workerStatus);
      }
      if (Array.isArray(data.feedbackTickets)) {
        setFeedbackTickets(data.feedbackTickets);
      }
      if (data.aiConfig) {
        setAiConfig((prev) => ({
          ...prev,
          protocol: data.aiConfig.protocol || 'openai-compatible',
          baseUrl: data.aiConfig.baseUrl || 'https://api.deepseek.com',
          model: data.aiConfig.model || 'deepseek-chat',
          hasKey: Boolean(data.aiConfig.hasKey),
          maskedKey: data.aiConfig.maskedKey || '',
          apiKey: '',
        }));
      }
    }
  };

  // 启动时校验服务端会话（先加载词典数据再切换状态，彻底消除刷新闪现登录页）
  useEffect(() => {
    async function checkSession() {
      try {
        const res = await fetch('/api/auth/me', {
          credentials: 'include',
          headers: authHeaders(),
        });
        if (!res.ok) {
          clearBootCache();
          setAuthStatus('unauthenticated');
          return;
        }
        const data = await res.json();
        if (data?.ok && data.authenticated) {
          setCurrentUser(data.user);
          await loadProtectedLexicon(undefined, data.user);
          setAuthStatus('authenticated');
        } else {
          clearBootCache();
          setAuthStatus('unauthenticated');
        }
      } catch {
        if (!initialBoot) {
          setAuthStatus('unauthenticated');
        }
      }
    }
    checkSession();
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setLoginError(data?.error || '登录失败，请检查账号或口令');
        setLoginLoading(false);
        return;
      }
      if (data.token) {
        setAuthToken(data.token);
      }
      setCurrentUser(data.user);
      setLoginPassword('');
      await loadProtectedLexicon(data.token, data.user);
      setAuthStatus('authenticated');
    } catch {
      setLoginError('网络请求异常，请确认后端服务在线');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
      });
    } catch {}
    clearBootCache();
    setAuthToken('');
    setCurrentUser(null);
    setTerms([]);
    setAuthStatus('unauthenticated');
  };

  // 当主词条或关联中心词条切换时，自动展开其所属目录树分组并滚动到可视区域
  useEffect(() => {
    const focusTerm = termMap.get(sidebarFocusTermId);
    if (!focusTerm?.category) return;
    setExpandedTreeCats((prev) =>
      prev.includes(focusTerm.category) ? prev : [...prev, focusTerm.category]
    );
    const timer = window.setTimeout(() => {
      const el = document.querySelector(
        `[data-sidebar-term-id="${sidebarFocusTermId}"]`
      ) as HTMLElement | null;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [sidebarFocusTermId, termMap]);

  // 监听浏览器前进/后退 (popstate)，还原 URL 查询参数对应的工作台状态
  useEffect(() => {
    const onPopState = () => {
      isPopStateRef.current = true;
      const next = readUrlState();
      const sp = new URLSearchParams(window.location.search);
      setMainTab(next.tab);
      setActiveTermId(next.term);
      prevActiveTermIdRef.current = next.term;
      setActiveCategory(next.cat);
      setGraphCenterId(next.rel);
      setCompareTargetId(next.vs);
      setComparePickerOpen(Boolean(next.vs));
      setRightTab(next.rtab);
      setRightDrawerOpen(Boolean(sp.get('rtab') || sp.get('peek')));
      setTabScopeMode(next.scope);
      setPeekStack(next.peek);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 将当前选中的视图、词条、分类、关联中心与对比目标实时同步至 URL 与页面标题
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const sp = new URLSearchParams();
    sp.set('tab', mainTab);
    sp.set('term', activeTermId);
    if (activeCategory !== 'all') sp.set('cat', activeCategory);
    if (mainTab === 'graph' && graphCenterId && graphCenterId !== activeTermId) {
      sp.set('rel', graphCenterId);
    }
    if (mainTab === 'graph' && compareTargetId) {
      sp.set('vs', compareTargetId);
    }
    if (rightDrawerOpen) {
      sp.set('rtab', rightTab);
      const peekStr = peekStack.join(',');
      if (peekStr && peekStr !== activeTermId && peekStr !== 'marketing-activity') {
        sp.set('peek', peekStr);
      }
    }
    if (tabScopeMode !== 'term') sp.set('scope', tabScopeMode);
    const nextSearch = `?${sp.toString()}`;
    const majorKey = `${mainTab}|${activeTermId}|${graphCenterId}|${compareTargetId || ''}`;
    if (window.location.search !== nextSearch) {
      if (isPopStateRef.current) {
        isPopStateRef.current = false;
      } else if (lastMajorNavKeyRef.current !== majorKey) {
        window.history.pushState(null, '', nextSearch);
      } else {
        window.history.replaceState(null, '', nextSearch);
      }
    } else {
      isPopStateRef.current = false;
    }
    lastMajorNavKeyRef.current = majorKey;

    const currentTitleTerm =
      mainTab === 'graph' ? termMap.get(graphCenterId) || activeTerm : activeTerm;
    if (currentTitleTerm?.title) {
      document.title = `${currentTitleTerm.title} · Glossa`;
    }
  }, [
    authStatus,
    mainTab,
    activeTermId,
    activeCategory,
    graphCenterId,
    compareTargetId,
    rightTab,
    rightDrawerOpen,
    tabScopeMode,
    peekStack,
    activeTerm,
    termMap,
  ]);

  // 响应式窗口监听
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 960) setViewMode('mobile');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 全局快捷键 Cmd+K / Esc
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(true);
        setCmdkQuery('');
      } else if (e.key === 'Escape') {
        setCmdkOpen(false);
        setSettingsOpen(false);
        setEditModalOpen(false);
        setMobileSheetOpen(false);
        setTopMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 仅在用户实际切换 activeTermId 时同步关联中心
  useEffect(() => {
    if (prevActiveTermIdRef.current !== activeTermId) {
      prevActiveTermIdRef.current = activeTermId;
      if (activeTerm?.id) {
        setGraphCenterId(activeTerm.id);
      }
      setEgoExpandAll(false);
    }
  }, [activeTermId, activeTerm]);

  // 全局监听鼠标按下位置，用于区分 Mermaid panzoom 拖拽与节点点击
  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      pointerDownPosRef.current = { x: ev.clientX, y: ev.clientY };
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, []);

  // 使用官方 mermaid + panzoom 自动挂载正文、抽屉、AI 对话与全屏弹窗中的所有流程图
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const timer = window.setTimeout(() => {
      hydrateMermaidDiagrams(document.body, matchers, (code, title) => {
        setFullscreenMermaid({ code, title });
      }).catch(() => {});
    }, 30);
    return () => window.clearTimeout(timer);
  }, [
    authStatus,
    activeTermId,
    graphCenterId,
    expandedAsopId,
    mainTab,
    rightTab,
    mobileTab,
    mobileSheetOpen,
    peekStack,
    chatMessages,
    decoderResult,
    advisorTurnsCount,
    lookupResult,
    fullscreenMermaid,
    matchers,
  ]);

  return {
    handleLoginSubmit,
    handleLogout,
  };
}
