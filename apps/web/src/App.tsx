import React, { useMemo, useRef, useState } from 'react';
import type {
  AIConfig,
  FeedbackTicket,
  TermEntry,
} from '@glossa/schema';
import {
  buildKeywordMatchers,
} from './components/v5ArticleHtml';
import {
  type AuthUser,
  type MainTabType,
  type RightTabType,
  type ScopeModeType,
  type WorkerStatusState,
  cleanCategoryLabel,
  readBootCache,
  readUrlState,
} from './components/lexiconUiHelpers';
import { FaqHubView, JargonDecoderView } from './components/FaqAndDecoderViews';
import { TermArticleView } from './components/TermArticleView';
import { RelationCompareWorkspace } from './components/RelationCompareWorkspace';
import { CompanionChatPanel, PeekCardView } from './components/RightCompanionDrawer';
import {
  AiSettingsModal,
  CmdkSearchModal,
  TermEditModal,
} from './components/SearchSettingsEditModals';
import {
  FeedbackTicketsModal,
  RevisionHistoryModal,
} from './components/FeedbackAndRevisionModals';
import {
  FullscreenMermaidModal,
  SproutHarnessModal,
} from './components/SproutHarnessModal';
import {
  HoverTermPopover,
  LoginScreen,
  PcSidebarTree,
  SelectionActionBar,
  TopbarHeader,
} from './components/WorkbenchShells';
import { useAgentAndSproutActions } from './hooks/useAgentAndSproutActions';
import { useTermAndFeedbackActions } from './hooks/useTermAndFeedbackActions';
import { useWorkbenchBootstrapAndEffects } from './hooks/useWorkbenchBootstrapAndEffects';

