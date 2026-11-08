import React from 'react';
import type { TermEntry } from '@glossa/schema';
import {
  autoLinkHtml,
  renderChatMarkdownHtml,
  renderV5BespokeArticleHtml,
  type KeywordMatcher,
} from './v5ArticleHtml';
import {
  cleanCategoryLabel,
  type MainTabType,
  type ScopeModeType,
} from './lexiconUiHelpers';

export interface FaqItem {
  termId: string;
  termTitle: string;
  category: string;
  q: string;
  a: string;
}

export interface FaqHubViewProps {
  activeTerm: TermEntry;
  activeCategory: string;
  categories: Array<{ id: string; name: string }>;
  allFaqItems: FaqItem[];
  activeTermNeighborhoodIds: Set<string>;
  faqSearchQuery: string;
  setFaqSearchQuery: (v: string) => void;
  faqCategoryFilter: string;
  setFaqCategoryFilter: (v: string) => void;
  tabScopeMode: ScopeModeType;
  setTabScopeMode: (v: ScopeModeType) => void;
  setMainTab: (t: MainTabType) => void;
  setActiveTermId: (id: string) => void;
  askAgentHarness: (q: string) => void;
  openTermAsMain: (id: string) => void;
  matchers: KeywordMatcher[];
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOver: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOut: () => void;
}

