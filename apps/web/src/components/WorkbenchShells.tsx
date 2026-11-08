import React from 'react';
import type { FeedbackTicket, TermEntry } from '@glossa/schema';
import {
  cleanBusinessSubtitle,
  cleanCategoryLabel,
  cleanSidebarTermTitle,
  type AuthUser,
  type MainTabType,
  type RightTabType,
  type ScopeModeType,
  type WorkerStatusState,
} from './lexiconUiHelpers';

export interface LoginScreenProps {
  loginUsername: string;
  setLoginUsername: (v: string) => void;
  loginPassword: string;
  setLoginPassword: (v: string) => void;
  loginError: string;
  loginLoading: boolean;
  handleLoginSubmit: (e: React.FormEvent) => void;
}

export function LoginScreen({
  loginUsername,
  setLoginUsername,
  loginPassword,
  setLoginPassword,
  loginError,
  loginLoading,
  handleLoginSubmit,
}: LoginScreenProps) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F8FAFC',
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          background: '#FFFFFF',
          border: '1px solid #E2E8F0',
          borderRadius: 14,
          padding: '28px 26px',
          boxShadow: '0 12px 32px -12px rgba(15, 23, 42, 0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div className="brand-badge">G</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>
              Glossa
            </div>
            <div style={{ fontSize: 12, color: '#64748B' }}>
              领域词典、业务攻略与 AI 参谋工作台
            </div>
          </div>
        </div>

        <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 5 }}>
              账号
            </label>
            <input
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              placeholder="admin"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 5 }}>
              访问口令
            </label>
            <input
              type="password"
              autoFocus
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="请输入访问口令"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #CBD5E1',
                fontSize: 14,
              }}
            />
          </div>

          {loginError && (
            <div style={{ fontSize: 12.5, color: '#DC2626', fontWeight: 600 }}>
              {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loginLoading}
            className="btn btn-primary"
            style={{
              width: '100%',
              justifyContent: 'center',
              padding: '10px 16px',
              fontSize: 14,
              fontWeight: 700,
              marginTop: 4,
            }}
          >
            {loginLoading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}

export interface TopbarHeaderProps {
  mainTab: MainTabType;
  setMainTab: (t: MainTabType) => void;
  activeTerm: TermEntry;
  focusGraphCenter: (tid: string) => void;
  allFaqCount: number;
  viewMode: 'pc' | 'mobile';
  setViewMode: (m: 'pc' | 'mobile') => void;
  setCmdkOpen: (open: boolean) => void;
  rightDrawerOpen: boolean;
  setRightDrawerOpen: (open: boolean) => void;
  openRightPanel: (tab: RightTabType) => void;
  openSproutModal: (termId?: string) => void;
  sproutPendingCount: number;
  setFeedbackModalOpen: (open: boolean) => void;
  openTicketsCount: number;
  myResolvedTickets: FeedbackTicket[];
  topMenuOpen: boolean;
  setTopMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  workerStatus: WorkerStatusState;
  aiHasKey?: boolean;
  aiModel: string;
  currentUser: AuthUser | null;
  setSettingsOpen: (open: boolean) => void;
  handleLogout: () => void;
}

export function TopbarHeader({
  mainTab,
  setMainTab,
  activeTerm,
  focusGraphCenter,
  allFaqCount,
  viewMode,
  setViewMode,
  setCmdkOpen,
  rightDrawerOpen,
  setRightDrawerOpen,
  openRightPanel,
  openSproutModal,
  sproutPendingCount,
  setFeedbackModalOpen,
  openTicketsCount,
  myResolvedTickets,
  topMenuOpen,
  setTopMenuOpen,
  workerStatus,
  aiHasKey,
  aiModel,
  currentUser,
  setSettingsOpen,
  handleLogout,
}: TopbarHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand" style={{ flexShrink: 0 }}>
        <div className="brand-badge">G</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Glossa</span>
        </div>
      </div>

      <nav className="topbar-segmented" aria-label="核心工作台视图切换">
        <button
          className={`topbar-seg-btn ${mainTab === 'article' ? 'active' : ''}`}
          onClick={() => setMainTab('article')}
        >
          词典与攻略
        </button>
        <button
          className={`topbar-seg-btn ${mainTab === 'decoder' ? 'active' : ''}`}
          onClick={() => setMainTab('decoder')}
        >
          业务参谋
        </button>
        <button
          className={`topbar-seg-btn ${mainTab === 'faq-hub' ? 'active' : ''}`}
          onClick={() => setMainTab('faq-hub')}
        >
          排障 FAQ ({allFaqCount})
        </button>
        <button
          className={`topbar-seg-btn ${mainTab === 'graph' ? 'active' : ''}`}
          onClick={() => {
            if (mainTab !== 'graph' && activeTerm) {
              focusGraphCenter(activeTerm.id);
            }
            setMainTab(mainTab === 'graph' ? 'article' : 'graph');
          }}
        >
          关联与对比
        </button>
      </nav>

      <div className="topbar-actions">
        {viewMode === 'pc' && (
          <button
            className="btn"
            onClick={() => setCmdkOpen(true)}
            style={{
              color: 'var(--muted)',
              minWidth: 140,
              justifyContent: 'space-between',
              padding: '5px 10px',
            }}
          >
            <span>搜索词典...</span>
            <kbd
              style={{
                background: 'var(--surface-muted)',
                padding: '1px 5px',
                borderRadius: 4,
                fontSize: 11,
                border: '1px solid var(--line)',
              }}
            >
              ⌘K
            </kbd>
          </button>
        )}

        {viewMode === 'pc' && (
          <button
            className={`btn ${rightDrawerOpen ? 'btn-primary' : ''}`}
            onClick={() => {
              if (rightDrawerOpen) {
                setRightDrawerOpen(false);
              } else {
                openRightPanel('chat');
              }
            }}
            style={{ padding: '5px 10px' }}
          >
            <span>问答助手</span>
          </button>
        )}

        <button
          className="btn"
          onClick={() => openSproutModal(activeTerm.id)}
          style={{ padding: '5px 10px' }}
        >
          <span>触手裂变</span>
          {sproutPendingCount > 0 && (
            <span
              className="badge badge-blue"
              style={{ marginLeft: 4, padding: '1px 6px', fontSize: 11 }}
            >
              待裂变 {sproutPendingCount}
            </span>
          )}
        </button>

        <button
          className="btn"
          onClick={() => setFeedbackModalOpen(true)}
          style={{
            padding: '5px 10px',
            borderColor: openTicketsCount > 0 ? '#F59E0B' : undefined,
            background: openTicketsCount > 0 ? '#FFFBEB' : undefined,
          }}
        >
          <span>共建工单</span>
          {openTicketsCount > 0 && (
            <span
              className="badge badge-amber"
              style={{ marginLeft: 4, padding: '1px 6px', fontSize: 11 }}
            >
              待办 {openTicketsCount}
            </span>
          )}
          {myResolvedTickets.length > 0 && (
            <span
              className="badge badge-green"
              style={{ marginLeft: 4, padding: '1px 6px', fontSize: 11 }}
            >
              已解决 {myResolvedTickets.length}
            </span>
          )}
        </button>

        <div className="topbar-menu-wrap">
          <button
            className="btn"
            style={{ padding: '5px 10px' }}
            onClick={() => setTopMenuOpen((prev) => !prev)}
          >
            <span>系统与账号</span>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: workerStatus.online || aiHasKey ? '#10B981' : '#94A3B8',
                display: 'inline-block',
                marginLeft: 2,
              }}
            />
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>▾</span>
          </button>

          {topMenuOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 110 }}
                onClick={() => setTopMenuOpen(false)}
              />
              <div className="topbar-menu-popover">
                <div
                  style={{
                    padding: '6px 10px 8px',
                    borderBottom: '1px solid var(--line)',
                    marginBottom: 4,
                    fontSize: 12,
                    color: 'var(--muted)',
                  }}
                >
                  当前账号：<strong style={{ color: 'var(--ink)' }}>{currentUser?.username}</strong>{' '}
                  <span className="badge badge-blue" style={{ fontSize: 10, padding: '1px 5px' }}>
                    {currentUser?.role}
                  </span>
                </div>

                <button
                  className="topbar-menu-item"
                  onClick={() => {
                    setTopMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  <span>AI 引擎配置</span>
                  <span className={`badge ${aiHasKey ? 'badge-green' : 'badge-amber'}`} style={{ fontSize: 10 }}>
                    {aiHasKey ? aiModel : '未配置'}
                  </span>
                </button>

                <button
                  className="topbar-menu-item"
                  onClick={() => {
                    setTopMenuOpen(false);
                    setViewMode(viewMode === 'pc' ? 'mobile' : 'pc');
                  }}
                >
                  <span>{viewMode === 'pc' ? '切换移动端视图' : '切换桌面端视图'}</span>
                </button>

                <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />

                <button
                  className="topbar-menu-item"
                  style={{ color: '#DC2626' }}
                  onClick={() => {
                    setTopMenuOpen(false);
                    handleLogout();
                  }}
                >
                  <span>退出登录</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export interface PcSidebarTreeProps {
  terms: TermEntry[];
  termMap: Map<string, TermEntry>;
  categories: Array<{ id: string; name: string }>;
  sidebarFilter: string;
  setSidebarFilter: (v: string) => void;
  sidebarFilteredAllTerms: TermEntry[];
  mainTab: MainTabType;
  tabScopeMode: ScopeModeType;
  setTabScopeMode: (v: ScopeModeType) => void;
  activeCategory: string;
  setActiveCategory: (v: string) => void;
  expandedTreeCats: string[];
  setExpandedTreeCats: React.Dispatch<React.SetStateAction<string[]>>;
  sidebarFocusTermId: string;
  focusGraphCenter: (tid: string) => void;
  setActiveTermId: (tid: string) => void;
  openTermAsMain: (tid: string) => void;
}

export function PcSidebarTree({
  terms,
  termMap,
  categories,
  sidebarFilter,
  setSidebarFilter,
  sidebarFilteredAllTerms,
  mainTab,
  tabScopeMode,
  setTabScopeMode,
  activeCategory,
  setActiveCategory,
  expandedTreeCats,
  setExpandedTreeCats,
  sidebarFocusTermId,
  focusGraphCenter,
  setActiveTermId,
  openTermAsMain,
}: PcSidebarTreeProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-search-wrap">
          <input
            className="sidebar-search-input"
            value={sidebarFilter}
            onChange={(e) => setSidebarFilter(e.target.value)}
            placeholder="过滤词条 / 拼音 / 别名..."
          />
          {sidebarFilter && (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => setSidebarFilter('')}
              title="清空过滤"
            >
              ×
            </button>
          )}
        </div>
        <div className="sidebar-meta-bar">
          <span>
            {sidebarFilter.trim()
              ? `匹配 ${sidebarFilteredAllTerms.length} / ${terms.length}`
              : `共 ${terms.length} 词条`}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {mainTab === 'faq-hub' && tabScopeMode !== 'all' && (
              <button
                type="button"
                className="sidebar-link-btn"
                onClick={() => {
                  setActiveCategory('all');
                  setTabScopeMode('all');
                }}
              >
                看全库
              </button>
            )}
            {!sidebarFilter.trim() && (
              <button
                type="button"
                className="sidebar-link-btn"
                onClick={() => {
                  if (expandedTreeCats.length >= categories.length) {
                    const focusCat =
                      termMap.get(sidebarFocusTermId)?.category || 'terminal';
                    setExpandedTreeCats([focusCat]);
                  } else {
                    setExpandedTreeCats(categories.map((c) => c.id));
                  }
                }}
              >
                {expandedTreeCats.length >= categories.length ? '收起分类' : '展开全部'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="sidebar-tree">
        {categories.map((c) => {
          const catTerms = sidebarFilteredAllTerms.filter((t) => t.category === c.id);
          const isFiltering = Boolean(sidebarFilter.trim());
          if (isFiltering && catTerms.length === 0) return null;
          const isExpanded = isFiltering || expandedTreeCats.includes(c.id);
          const isCatScopeActive =
            mainTab === 'faq-hub' &&
            tabScopeMode === 'category' &&
            activeCategory === c.id;

          return (
            <div key={c.id} className="tree-group">
              <div
                className={`tree-group-header ${isCatScopeActive ? 'scope-active' : ''}`}
                onClick={() => {
                  setActiveCategory(c.id);
                  if (mainTab === 'faq-hub') {
                    setTabScopeMode('category');
                  }
                  if (!isFiltering) {
                    setExpandedTreeCats((prev) =>
                      prev.includes(c.id)
                        ? prev.filter((id) => id !== c.id)
                        : [...prev, c.id]
                    );
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  <span className="tree-group-chevron">{isExpanded ? '▾' : '▸'}</span>
                  <span
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {cleanCategoryLabel(c.name)}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: isCatScopeActive ? 'var(--primary)' : 'var(--muted)',
                    marginLeft: 6,
                    flexShrink: 0,
                  }}
                >
                  {catTerms.length}
                </span>
              </div>

              {isExpanded && (
                <div className="tree-group-items">
                  {catTerms.map((t) => {
                    const isActive = sidebarFocusTermId === t.id;
                    const displayTitle = cleanSidebarTermTitle(t.title);
                    const cleanSub = cleanBusinessSubtitle(t.subtitle);
                    const qLower = sidebarFilter.trim().toLowerCase();
                    const showMatchHint =
                      isFiltering && !displayTitle.toLowerCase().includes(qLower);

                    return (
                      <div
                        key={t.id}
                        data-sidebar-term-id={t.id}
                        title={cleanSub ? `${t.title} (${cleanSub})` : t.title}
                        className={`tree-item ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          if (mainTab === 'graph') {
                            focusGraphCenter(t.id);
                          } else if (
                            mainTab === 'faq-hub' ||
                            mainTab === 'decoder'
                          ) {
                            setActiveTermId(t.id);
                            setTabScopeMode('term');
                          } else {
                            openTermAsMain(t.id);
                          }
                        }}
                      >
                        <div className="tree-item-row">
                          <span className="tree-item-title">{displayTitle}</span>
                          {t.meta?.status === 'DRAFT' && (
                            <span
                              className="badge badge-amber"
                              style={{ fontSize: 10, padding: '0 4px', flexShrink: 0 }}
                            >
                              草稿
                            </span>
                          )}
                        </div>
                        {showMatchHint && (
                          <div className="tree-item-match-hint">
                            {cleanSub || t.pinyin}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {sidebarFilter.trim() && sidebarFilteredAllTerms.length === 0 && (
          <div
            style={{
              padding: '24px 12px',
              textAlign: 'center',
              fontSize: 12.5,
              color: 'var(--muted)',
            }}
          >
            无匹配词条
          </div>
        )}
      </div>
    </aside>
  );
}

export interface HoverTermPopoverProps {
  hoverInfo: { term: TermEntry; x: number; y: number };
  categories: Array<{ id: string; name: string }>;
  hoverTimerRef: React.MutableRefObject<number | null>;
  setHoverInfo: (val: { term: TermEntry; x: number; y: number } | null) => void;
  setPeekStack: React.Dispatch<React.SetStateAction<string[]>>;
  openRightPanel: (tab: RightTabType) => void;
  openTermAsMain: (tid: string) => void;
}

export function HoverTermPopover({
  hoverInfo,
  categories,
  hoverTimerRef,
  setHoverInfo,
  setPeekStack,
  openRightPanel,
  openTermAsMain,
}: HoverTermPopoverProps) {
  return (
    <div
      className="hover-popover"
      style={{ left: hoverInfo.x, top: hoverInfo.y }}
      onMouseEnter={() => {
        if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
      }}
      onMouseLeave={() => setHoverInfo(null)}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span className="badge badge-blue">
          {cleanCategoryLabel(categories.find((c) => c.id === hoverInfo.term.category)?.name || '词条')}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'monospace' }}>
          {hoverInfo.term.pinyin}
        </span>
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          color: 'var(--ink)',
          marginBottom: 4,
        }}
      >
        {hoverInfo.term.title}
        {cleanBusinessSubtitle(hoverInfo.term.subtitle) && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 400,
              color: 'var(--muted)',
              marginLeft: 6,
            }}
          >
            {cleanBusinessSubtitle(hoverInfo.term.subtitle)}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text)',
          lineHeight: 1.55,
          marginBottom: 10,
        }}
      >
        {hoverInfo.term.summary}
      </div>
      <div
        style={{
          background: '#ECFDF5',
          border: '1px solid #A7F3D0',
          padding: '8px 10px',
          borderRadius: 8,
          fontSize: 12,
          color: '#065F46',
          lineHeight: 1.55,
          marginBottom: 10,
        }}
      >
        <strong>白话比喻：</strong>
        {hoverInfo.term.layman.analogy.slice(0, 76)}...
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          className="btn"
          style={{ fontSize: 12, padding: '4px 10px' }}
          onClick={() => {
            setPeekStack((prev) =>
              prev[prev.length - 1] === hoverInfo.term.id
                ? prev
                : [...prev, hoverInfo.term.id]
            );
            openRightPanel('peek');
            setHoverInfo(null);
          }}
        >
          右侧速览
        </button>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, padding: '4px 10px' }}
          onClick={() => openTermAsMain(hoverInfo.term.id)}
        >
          打开全文
        </button>
      </div>
    </div>
  );
}

export interface SelectionActionBarProps {
  selectionBar: { text: string; x: number; y: number };
  askAgentHarness: (q: string, snippet?: string) => void;
  handleRecordFeedback: (
    type: 'MISSING_TERM' | 'CONTENT_CORRECTION',
    queryOrSelection: string,
    comment?: string
  ) => void;
  handleGenerateNewTerm: (title: string, contextSnippet?: string) => void;
}

export function SelectionActionBar({
  selectionBar,
  askAgentHarness,
  handleRecordFeedback,
  handleGenerateNewTerm,
}: SelectionActionBarProps) {
  return (
    <div
      className="selection-bar"
      style={{ left: selectionBar.x, top: selectionBar.y }}
    >
      <button
        className="sel-btn"
        onClick={() =>
          askAgentHarness(
            `请结合业务规则用大白话解释这句话：「${selectionBar.text}」`,
            selectionBar.text
          )
        }
      >
        追问这句话
      </button>
      <span style={{ color: '#475569' }}>|</span>
      <button
        className="sel-btn"
        onClick={() =>
          handleRecordFeedback(
            'CONTENT_CORRECTION',
            selectionBar.text,
            '用户划选正文片段标记口径存疑待复核'
          )
        }
      >
        划词报错
      </button>
      <span style={{ color: '#475569' }}>|</span>
      <button
        className="sel-btn"
        onClick={() =>
          handleGenerateNewTerm(selectionBar.text.slice(0, 22), selectionBar.text)
        }
      >
        生成新词条
      </button>
    </div>
  );
}