export function App() {
  const initialBoot = useMemo(() => readBootCache(), []);
  const initialUrl = useMemo(() => readUrlState(), []);

  // 鉴权状态：若同标签页已缓存有效会话与词库，则刷新时直接原位渲染，后台静默核验会话
  const [authStatus, setAuthStatus] = useState<'checking' | 'unauthenticated' | 'authenticated'>(
    () => (initialBoot ? 'authenticated' : 'checking')
  );
  const [authToken, setAuthToken] = useState<string>('');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => initialBoot?.user || null);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const [terms, setTerms] = useState<TermEntry[]>(() => initialBoot?.terms || []);
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>(
    () => initialBoot?.categories || []
  );
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusState>({
    online: false,
    activeWorkers: [],
    pendingTasks: 0,
    completedTasks: 0,
    localWorktreeReady: false,
    localRepoCount: 0,
    dbDriverMode: 'drizzle-cloudbase-http',
  });

  const [activeTermId, setActiveTermId] = useState<string>(() => initialUrl.term);
  const [activeCategory, setActiveCategory] = useState<string>(() => initialUrl.cat);
  const [mainTab, setMainTab] = useState<MainTabType>(() => initialUrl.tab);
  const [rightTab, setRightTab] = useState<RightTabType>(() => initialUrl.rtab);
  const [rightDrawerOpen, setRightDrawerOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const sp = new URLSearchParams(window.location.search);
    return Boolean(sp.get('rtab') || sp.get('peek'));
  });
  const [expandedTreeCats, setExpandedTreeCats] = useState<string[]>(() =>
    initialUrl.cat !== 'all' ? [initialUrl.cat] : ['core']
  );
  const [peekStack, setPeekStack] = useState<string[]>(() => initialUrl.peek);
  const [toastNotice, setToastNotice] = useState<string>('');
  const [feedbackTickets, setFeedbackTickets] = useState<FeedbackTicket[]>([]);

  // 高频排障 FAQ 中心筛选状态
  const [faqSearchQuery, setFaqSearchQuery] = useState('');
  const [faqCategoryFilter, setFaqCategoryFilter] = useState('all');

  // 双端自适应视图状态
  const [viewMode, setViewMode] = useState<'pc' | 'mobile'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 1024 ? 'mobile' : 'pc'
  );
  const [mobileTab, setMobileTab] = useState<'read' | 'dir' | 'chat'>('read');
  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(false);

  // 浮层与搜索状态
  const [hoverInfo, setHoverInfo] = useState<{
    term: TermEntry;
    x: number;
    y: number;
  } | null>(null);
  const [selectionBar, setSelectionBar] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const [sidebarFilter, setSidebarFilter] = useState('');

  // AI 配置状态（持久化在 PostgreSQL，前端仅持有脱敏掩码与表单输入）
  const [aiConfig, setAiConfig] = useState<AIConfig & { hasKey?: boolean; maskedKey?: string }>({
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    hasKey: false,
    maskedKey: '',
  });

  const hoverTimerRef = useRef<number | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const [graphCenterId, setGraphCenterId] = useState<string>(() => initialUrl.rel);
  const [graphSearchQuery, setGraphSearchQuery] = useState<string>('');
  const [compareTargetId, setCompareTargetId] = useState<string | null>(() => initialUrl.vs);
  const [comparePickerOpen, setComparePickerOpen] = useState<boolean>(() => Boolean(initialUrl.vs));
  const [compareSearchQuery, setCompareSearchQuery] = useState<string>('');
  const [expandedAsopId, setExpandedAsopId] = useState<string | null>(null);
  const [tabScopeMode, setTabScopeMode] = useState<ScopeModeType>(() => initialUrl.scope);
  const [egoExpandAll, setEgoExpandAll] = useState<boolean>(false);
  const [fullscreenMermaid, setFullscreenMermaid] = useState<{
    code: string;
    title: string;
  } | null>(null);

  const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = { ...extra };
    if (authToken) h['Authorization'] = `Bearer ${authToken}`;
    return h;
  };

  const showNotice = (msg: string) => {
    setToastNotice(msg);
    window.setTimeout(() => setToastNotice(''), 3200);
  };

  const termMap = useMemo(() => new Map(terms.map((t) => [t.id, t])), [terms]);
  const matchers = useMemo(() => buildKeywordMatchers(terms), [terms]);
  const activeTerm = termMap.get(activeTermId) || terms[0];
  const currentPeekId = peekStack[peekStack.length - 1] || '';
  const peekTerm = termMap.get(currentPeekId) || terms[1] || terms[0];
  const sidebarFocusTermId = mainTab === 'graph' ? graphCenterId : activeTerm?.id || activeTermId;

  const openRightPanel = (tab: RightTabType) => {
    setRightTab(tab);
    setRightDrawerOpen(true);
  };

  // 领域 Hook 1：AI Agent 问答流、业务参谋与「抓到触手，引爆全场」裂变记忆引擎
  const {
    chatSessionId,
    chatSessions,
    chatInput,
    setChatInput,
    chatLoading,
    chatMessages,
    stopAgentHarness,
    askAgentHarness,
    loadChatSessions,
    switchChatSession,
    startNewChatSession,
    handleSaveFaq,
    decoderInput,
    setDecoderInput,
    advisorSessionId,
    advisorTurns,
    startNewAdvisorSession,
    advisorSkill,
    setAdvisorSkill,
    advisorEngine,
    setAdvisorEngine,
    decoderLoading,
    decoderResult,
    handleDecodeParagraph,
    sproutModalOpen,
    setSproutModalOpen,
    sproutTab,
    setSproutTab,
    sproutRuns,
    sproutCandidates,
    sproutTermCandidates,
    sproutStats,
    sproutBusy,
    resolvingCandidateId,
    aliasTargetOverrides,
    setAliasTargetOverrides,
    lookupInput,
    setLookupInput,
    lookupResult,
    setLookupResult,
    lookupLoading,
    openSproutModal,
    handleDissectTerm,
    handleResolveSprout,
    handleRunSproutWave,
    handleConceptLookup,
  } = useAgentAndSproutActions({
    activeTerm,
    termMap,
    viewMode,
    setMobileSheetOpen,
    setMobileTab,
    openRightPanel,
    setSelectionBar,
    setAuthStatus,
    setTerms,
    authHeaders,
    showNotice,
  });

  // 领域 Hook 2：词条自演化、版本时光机、共建工单与 AI 引擎配置
  const {
    feedbackModalOpen,
    setFeedbackModalOpen,
    feedbackTab,
    setFeedbackTab,
    resolvingTicketId,
    revisionModalOpen,
    setRevisionModalOpen,
    termRevisions,
    selectedRevision,
    setSelectedRevision,
    revisionLoading,
    settingsOpen,
    setSettingsOpen,
    aiSaveMsg,
    aiTesting,
    editModalOpen,
    setEditModalOpen,
    editSaving,
    editForm,
    setEditForm,
    handleGenerateNewTerm,
    handleAdoptAiAnswerAsTerm,
    openRevisionModal,
    handleRollbackRevision,
    handlePublishTerm,
    openEditTermModal,
    handleSaveTermEdit,
    handleDeleteTerm,
    handleTestAiConnection,
    handleSaveAiConfig,
    handleRecordFeedback,
    handleResolveFeedbackTicket,
    handleAiResolveMissingTicket,
  } = useTermAndFeedbackActions({
    terms,
    setTerms,
    termMap,
    activeTerm,
    activeTermId,
    setActiveTermId,
    setMainTab,
    viewMode,
    setMobileTab,
    setSelectionBar,
    setCmdkOpen,
    setAuthStatus,
    chatMessages,
    feedbackTickets,
    setFeedbackTickets,
    aiConfig,
    setAiConfig,
    authHeaders,
    showNotice,
  });

  // 领域 Hook 3：会话启动核验、URL 查询参数与浏览器前进/后退同步、快捷键与 Mermaid 挂载
  const { handleLoginSubmit, handleLogout } = useWorkbenchBootstrapAndEffects({
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
    advisorTurnsCount: advisorTurns.length,
    lookupResult,
    fullscreenMermaid,
    setFullscreenMermaid,
    pointerDownPosRef,
  });

  const focusGraphCenter = (tid: string) => {
    if (!tid || !termMap.has(tid)) return;
    setGraphCenterId(tid);
    setGraphSearchQuery('');
    setExpandedAsopId(null);
    setCompareTargetId((prev) => (prev === tid ? null : prev));
    setCmdkOpen(false);
  };

  // 处理正文中点击或悬停双链蓝词 (.term-link) 与 Mermaid 节点 ([data-peek-term])
  const handleContainerClick = (e: React.MouseEvent<HTMLElement>) => {
    if (pointerDownPosRef.current) {
      const dist = Math.hypot(
        e.clientX - pointerDownPosRef.current.x,
        e.clientY - pointerDownPosRef.current.y
      );
      if (dist > 6) return;
    }
    const target = e.target as HTMLElement;
    const linkEl = target.closest('.term-link') || target.closest('[data-peek-term]');
    if (!linkEl) return;
    const tid =
      linkEl.getAttribute('data-term-id') || linkEl.getAttribute('data-peek-term');
    if (!tid || !termMap.has(tid)) return;

    setPeekStack((prev) => (prev[prev.length - 1] === tid ? prev : [...prev, tid]));
    setHoverInfo(null);

    if (viewMode === 'mobile') {
      setMobileSheetOpen(true);
    } else {
      openRightPanel('peek');
    }
  };

  const handleContainerMouseOver = (e: React.MouseEvent<HTMLElement>) => {
    if (viewMode === 'mobile') return;
    const target = e.target as HTMLElement;
    const linkEl = target.closest('.term-link') as HTMLElement | null;
    if (!linkEl) return;

    const tid = linkEl.getAttribute('data-term-id');
    const t = tid ? termMap.get(tid) : undefined;
    if (!t) return;

    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    const rect = linkEl.getBoundingClientRect();
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - 368));
    const y =
      rect.bottom + 8 + 250 > window.innerHeight ? rect.top - 240 : rect.bottom + 8;
    setHoverInfo({ term: t, x, y: Math.max(12, y) });
  };

  const handleContainerMouseOut = () => {
    if (viewMode === 'mobile') return;
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverInfo(null);
    }, 220);
  };

  const handleMouseUpSelection = () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (text.length >= 2 && text.length <= 180) {
      try {
        const rect = sel!.getRangeAt(0).getBoundingClientRect();
        setSelectionBar({
          text,
          x: Math.max(16, Math.min(rect.left, window.innerWidth - 340)),
          y: Math.max(12, rect.top - 46),
        });
      } catch {}
    } else {
      setSelectionBar(null);
    }
  };

  const openTermAsMain = (tid: string) => {
    setActiveTermId(tid);
    setMainTab('article');
    setHoverInfo(null);
    setCmdkOpen(false);
    setMobileSheetOpen(false);
    if (viewMode === 'mobile') setMobileTab('read');
  };

  const backlinks = useMemo(() => {
    if (!activeTerm) return [];
    return terms.filter((t) => {
      if (t.id === activeTerm.id) return false;
      const inRel = (t.relations || []).some((r) => r.target === activeTerm.id);
      const blob =
        t.summary + t.layman.analogy + t.layman.plain + (t.articleMarkdown || '');
      return inRel || blob.includes(activeTerm.title);
    });
  }, [terms, activeTerm]);

  const sidebarFilteredAllTerms = useMemo(() => {
    const q = sidebarFilter.trim().toLowerCase();
    if (!q) return terms;
    return terms.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.pinyin.toLowerCase().includes(q) ||
        (t.subtitle || '').toLowerCase().includes(q) ||
        (t.aliases || []).some((a) => a.toLowerCase().includes(q))
    );
  }, [terms, sidebarFilter]);

  const filteredTerms = useMemo(() => {
    if (activeCategory === 'all') return sidebarFilteredAllTerms;
    return sidebarFilteredAllTerms.filter((t) => t.category === activeCategory);
  }, [sidebarFilteredAllTerms, activeCategory]);

  const cmdkMatches = useMemo(() => {
    const q = cmdkQuery.trim().toLowerCase();
    if (!q) return terms;
    return terms.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.pinyin.toLowerCase().includes(q) ||
        (t.subtitle || '').toLowerCase().includes(q) ||
        t.aliases.some((a) => a.toLowerCase().includes(q)) ||
        t.summary.toLowerCase().includes(q)
    );
  }, [terms, cmdkQuery]);

  const categoryName = cleanCategoryLabel(
    categories.find((c) => c.id === activeTerm?.category)?.name || '核心概念'
  );

  const openTicketsCount = useMemo(
    () =>
      feedbackTickets.filter((t) => t.status === 'OPEN' || t.status === 'TRIAGING')
        .length,
    [feedbackTickets]
  );

  const myResolvedTickets = useMemo(
    () =>
      feedbackTickets.filter(
        (t) =>
          t.reporter === currentUser?.username && t.status === 'RESOLVED_UPDATED'
      ),
    [feedbackTickets, currentUser]
  );

  const allFaqItems = useMemo(() => {
    const items: Array<{
      termId: string;
      termTitle: string;
      category: string;
      q: string;
      a: string;
    }> = [];
    for (const t of terms) {
      for (const f of t.faqs || []) {
        items.push({
          termId: t.id,
          termTitle: t.title,
          category: t.category,
          q: f.q,
          a: f.a,
        });
      }
    }
    return items;
  }, [terms]);

  // 当前选中词条及其直接 1 度上下游的 ID 集合（用于顶部 Tab 与左侧选中词条的智能联动过滤）
  const activeTermNeighborhoodIds = useMemo(() => {
    const s = new Set<string>();
    if (!activeTerm) return s;
    s.add(activeTerm.id);
    for (const r of activeTerm.relations || []) {
      if (r.target) s.add(r.target);
    }
    for (const t of terms) {
      if ((t.relations || []).some((r) => r.target === activeTerm.id)) {
        s.add(t.id);
      }
    }
    return s;
  }, [activeTerm, terms]);

  const renderMainStageView = () => {
    if (mainTab === 'graph') {
      return (
        <RelationCompareWorkspace
          terms={terms}
          termMap={termMap}
          categories={categories}
          activeTerm={activeTerm}
          graphCenterId={graphCenterId}
          setGraphCenterId={setGraphCenterId}
          graphSearchQuery={graphSearchQuery}
          setGraphSearchQuery={setGraphSearchQuery}
          compareTargetId={compareTargetId}
          setCompareTargetId={setCompareTargetId}
          comparePickerOpen={comparePickerOpen}
          setComparePickerOpen={setComparePickerOpen}
          compareSearchQuery={compareSearchQuery}
          setCompareSearchQuery={setCompareSearchQuery}
          expandedAsopId={expandedAsopId}
          setExpandedAsopId={setExpandedAsopId}
          viewMode={viewMode}
          matchers={matchers}
          focusGraphCenter={focusGraphCenter}
          openTermAsMain={openTermAsMain}
          setPeekStack={setPeekStack}
          setMobileSheetOpen={setMobileSheetOpen}
          openRightPanel={openRightPanel}
          handleContainerClick={handleContainerClick}
          handleContainerMouseOver={handleContainerMouseOver}
          handleContainerMouseOut={handleContainerMouseOut}
        />
      );
    }
    if (mainTab === 'faq-hub') {
      return (
        <FaqHubView
          activeTerm={activeTerm}
          activeCategory={activeCategory}
          categories={categories}
          allFaqItems={allFaqItems}
          activeTermNeighborhoodIds={activeTermNeighborhoodIds}
          faqSearchQuery={faqSearchQuery}
          setFaqSearchQuery={setFaqSearchQuery}
          faqCategoryFilter={faqCategoryFilter}
          setFaqCategoryFilter={setFaqCategoryFilter}
          tabScopeMode={tabScopeMode}
          setTabScopeMode={setTabScopeMode}
          setMainTab={setMainTab}
          setActiveTermId={setActiveTermId}
          askAgentHarness={askAgentHarness}
          openTermAsMain={openTermAsMain}
          matchers={matchers}
          handleContainerClick={handleContainerClick}
          handleContainerMouseOver={handleContainerMouseOver}
          handleContainerMouseOut={handleContainerMouseOut}
        />
      );
    }
    if (mainTab === 'decoder') {
      return (
        <JargonDecoderView
          activeTerm={activeTerm}
          termMap={termMap}
          aiHasKey={aiConfig.hasKey}
          aiModel={aiConfig.model}
          decoderInput={decoderInput}
          setDecoderInput={setDecoderInput}
          advisorSessionId={advisorSessionId}
          advisorTurns={advisorTurns}
          startNewAdvisorSession={startNewAdvisorSession}
          advisorSkill={advisorSkill}
          setAdvisorSkill={setAdvisorSkill}
          advisorEngine={advisorEngine}
          setAdvisorEngine={setAdvisorEngine}
          decoderLoading={decoderLoading}
          decoderResult={decoderResult}
          handleDecodeParagraph={handleDecodeParagraph}
          handleGenerateNewTerm={handleGenerateNewTerm}
          handleRecordFeedback={handleRecordFeedback}
          setMainTab={setMainTab}
          openTermAsMain={openTermAsMain}
          matchers={matchers}
          handleContainerClick={handleContainerClick}
          handleContainerMouseOver={handleContainerMouseOver}
          handleContainerMouseOut={handleContainerMouseOut}
        />
      );
    }

    return (
      <TermArticleView
        activeTerm={activeTerm}
        categoryName={categoryName}
        viewMode={viewMode}
        termMap={termMap}
        backlinks={backlinks}
        egoExpandAll={egoExpandAll}
        setEgoExpandAll={setEgoExpandAll}
        matchers={matchers}
        setMainTab={setMainTab}
        focusGraphCenter={focusGraphCenter}
        setCompareTargetId={setCompareTargetId}
        setComparePickerOpen={setComparePickerOpen}
        setPeekStack={setPeekStack}
        setMobileSheetOpen={setMobileSheetOpen}
        openRightPanel={openRightPanel}
        handlePublishTerm={handlePublishTerm}
        openSproutModal={openSproutModal}
        openRevisionModal={openRevisionModal}
        openEditTermModal={openEditTermModal}
        handleDeleteTerm={handleDeleteTerm}
        handleContainerClick={handleContainerClick}
        handleContainerMouseOver={handleContainerMouseOver}
        handleContainerMouseOut={handleContainerMouseOut}
        handleMouseUpSelection={handleMouseUpSelection}
      />
    );
  };

  if (authStatus === 'unauthenticated') {
    return (
      <LoginScreen
        loginUsername={loginUsername}
        setLoginUsername={setLoginUsername}
        loginPassword={loginPassword}
        setLoginPassword={setLoginPassword}
        loginError={loginError}
        loginLoading={loginLoading}
        handleLoginSubmit={handleLoginSubmit}
      />
    );
  }

  if (authStatus === 'checking') {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F8FAFC',
          color: '#64748B',
          fontSize: 13.5,
          fontWeight: 500,
        }}
      >
        正在加载 Glossa 知识库...
      </div>
    );
  }

  if (!activeTerm) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F8FAFC',
          padding: 24,
        }}
      >
        <div
          className="layer-card"
          style={{
            maxWidth: 560,
            width: '100%',
            padding: '28px 26px',
            background: '#FFFFFF',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div className="brand-badge">G</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>
                欢迎使用 Glossa 领域百科与参谋引擎
              </div>
              <div style={{ fontSize: 12.5, color: '#64748B' }}>
                当前数据库尚无词条记录 · 请播种首个核心概念或导入知识快照
              </div>
            </div>
          </div>

          <p style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.7, marginBottom: 16 }}>
            Glossa 采用纯粹的「空壳引擎 + 数据库自洽」架构。您可以直接输入贵项目的第一个核心领域词，由引擎结合本地代码仓自动考据生成首篇词条，随后使用<strong>「触手裂变」</strong>顺藤摸瓜生长出整座业务百科。
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input
              value={cmdkQuery}
              onChange={(e) => setCmdkQuery(e.target.value)}
              placeholder="输入首个核心业务概念（例如：订单履约、账户授信、门店准入）..."
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 13.5,
              }}
            />
            <button
              className="btn btn-primary"
              disabled={!cmdkQuery.trim()}
              onClick={() =>
                handleGenerateNewTerm(
                  cmdkQuery.trim(),
                  undefined,
                  undefined,
                  categories.find((c) => c.id !== 'asop')?.id || categories[0]?.id || 'core'
                )
              }
            >
              播种首个词条
            </button>
          </div>

          <div
            style={{
              fontSize: 12,
              color: '#64748B',
              background: '#F8FAFC',
              border: '1px solid #E2E8F0',
              borderRadius: 8,
              padding: '10px 12px',
              lineHeight: 1.6,
            }}
          >
            <div><strong>命令行导入已有知识库快照：</strong></div>
            <code>pnpm data:import ./my-domain-snapshot.json</code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {toastNotice && (
        <div
          style={{
            position: 'fixed',
            top: 64,
            right: 20,
            zIndex: 9999,
            background: '#0F172A',
            color: '#FFFFFF',
            padding: '10px 16px',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: '0 10px 25px rgba(0,0,0,0.18)',
          }}
        >
          {toastNotice}
        </div>
      )}

      {/* 顶栏导航 */}
      <TopbarHeader
        mainTab={mainTab}
        setMainTab={setMainTab}
        activeTerm={activeTerm}
        focusGraphCenter={focusGraphCenter}
        allFaqCount={allFaqItems.length}
        viewMode={viewMode}
        setViewMode={setViewMode}
        setCmdkOpen={setCmdkOpen}
        rightDrawerOpen={rightDrawerOpen}
        setRightDrawerOpen={setRightDrawerOpen}
        openRightPanel={openRightPanel}
        openSproutModal={openSproutModal}
        sproutPendingCount={sproutStats.pendingCount}
        setFeedbackModalOpen={setFeedbackModalOpen}
        openTicketsCount={openTicketsCount}
        myResolvedTickets={myResolvedTickets}
        topMenuOpen={topMenuOpen}
        setTopMenuOpen={setTopMenuOpen}
        workerStatus={workerStatus}
        aiHasKey={aiConfig.hasKey}
        aiModel={aiConfig.model}
        currentUser={currentUser}
        setSettingsOpen={setSettingsOpen}
        handleLogout={handleLogout}
      />

      {/* PC 端工作台壳层（默认左目录树 + 主视图两栏，右侧伴读/速览抽屉按需展开） */}
      {viewMode === 'pc' ? (
        <main className={`workbench ${rightDrawerOpen ? 'with-right-drawer' : ''}`}>
          <PcSidebarTree
            terms={terms}
            termMap={termMap}
            categories={categories}
            sidebarFilter={sidebarFilter}
            setSidebarFilter={setSidebarFilter}
            sidebarFilteredAllTerms={sidebarFilteredAllTerms}
            mainTab={mainTab}
            tabScopeMode={tabScopeMode}
            setTabScopeMode={setTabScopeMode}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            expandedTreeCats={expandedTreeCats}
            setExpandedTreeCats={setExpandedTreeCats}
            sidebarFocusTermId={sidebarFocusTermId}
            focusGraphCenter={focusGraphCenter}
            setActiveTermId={setActiveTermId}
            openTermAsMain={openTermAsMain}
          />

          <section className="main-stage">{renderMainStageView()}</section>

          {rightDrawerOpen && (
            <aside className="copilot-panel">
              <div
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--surface)',
                }}
              >
                <button
                  className={`btn ${rightTab === 'peek' ? 'btn-primary' : ''}`}
                  style={{ flex: 1, justifyContent: 'center', padding: '5px 8px' }}
                  onClick={() => setRightTab('peek')}
                >
                  词条速览
                </button>
                <button
                  className={`btn ${rightTab === 'chat' ? 'btn-primary' : ''}`}
                  style={{ flex: 1, justifyContent: 'center', padding: '5px 8px' }}
                  onClick={() => setRightTab('chat')}
                >
                  问答助手
                </button>
                <button
                  className="btn"
                  style={{ padding: '5px 8px', color: 'var(--muted)' }}
                  onClick={() => setRightDrawerOpen(false)}
                  title="收起右侧边栏"
                >
                  ✕
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {rightTab === 'peek' && (
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    <PeekCardView
                      targetTerm={peekTerm}
                      terms={terms}
                      termMap={termMap}
                      activeTerm={activeTerm}
                      graphCenterId={graphCenterId}
                      mainTab={mainTab}
                      peekStack={peekStack}
                      setPeekStack={setPeekStack}
                      matchers={matchers}
                      focusGraphCenter={focusGraphCenter}
                      setMobileSheetOpen={setMobileSheetOpen}
                      openTermAsMain={openTermAsMain}
                      handleContainerClick={handleContainerClick}
                      handleContainerMouseOver={handleContainerMouseOver}
                      handleContainerMouseOut={handleContainerMouseOut}
                    />
                  </div>
                )}
                {rightTab === 'chat' && (
                  <CompanionChatPanel
                    activeTerm={activeTerm}
                    matchers={matchers}
                    chatSessionId={chatSessionId}
                    chatSessions={chatSessions}
                    chatMessages={chatMessages}
                    chatInput={chatInput}
                    setChatInput={setChatInput}
                    chatLoading={chatLoading}
                    loadChatSessions={loadChatSessions}
                    switchChatSession={switchChatSession}
                    startNewChatSession={startNewChatSession}
                    stopAgentHarness={stopAgentHarness}
                    askAgentHarness={askAgentHarness}
                    handleSaveFaq={handleSaveFaq}
                    handleAdoptAiAnswerAsTerm={handleAdoptAiAnswerAsTerm}
                    handleContainerClick={handleContainerClick}
                    handleMouseUpSelection={handleMouseUpSelection}
                  />
                )}
              </div>
            </aside>
          )}
        </main>
      ) : (
        /* 移动端壳层 */
        <main className="mobile-shell">
          <div className="mobile-stage">
            {mobileTab === 'read' && renderMainStageView()}

            {mobileTab === 'dir' && (
              <div className="layer-card">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <h3 style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)' }}>
                    词条目录 ({terms.length})
                  </h3>
                  <button className="btn btn-primary" onClick={() => setCmdkOpen(true)}>
                    搜索词条
                  </button>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    overflowX: 'auto',
                    paddingBottom: 10,
                    marginBottom: 10,
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <button
                    className={`btn ${activeCategory === 'all' ? 'btn-primary' : ''}`}
                    onClick={() => setActiveCategory('all')}
                  >
                    全部
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      className={`btn ${activeCategory === c.id ? 'btn-primary' : ''}`}
                      onClick={() => setActiveCategory(c.id)}
                    >
                      {cleanCategoryLabel(c.name)}
                    </button>
                  ))}
                </div>
                {filteredTerms.map((t) => (
                  <div
                    key={t.id}
                    className={`nav-item ${(mainTab === 'graph' ? graphCenterId : activeTerm.id) === t.id ? 'active' : ''}`}
                    onClick={() => {
                      if (mainTab === 'graph') {
                        focusGraphCenter(t.id);
                        setMobileTab('read');
                      } else {
                        openTermAsMain(t.id);
                      }
                    }}
                    style={{ padding: '12px 10px', borderBottom: '1px solid var(--line)' }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{t.title}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {t.summary.slice(0, 46)}...
                      </div>
                    </div>
                    <span className="badge badge-blue">{t.pinyin}</span>
                  </div>
                ))}
              </div>
            )}

            {mobileTab === 'chat' && (
              <div
                className="layer-card"
                style={{ height: 'calc(100vh - 150px)', padding: 0, overflow: 'hidden' }}
              >
                <CompanionChatPanel
                  activeTerm={activeTerm}
                  matchers={matchers}
                  chatSessionId={chatSessionId}
                  chatSessions={chatSessions}
                  chatMessages={chatMessages}
                  chatInput={chatInput}
                  setChatInput={setChatInput}
                  chatLoading={chatLoading}
                  loadChatSessions={loadChatSessions}
                  switchChatSession={switchChatSession}
                  startNewChatSession={startNewChatSession}
                  stopAgentHarness={stopAgentHarness}
                  askAgentHarness={askAgentHarness}
                  handleSaveFaq={handleSaveFaq}
                  handleAdoptAiAnswerAsTerm={handleAdoptAiAnswerAsTerm}
                  handleContainerClick={handleContainerClick}
                  handleMouseUpSelection={handleMouseUpSelection}
                />
              </div>
            )}
          </div>

          {/* 移动端半屏预览抽屉 */}
          {mobileSheetOpen && (
            <div
              className="mobile-sheet-backdrop"
              onClick={() => setMobileSheetOpen(false)}
            >
              <div
                className="mobile-bottom-sheet"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sheet-handle" />
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  <PeekCardView
                    targetTerm={peekTerm}
                    terms={terms}
                    termMap={termMap}
                    activeTerm={activeTerm}
                    graphCenterId={graphCenterId}
                    mainTab={mainTab}
                    peekStack={peekStack}
                    setPeekStack={setPeekStack}
                    matchers={matchers}
                    focusGraphCenter={focusGraphCenter}
                    setMobileSheetOpen={setMobileSheetOpen}
                    openTermAsMain={openTermAsMain}
                    handleContainerClick={handleContainerClick}
                    handleContainerMouseOver={handleContainerMouseOver}
                    handleContainerMouseOut={handleContainerMouseOut}
                  />
                </div>
                <div
                  style={{
                    padding: '12px 16px',
                    borderTop: '1px solid var(--line)',
                    display: 'flex',
                    gap: 10,
                    background: 'var(--surface)',
                  }}
                >
                  <button
                    className="btn"
                    style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
                    onClick={() => setMobileSheetOpen(false)}
                  >
                    关闭
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, justifyContent: 'center', padding: '10px' }}
                    onClick={() => openTermAsMain(peekTerm.id)}
                  >
                    打开全文
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 移动端底部导航栏 */}
          <nav className="mobile-bottom-nav">
            <button
              className={`mobile-tab-btn ${mobileTab === 'dir' ? 'active' : ''}`}
              onClick={() => setMobileTab('dir')}
            >
              <span>词条目录</span>
            </button>
            <button
              className={`mobile-tab-btn ${mobileTab === 'read' ? 'active' : ''}`}
              onClick={() => setMobileTab('read')}
            >
              <span>当前阅读</span>
            </button>
            <button
              className={`mobile-tab-btn ${mobileTab === 'chat' ? 'active' : ''}`}
              onClick={() => setMobileTab('chat')}
            >
              <span>问答助手</span>
            </button>
          </nav>
        </main>
      )}

      {/* PC 端鼠标悬停预览卡 */}
      {hoverInfo && viewMode === 'pc' && (
        <HoverTermPopover
          hoverInfo={hoverInfo}
          categories={categories}
          hoverTimerRef={hoverTimerRef}
          setHoverInfo={setHoverInfo}
          setPeekStack={setPeekStack}
          openRightPanel={openRightPanel}
          openTermAsMain={openTermAsMain}
        />
      )}

      {/* 划词操作菜单 */}
      {selectionBar && (
        <SelectionActionBar
          selectionBar={selectionBar}
          askAgentHarness={askAgentHarness}
          handleRecordFeedback={handleRecordFeedback}
          handleGenerateNewTerm={handleGenerateNewTerm}
        />
      )}

      {/* Cmd + K 全局搜索面板 */}
      {cmdkOpen && (
        <CmdkSearchModal
          cmdkQuery={cmdkQuery}
          setCmdkQuery={setCmdkQuery}
          cmdkMatches={cmdkMatches}
          mainTab={mainTab}
          setCmdkOpen={setCmdkOpen}
          focusGraphCenter={focusGraphCenter}
          openTermAsMain={openTermAsMain}
          handleRecordFeedback={handleRecordFeedback}
          handleGenerateNewTerm={handleGenerateNewTerm}
        />
      )}

      {/* AI 配置弹窗 */}
      {settingsOpen && (
        <AiSettingsModal
          aiConfig={aiConfig}
          setAiConfig={setAiConfig}
          aiSaveMsg={aiSaveMsg}
          aiTesting={aiTesting}
          setSettingsOpen={setSettingsOpen}
          handleTestAiConnection={handleTestAiConnection}
          handleSaveAiConfig={handleSaveAiConfig}
        />
      )}

      {/* 词条编辑与校准弹窗 */}
      {editModalOpen && (
        <TermEditModal
          editForm={editForm}
          setEditForm={setEditForm}
          categories={categories}
          editSaving={editSaving}
          setEditModalOpen={setEditModalOpen}
          handleSaveTermEdit={handleSaveTermEdit}
        />
      )}

      {/* 闭环 1：缺词雷达与划词纠错共建工单中心 */}
      {feedbackModalOpen && (
        <FeedbackTicketsModal
          feedbackTickets={feedbackTickets}
          feedbackTab={feedbackTab}
          setFeedbackTab={setFeedbackTab}
          myResolvedTickets={myResolvedTickets}
          currentUser={currentUser}
          activeTerm={activeTerm}
          resolvingTicketId={resolvingTicketId}
          termMap={termMap}
          setFeedbackModalOpen={setFeedbackModalOpen}
          openTermAsMain={openTermAsMain}
          openEditTermModal={openEditTermModal}
          handleAiResolveMissingTicket={handleAiResolveMissingTicket}
          handleResolveFeedbackTicket={handleResolveFeedbackTicket}
        />
      )}

      {/* 闭环 2：词条历史版本时光机 */}
      {revisionModalOpen && (
        <RevisionHistoryModal
          activeTerm={activeTerm}
          viewMode={viewMode}
          termRevisions={termRevisions}
          selectedRevision={selectedRevision}
          setSelectedRevision={setSelectedRevision}
          revisionLoading={revisionLoading}
          setRevisionModalOpen={setRevisionModalOpen}
          handleRollbackRevision={handleRollbackRevision}
        />
      )}

      {/* 闭环 3：「抓到触手，引爆全场，处处生花」AI Agent Harness 触手裂变与同义归并记忆中心 */}
      {sproutModalOpen && (
        <SproutHarnessModal
          activeTerm={activeTerm}
          terms={terms}
          termMap={termMap}
          sproutTab={sproutTab}
          setSproutTab={setSproutTab}
          sproutRuns={sproutRuns}
          sproutCandidates={sproutCandidates}
          sproutTermCandidates={sproutTermCandidates}
          sproutStats={sproutStats}
          sproutBusy={sproutBusy}
          resolvingCandidateId={resolvingCandidateId}
          aliasTargetOverrides={aliasTargetOverrides}
          setAliasTargetOverrides={setAliasTargetOverrides}
          lookupInput={lookupInput}
          setLookupInput={setLookupInput}
          lookupResult={lookupResult}
          setLookupResult={setLookupResult}
          lookupLoading={lookupLoading}
          setSproutModalOpen={setSproutModalOpen}
          openTermAsMain={openTermAsMain}
          handleDissectTerm={handleDissectTerm}
          handleRunSproutWave={handleRunSproutWave}
          handleConceptLookup={handleConceptLookup}
          handleResolveSprout={handleResolveSprout}
        />
      )}

      {/* 流程图全屏查看弹窗 */}
      {fullscreenMermaid && (
        <FullscreenMermaidModal
          fullscreenMermaid={fullscreenMermaid}
          setFullscreenMermaid={setFullscreenMermaid}
          matchers={matchers}
          handleContainerClick={handleContainerClick}
        />
      )}
    </>
  );
}