export function FaqHubView({
  activeTerm,
  activeCategory,
  categories,
  allFaqItems,
  activeTermNeighborhoodIds,
  faqSearchQuery,
  setFaqSearchQuery,
  faqCategoryFilter,
  setFaqCategoryFilter,
  tabScopeMode,
  setTabScopeMode,
  setMainTab,
  setActiveTermId,
  askAgentHarness,
  openTermAsMain,
  matchers,
  handleContainerClick,
  handleContainerMouseOver,
  handleContainerMouseOut,
}: FaqHubViewProps) {
  const q = faqSearchQuery.trim().toLowerCase();
  const effectiveCategory = activeCategory !== 'all' ? activeCategory : activeTerm.category;
  const effectiveCategoryName = cleanCategoryLabel(
    categories.find((c) => c.id === effectiveCategory)?.name || '当前分类'
  );

  const termScopeCount = allFaqItems.filter((item) =>
    activeTermNeighborhoodIds.has(item.termId)
  ).length;
  const categoryScopeCount = allFaqItems.filter(
    (item) => item.category === effectiveCategory
  ).length;

  const matchedFaqs = allFaqItems
    .filter((item) => {
      if (q) {
        return (
          item.q.toLowerCase().includes(q) ||
          item.a.toLowerCase().includes(q) ||
          item.termTitle.toLowerCase().includes(q)
        );
      }
      if (tabScopeMode === 'term') {
        return activeTermNeighborhoodIds.has(item.termId);
      }
      if (tabScopeMode === 'category') {
        return item.category === effectiveCategory;
      }
      if (faqCategoryFilter !== 'all' && item.category !== faqCategoryFilter) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aIsActive = a.termId === activeTerm.id ? 0 : 1;
      const bIsActive = b.termId === activeTerm.id ? 0 : 1;
      return aIsActive - bIsActive;
    });

  return (
    <div
      className="article-container"
      onClick={handleContainerClick}
      onMouseOver={handleContainerMouseOver}
      onMouseOut={handleContainerMouseOut}
    >
      <div className="layer-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 21, fontWeight: 800, color: 'var(--ink)', margin: 0 }}>
              排障问答库
            </h2>
            <span className="badge badge-green">
              {matchedFaqs.length} / {allFaqItems.length} 条
            </span>
          </div>
          <button className="btn btn-primary" onClick={() => setMainTab('article')}>
            返回「{activeTerm.title.slice(0, 8)}」正文
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 12px',
            background: 'var(--surface-subtle)',
            borderRadius: 8,
            border: '1px solid var(--line)',
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
            范围：
          </span>
          <button
            className={`btn ${!q && tabScopeMode === 'term' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => {
              setFaqSearchQuery('');
              setTabScopeMode('term');
            }}
          >
            当前词条「{activeTerm.title}」及关联 ({termScopeCount})
          </button>
          <button
            className={`btn ${!q && tabScopeMode === 'category' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => {
              setFaqSearchQuery('');
              setTabScopeMode('category');
            }}
          >
            当前分类：{effectiveCategoryName} ({categoryScopeCount})
          </button>
          <button
            className={`btn ${!q && tabScopeMode === 'all' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => {
              setFaqSearchQuery('');
              setTabScopeMode('all');
              setFaqCategoryFilter('all');
            }}
          >
            全部 ({allFaqItems.length})
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <input
            value={faqSearchQuery}
            onChange={(e) => setFaqSearchQuery(e.target.value)}
            placeholder="输入关键字检索问题或排查方案（如：选不到门店、返利、灰店、定位漂移、SAP拆单）..."
            style={{
              flex: 1,
              minWidth: 240,
              padding: '9px 12px',
              borderRadius: 8,
              border: '1px solid var(--line)',
              fontSize: 13.5,
            }}
          />
          {tabScopeMode === 'all' && (
            <select
              value={faqCategoryFilter}
              onChange={(e) => setFaqCategoryFilter(e.target.value)}
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                fontSize: 13,
              }}
            >
              <option value="all">全部业务域 ({allFaqItems.length})</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {cleanCategoryLabel(c.name)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {matchedFaqs.map((item, idx) => {
          const isCurrentTerm = item.termId === activeTerm.id;
          return (
            <div
              key={`${item.termId}-${idx}`}
              className="layer-card"
              style={{
                marginBottom: 0,
                border: isCurrentTerm ? '1.5px solid #2457F5' : undefined,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {isCurrentTerm && (
                    <span className="badge badge-blue">当前词条</span>
                  )}
                  <span className={`badge ${isCurrentTerm ? 'badge-green' : 'badge-blue'}`}>
                    {item.termTitle}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12, padding: '3px 9px' }}
                    onClick={() => {
                      setActiveTermId(item.termId);
                      askAgentHarness(`针对「${item.q}」，请详细说明业务原因与排查步骤。`);
                    }}
                  >
                    继续追问
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 12, padding: '3px 9px' }}
                    onClick={() => openTermAsMain(item.termId)}
                  >
                    查看词条
                  </button>
                </div>
              </div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 750,
                  color: 'var(--ink)',
                  marginBottom: 6,
                }}
              >
                Q：{item.q}
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.72,
                  color: 'var(--text)',
                  background: 'var(--surface-subtle)',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
                dangerouslySetInnerHTML={{
                  __html: renderChatMarkdownHtml(item.a, matchers, item.termId),
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface DecoderResultState {
  matchedTerms: Array<{
    id: string;
    title: string;
    category: string;
    matchedPhrase: string;
    analogy: string;
    plain: string;
  }>;
  matchedFields: Array<{
    termId: string;
    termTitle: string;
    db: string;
    table: string;
    field: string;
    rule: string;
  }>;
  codeHits: Array<{
    repo: string;
    branch: string;
    commit: string;
    path: string;
    line: number;
    snippet: string;
  }>;
  suggestedNewTerms: string[];
  translationMarkdown: string;
  mode: string;
  skillId?: string;
  durationMs?: number;
  traceSteps?: Array<{
    tool: string;
    summary: string;
  }>;
  lexiconStats?: {
    totalTerms: number;
    asopCount: number;
    totalFaqs: number;
    categoryBreakdown: Record<string, number>;
  };
}

export interface AdvisorTurnItem {
  id: string;
  question: string;
  skillId: string;
  enginePreference: string;
  result: DecoderResultState;
  createdAt: string;
}

export interface JargonDecoderViewProps {
  activeTerm: TermEntry;
  termMap: Map<string, TermEntry>;
  aiHasKey?: boolean;
  aiModel: string;
  decoderInput: string;
  setDecoderInput: (v: string) => void;
  advisorSessionId?: string;
  advisorTurns?: AdvisorTurnItem[];
  startNewAdvisorSession?: () => void;
  advisorSkill?: string;
  setAdvisorSkill?: (s: string) => void;
  advisorEngine?: 'auto' | 'codex-cli' | 'llm-api';
  setAdvisorEngine?: (e: 'auto' | 'codex-cli' | 'llm-api') => void;
  decoderLoading: boolean;
  decoderResult: DecoderResultState | null;
  handleDecodeParagraph: (
    overrideText?: string,
    overrideSkill?: string,
    overrideEngine?: 'auto' | 'codex-cli' | 'llm-api'
  ) => void;
  handleGenerateNewTerm: (title: string, contextSnippet?: string) => void;
  handleRecordFeedback: (
    type: 'MISSING_TERM' | 'CONTENT_CORRECTION',
    queryOrSelection: string,
    comment?: string
  ) => void;
  setMainTab: (t: MainTabType) => void;
  openTermAsMain?: (tid: string) => void;
  matchers: KeywordMatcher[];
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOver: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOut: () => void;
}

const ADVISOR_SKILLS: Array<{
  id: string;
  label: string;
  desc: string;
}> = [
  {
    id: 'auto',
    label: '自动识别技能',
    desc: '按提问意图自动切换排障、方案推演、统计口径或术语拆解',
  },
  {
    id: 'troubleshooting',
    label: '现场疑难排障',
    desc: '结合词典规则与 38 仓真实源码定位看不见、点不动、被拦截等现场问题',
  },
  {
    id: 'solution-design',
    label: '需求方案推演',
    desc: '评估新需求可复用的既有词条与子仓底座，给出落地方案与影响面分析',
  },
  {
    id: 'metrics-analytics',
    label: '统计口径分析',
    desc: '解析指标分子分母、异常剔除边界、T+1 结算规则与知识库资产分布',
  },
  {
    id: 'jargon-demystify',
    label: '术语潜台词拆解',
    desc: '将包含内部行话、系统状态或跨部门规则的段落翻译为白话指南',
  },
];

const SKILL_NAME_MAP: Record<string, string> = {
  troubleshooting: '现场疑难排障',
  'solution-design': '需求方案推演',
  'metrics-analytics': '统计口径分析',
  'jargon-demystify': '术语潜台词拆解',
};

const ENGINE_MODE_NAME_MAP: Record<string, string> = {
  'codex-cli': 'Codex CLI 沙箱深潜实证',
  'worker-codex': '内网 Worker + Codex CLI 实证',
  'llm-decoded': '词典语义 + 38 仓源码实证推演',
  'lexicon-rule-only': '词典规则引擎直出',
};

export function JargonDecoderView({
  activeTerm,
  termMap,
  aiHasKey,
  aiModel,
  decoderInput,
  setDecoderInput,
  advisorSessionId,
  advisorTurns = [],
  startNewAdvisorSession,
  advisorSkill = 'auto',
  setAdvisorSkill,
  advisorEngine = 'auto',
  setAdvisorEngine,
  decoderLoading,
  decoderResult,
  handleDecodeParagraph,
  handleGenerateNewTerm,
  handleRecordFeedback,
  setMainTab,
  openTermAsMain,
  matchers,
  handleContainerClick,
  handleContainerMouseOver,
  handleContainerMouseOut,
}: JargonDecoderViewProps) {
  const [showApiContract, setShowApiContract] = React.useState(false);

  const effectiveTurns: AdvisorTurnItem[] =
    advisorTurns.length > 0
      ? advisorTurns
      : decoderResult
        ? [
            {
              id: 'turn_legacy_1',
              question: decoderInput || '业务咨询',
              skillId: decoderResult.skillId || advisorSkill,
              enginePreference: advisorEngine,
              result: decoderResult,
              createdAt: '',
            },
          ]
        : [];

  const presetSamples = [
    {
      label: `现场排障：为什么「${activeTerm.title.slice(0, 10)}」不展示或无法执行`,
      skill: 'troubleshooting',
      text: `在一线操作「${activeTerm.title}」相关流程时，列表看不到目标数据或按钮无法点击执行，可能命中了哪些准入条件或状态校验拦截？`,
      highlight: true,
    },
    {
      label: `方案推演：围绕「${activeTerm.title.slice(0, 10)}」扩展新需求能力`,
      skill: 'solution-design',
      text: `我们想要围绕「${activeTerm.title}」扩展一套支持跨角色协同与分级核销的新需求能力，有哪些现成机制可复用？推荐方案怎么设计，会影响哪些上下游模块？`,
      highlight: false,
    },
    {
      label: `统计口径：「${activeTerm.title.slice(0, 10)}」核算公式与异常剔除`,
      skill: 'metrics-analytics',
      text: `请帮我给出「${activeTerm.title}」及相关流程的核心统计分析口径，分子分母分别是什么？遇到异常状态、黑名单或冲红回退时怎么剔除？`,
      highlight: false,
    },
    {
      label: `潜台词拆解：解析「${activeTerm.title.slice(0, 10)}」业务规则段落`,
      skill: 'jargon-demystify',
      text: `${activeTerm.summary}。${activeTerm.layman.plain}`,
      highlight: false,
    },
  ];

  const followUpSuggestions = [
    {
      label: '追问方案：如果要改造这块逻辑，需求方案该怎么设计？',
      skill: 'solution-design',
      text: '基于上面排查出的规则与源码现状，如果我们想要优化改造这块业务能力，推荐的落地方案应该怎么设计？会波及哪些上下游模块与状态机？',
    },
    {
      label: '追问源码：把刚才命中的核心源码判断条件再展开讲讲',
      skill: 'troubleshooting',
      text: '请结合刚才命中的核心源码切片，把具体的参数传递、状态字段枚举值和前端显隐/拦截判断条件再深入展开讲一下。',
    },
    {
      label: '追问口径：这个场景在统计考核上怎么算、怎么剔除异常？',
      skill: 'metrics-analytics',
      text: '这个业务场景在最终计算考核指标或费用结算时，分子分母口径是怎么算的？遇到上述拦截或异常状态时怎么剔除？',
    },
  ];

  const aiToAiCurlSnippet = `curl -X POST http://localhost:8790/api/agent/consult \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({
    sessionId: advisorSessionId || 'adv_session_01',
    text: decoderInput.trim() || `请分析「${activeTerm.title}」的核心业务校验链路与改造影响面`,
    skillId: advisorSkill === 'auto' ? 'troubleshooting' : advisorSkill,
    enginePreference: advisorEngine,
  })}'`;

  const renderComposerBox = (isFollowUp: boolean) => (
    <div
      className={isFollowUp ? 'layer-card' : ''}
      style={
        isFollowUp
          ? {
              border: '1.5px solid var(--primary)',
              background: '#FFFFFF',
            }
          : undefined
      }
    >
      {isFollowUp && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--ink)' }}>
              继续追问 / 连续参谋推演
            </span>
            <span className="badge badge-blue">
              已挂载前序 {effectiveTurns.length} 轮会话上下文
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {followUpSuggestions.map((f, i) => (
              <button
                key={i}
                className="btn"
                disabled={decoderLoading}
                style={{ fontSize: 11.5, padding: '3px 9px' }}
                onClick={() => handleDecodeParagraph(f.text, f.skill, advisorEngine)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <textarea
        rows={isFollowUp ? 3 : 4}
        value={decoderInput}
        onChange={(e) => setDecoderInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleDecodeParagraph();
          }
        }}
        placeholder={
          isFollowUp
            ? `基于以上 ${effectiveTurns.length} 轮结论继续追问细节、切换技能推演改造方案或追问源码（按 ⌘+Enter 快捷发送）...`
            : '输入现场疑难问题、新需求设想（我们想要什么能力该怎么做）、统计口径询问或业务段落...'
        }
        style={{
          width: '100%',
          padding: '12px 14px',
          borderRadius: 10,
          border: '1px solid var(--line)',
          fontSize: 13.5,
          lineHeight: 1.65,
          fontFamily: 'inherit',
          marginBottom: 10,
        }}
      />

      {decoderInput.trim() && (
        <div
          style={{
            background: 'var(--surface-subtle)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: 'var(--ink)',
            marginBottom: 10,
          }}
        >
          <span style={{ color: 'var(--muted)', fontWeight: 600, marginRight: 6 }}>
            实时词条识别：
          </span>
          <span
            dangerouslySetInnerHTML={{
              __html: autoLinkHtml(decoderInput, '', matchers),
            }}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          当前技能：{ADVISOR_SKILLS.find((s) => s.id === advisorSkill)?.label} —{' '}
          {ADVISOR_SKILLS.find((s) => s.id === advisorSkill)?.desc}（支持 ⌘+Enter 发送）
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {effectiveTurns.length > 0 && startNewAdvisorSession && (
            <button
              className="btn"
              disabled={decoderLoading}
              onClick={startNewAdvisorSession}
              style={{ padding: '7px 12px', fontSize: 12.5 }}
            >
              清空并新建会话
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={decoderLoading || !decoderInput.trim()}
            onClick={() => handleDecodeParagraph()}
            style={{ padding: '8px 18px', fontSize: 13.5, fontWeight: 700 }}
          >
            {decoderLoading
              ? advisorEngine === 'codex-cli'
                ? '正在调度 Codex CLI 与 38 仓源码取证...'
                : '正在结合会话上下文与 38 仓源码推演...'
              : isFollowUp
                ? `发送第 ${effectiveTurns.length + 1} 轮追问`
                : '开始参谋推演'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="article-container"
      onClick={handleContainerClick}
      onMouseOver={handleContainerMouseOver}
      onMouseOut={handleContainerMouseOut}
    >
      <div className="layer-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 21, fontWeight: 800, color: 'var(--ink)', margin: 0 }}>
              业务参谋 · Skills 咨询与方案推演
            </h2>
            <span className="badge badge-blue">当前上下文：{activeTerm.title}</span>
            {effectiveTurns.length > 0 && (
              <span className="badge badge-blue">
                连续会话：已完成 {effectiveTurns.length} 轮
              </span>
            )}
            <span className="badge badge-green">
              {advisorEngine === 'codex-cli'
                ? 'Codex CLI 沙箱引擎'
                : aiHasKey
                  ? `${aiModel} + 38仓源码探针`
                  : '词典+源码实证'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {effectiveTurns.length > 0 && startNewAdvisorSession && (
              <button
                className="btn"
                style={{ fontSize: 12, padding: '5px 10px' }}
                onClick={startNewAdvisorSession}
              >
                新建参谋会话
              </button>
            )}
            <button
              className="btn"
              style={{ fontSize: 12, padding: '5px 10px' }}
              onClick={() => setShowApiContract((prev) => !prev)}
            >
              {showApiContract ? '收起 AI 调用契约' : 'AI 问 AI 接口契约'}
            </button>
            <button className="btn btn-primary" onClick={() => setMainTab('article')}>
              返回「{activeTerm.title.slice(0, 8)}」正文
            </button>
          </div>
        </div>

        {showApiContract && (
          <div
            style={{
              background: '#0F172A',
              color: '#F8FAFC',
              borderRadius: 10,
              padding: '12px 14px',
              marginBottom: 12,
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
                color: '#94A3B8',
              }}
            >
              <span>
                外部研发 Agent（Codex / Antigravity / Cursor）可通过标准 Skill 接口（支持传 sessionId 与 history 连续多轮对话）发起「AI 问 AI」实证咨询：
              </span>
              <button
                className="btn"
                style={{ fontSize: 11, padding: '2px 8px', background: '#1E293B', color: '#E2E8F0', border: '1px solid #334155' }}
                onClick={() => {
                  navigator.clipboard?.writeText(aiToAiCurlSnippet);
                }}
              >
                复制调用命令
              </button>
            </div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>
              {aiToAiCurlSnippet}
            </pre>
          </div>
        )}

        {/* 参谋技能模式选择栏 */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            marginBottom: 10,
            paddingBottom: 10,
            borderBottom: '1px dashed var(--line)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>
            参谋技能 (Skills)：
          </span>
          {ADVISOR_SKILLS.map((sk) => {
            const active = advisorSkill === sk.id;
            return (
              <button
                key={sk.id}
                className={`btn ${active ? 'btn-primary' : ''}`}
                style={{ fontSize: 12, padding: '4px 11px' }}
                title={sk.desc}
                onClick={() => setAdvisorSkill?.(sk.id)}
              >
                {sk.label}
              </button>
            );
          })}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>执行驾驭层：</span>
            <button
              className={`btn ${advisorEngine !== 'codex-cli' ? 'btn-primary' : ''}`}
              style={{ fontSize: 11.5, padding: '3px 9px' }}
              onClick={() => setAdvisorEngine?.('auto')}
              title="先由 Glossa 执行多层级中文短语召回 + 工作区 rg 极速检索 + 源码切片精读，再由大模型按技能契约合成报告"
            >
              词典+源码探针 (秒级)
            </button>
            <button
              className={`btn ${advisorEngine === 'codex-cli' ? 'btn-primary' : ''}`}
              style={{ fontSize: 11.5, padding: '3px 9px' }}
              onClick={() => setAdvisorEngine?.('codex-cli')}
              title="调度本机或内网 Worker 上的顶级 Codex CLI (codex exec --sandbox read-only) 在源码工作区执行自主沙箱核验"
            >
              Codex CLI 沙箱深潜
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: effectiveTurns.length === 0 ? 10 : 0 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>
            典型场景：
          </span>
          {presetSamples.map((s, idx) => (
            <button
              key={idx}
              disabled={decoderLoading}
              className={`btn ${s.highlight ? 'btn-primary' : ''}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => handleDecodeParagraph(s.text, s.skill, advisorEngine)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {effectiveTurns.length === 0 && renderComposerBox(false)}
      </div>

      {/* 多轮连续会话时间轴 */}
      {effectiveTurns.map((turn, turnIdx) => {
        const res = turn.result;
        const turnNum = turnIdx + 1;
        return (
          <React.Fragment key={turn.id}>
            {/* 用户提问气泡卡 */}
            <div
              className="layer-card"
              style={{
                background: 'var(--surface-subtle)',
                borderLeft: '4px solid var(--primary)',
                padding: '12px 16px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge badge-blue">第 {turnNum} 轮提问</span>
                  {res.skillId && (
                    <span className="badge badge-green">
                      {SKILL_NAME_MAP[res.skillId] || res.skillId}
                    </span>
                  )}
                  {turn.createdAt && (
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{turn.createdAt}</span>
                  )}
                </div>
              </div>
              <div
                style={{
                  fontSize: 14.5,
                  fontWeight: 650,
                  lineHeight: 1.75,
                  color: 'var(--ink)',
                }}
                dangerouslySetInnerHTML={{
                  __html: autoLinkHtml(turn.question, '', matchers),
                }}
              />
            </div>

            {/* 本轮透明取证轨迹与召回证据栏 */}
            <div className="layer-card" style={{ padding: '14px 18px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--ink)' }}>
                    第 {turnNum} 轮实证取证链路
                  </span>
                  <span className="badge badge-green">
                    引擎：{ENGINE_MODE_NAME_MAP[res.mode] || res.mode}
                  </span>
                  {typeof res.durationMs === 'number' && (
                    <span
                      className="badge"
                      style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}
                    >
                      耗时 {(res.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-blue">召回词条 {res.matchedTerms.length} 项</span>
                  <span className="badge badge-green">38仓源码命中 {res.codeHits.length} 处</span>
                </div>
              </div>

              {res.traceSteps && res.traceSteps.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    background: 'var(--surface-subtle)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: '8px 12px',
                    fontSize: 12,
                    color: 'var(--muted)',
                    marginBottom:
                      res.matchedTerms.length > 0 || res.codeHits.length > 0 ? 10 : 0,
                  }}
                >
                  {res.traceSteps.map((step, i) => (
                    <div key={i}>
                      <code style={{ color: 'var(--primary)', marginRight: 6 }}>
                        [{step.tool}]
                      </code>
                      <span>{step.summary}</span>
                    </div>
                  ))}
                </div>
              )}

              {res.matchedTerms.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginBottom: res.codeHits.length > 0 ? 8 : 0,
                  }}
                >
                  <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>
                    关联业务词条：
                  </span>
                  {res.matchedTerms.map((mt) => (
                    <button
                      key={mt.id}
                      className="btn"
                      style={{ fontSize: 11.5, padding: '2px 8px' }}
                      onClick={() => openTermAsMain?.(mt.id)}
                      title={mt.plain}
                    >
                      {mt.title}
                    </button>
                  ))}
                </div>
              )}

              {res.codeHits.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>
                    38仓源码锚点：
                  </span>
                  {res.codeHits.slice(0, 5).map((ch, idx) => (
                    <span
                      key={idx}
                      style={{
                        fontSize: 11.5,
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: 'var(--surface-subtle)',
                        border: '1px solid var(--line)',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--ink)',
                      }}
                      title={ch.snippet}
                    >
                      {ch.repo}/{ch.path.split('/').pop()}:L{ch.line}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 本轮业务参谋报告正文 */}
            <div className="layer-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 10,
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>
                  第 {turnNum} 轮参谋报告
                </div>
                <span className="badge badge-green">
                  已对齐 {res.matchedTerms.length} 个词典定义与 {res.codeHits.length} 处源码实证
                </span>
              </div>
              <div
                dangerouslySetInnerHTML={{
                  __html: renderV5BespokeArticleHtml(
                    {
                      id: `__decoder_temp_${turn.id}__`,
                      title: `第 ${turnNum} 轮参谋报告`,
                      pinyin: 'YWCM',
                      category: 'general',
                      aliases: [],
                      summary: '',
                      layman: { analogy: '', plain: '' },
                      articleMarkdown: res.translationMarkdown,
                      relations: [],
                      faqs: [],
                    },
                    matchers
                  ),
                }}
              />
            </div>

            {res.suggestedNewTerms.length > 0 && (
              <div className="layer-card">
                <div
                  style={{ fontSize: 14, fontWeight: 750, color: 'var(--ink)', marginBottom: 8 }}
                >
                  第 {turnNum} 轮发现的未收录候选词
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {res.suggestedNewTerms.map((cand) => (
                    <div
                      key={cand}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--line)',
                        background: 'var(--surface-subtle)',
                        fontSize: 12.5,
                      }}
                    >
                      <code>{cand}</code>
                      <button
                        className="btn btn-primary"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() => handleGenerateNewTerm(cand, turn.question)}
                      >
                        新建词条
                      </button>
                      <button
                        className="btn"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() => handleRecordFeedback('MISSING_TERM', cand, turn.question)}
                      >
                        登记缺词
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}

      {/* 当已有对话轮次时，在底部展示连续追问输入框 */}
      {effectiveTurns.length > 0 && renderComposerBox(true)}
    </div>
  );
}
