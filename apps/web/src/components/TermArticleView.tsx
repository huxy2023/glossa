import React from 'react';
import type { TermEntry } from '@glossa/schema';
import {
  autoLinkHtml,
  renderChatMarkdownHtml,
  renderV5BespokeArticleHtml,
  type KeywordMatcher,
} from './v5ArticleHtml';
import {
  cleanBusinessSubtitle,
  isBusinessAlias,
  type MainTabType,
  type RightTabType,
} from './lexiconUiHelpers';

export interface TermArticleViewProps {
  activeTerm: TermEntry;
  categoryName: string;
  viewMode: 'pc' | 'mobile';
  termMap: Map<string, TermEntry>;
  backlinks: TermEntry[];
  egoExpandAll: boolean;
  setEgoExpandAll: React.Dispatch<React.SetStateAction<boolean>>;
  matchers: KeywordMatcher[];
  setMainTab: (t: MainTabType) => void;
  focusGraphCenter: (tid: string) => void;
  setCompareTargetId: (tid: string | null) => void;
  setComparePickerOpen: (open: boolean) => void;
  setPeekStack: React.Dispatch<React.SetStateAction<string[]>>;
  setMobileSheetOpen: (open: boolean) => void;
  openRightPanel: (tab: RightTabType) => void;
  handlePublishTerm: (id: string) => void;
  openSproutModal: (id: string) => void;
  openRevisionModal: (id: string) => void;
  openEditTermModal: (term: TermEntry) => void;
  handleDeleteTerm: (term: TermEntry) => void;
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOver: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOut: () => void;
  handleMouseUpSelection: () => void;
}

export function TermArticleView({
  activeTerm,
  categoryName,
  viewMode,
  termMap,
  backlinks,
  egoExpandAll,
  setEgoExpandAll,
  matchers,
  setMainTab,
  focusGraphCenter,
  setCompareTargetId,
  setComparePickerOpen,
  setPeekStack,
  setMobileSheetOpen,
  openRightPanel,
  handlePublishTerm,
  openSproutModal,
  openRevisionModal,
  openEditTermModal,
  handleDeleteTerm,
  handleContainerClick,
  handleContainerMouseOver,
  handleContainerMouseOut,
  handleMouseUpSelection,
}: TermArticleViewProps) {
  const allEgoNeighbors: Array<{ id: string; title: string; label: string; dir: 'out' | 'in' }> = [];
  const seenNeighbor = new Set<string>([activeTerm.id]);
  for (const rel of activeTerm.relations || []) {
    const target = termMap.get(rel.target);
    if (target && !seenNeighbor.has(target.id)) {
      seenNeighbor.add(target.id);
      allEgoNeighbors.push({
        id: target.id,
        title: target.title,
        label: rel.label,
        dir: 'out',
      });
    }
  }
  for (const b of backlinks) {
    if (!seenNeighbor.has(b.id)) {
      seenNeighbor.add(b.id);
      const revRel = (b.relations || []).find((r) => r.target === activeTerm.id);
      allEgoNeighbors.push({
        id: b.id,
        title: b.title,
        label: revRel?.label || '关联引用',
        dir: 'in',
      });
    }
  }
  const egoNeighbors = allEgoNeighbors.slice(0, 8);
  const displayedEgoPills = egoExpandAll ? allEgoNeighbors : egoNeighbors;
  const cleanSubtitle = cleanBusinessSubtitle(activeTerm.subtitle);

  return (
    <div
      className="article-container"
      onClick={handleContainerClick}
      onMouseOver={handleContainerMouseOver}
      onMouseOut={handleContainerMouseOut}
      onMouseUp={handleMouseUpSelection}
    >
      {/* 第一部分：轻量结构化导读头 */}
      <div className="layer-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-blue">
              {activeTerm.category === 'asop' ? '流程攻略' : categoryName}
            </span>
            {activeTerm.meta?.status === 'DRAFT' ? (
              <span className="badge badge-amber">
                草稿 (v{activeTerm.meta?.revision || 1})
              </span>
            ) : (
              <span className="badge badge-green">
                v{activeTerm.meta?.revision || 1}
              </span>
            )}
            {(activeTerm.aliases || [])
              .filter(isBusinessAlias)
              .map((a) => (
                <span key={a} className="alias-tag">
                  {a}
                </span>
              ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {activeTerm.meta?.status === 'DRAFT' && (
              <button
                className="btn btn-primary"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => handlePublishTerm(activeTerm.id)}
              >
                发布
              </button>
            )}
            <button
              className="btn"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => openSproutModal(activeTerm.id)}
            >
              触手裂变
            </button>
            <button
              className="btn"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => openRevisionModal(activeTerm.id)}
            >
              历史版本 (v{activeTerm.meta?.revision || 1})
            </button>
            <button
              className="btn"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => openEditTermModal(activeTerm)}
            >
              编辑
            </button>
            <button
              className="btn"
              style={{ fontSize: 12, padding: '4px 10px', color: '#DC2626' }}
              onClick={() => handleDeleteTerm(activeTerm)}
            >
              删除
            </button>
          </div>
        </div>

        <h1
          style={{
            fontSize: viewMode === 'mobile' ? 24 : 30,
            fontWeight: 800,
            color: 'var(--ink)',
            letterSpacing: '-0.02em',
          }}
        >
          {activeTerm.title}
          {cleanSubtitle && (
            <span
              style={{
                fontSize: viewMode === 'mobile' ? 13.5 : 15.5,
                fontWeight: 500,
                color: 'var(--muted)',
                marginLeft: 8,
              }}
            >
              {cleanSubtitle}
            </span>
          )}
        </h1>

        <div
          className="hero-summary"
          dangerouslySetInnerHTML={{
            __html: `<strong>一句话定义：</strong>${autoLinkHtml(
              activeTerm.summary,
              activeTerm.id,
              matchers
            )}`,
          }}
        />

        <div className="analogy-grid">
          <div className="analogy-box layman-tint">
            <div className="box-kicker">
              <span className="step-num emerald">比喻</span>
              <span>直观类比</span>
            </div>
            <p
              style={{ fontSize: 14, lineHeight: 1.72, color: 'var(--ink)' }}
              dangerouslySetInnerHTML={{
                __html: autoLinkHtml(
                  activeTerm.layman.analogy,
                  activeTerm.id,
                  matchers
                ),
              }}
            />
          </div>
          <div className="analogy-box">
            <div className="box-kicker">
              <span className="step-num blue">白话</span>
              <span>业务说明</span>
            </div>
            <p
              style={{ fontSize: 14, lineHeight: 1.72, color: 'var(--text)' }}
              dangerouslySetInnerHTML={{
                __html: autoLinkHtml(
                  activeTerm.layman.plain,
                  activeTerm.id,
                  matchers
                ),
              }}
            />
          </div>
        </div>
      </div>

      {/* 第二部分：V5 正文 */}
      <div
        dangerouslySetInnerHTML={{
          __html: renderV5BespokeArticleHtml(activeTerm, matchers),
        }}
      />

      {/* 第三部分：常见问题与关联概念 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: viewMode === 'mobile' ? '1fr' : '1fr 1fr',
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div className="layer-card" style={{ marginBottom: 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 750,
                color: 'var(--ink)',
              }}
            >
              常见问题
            </span>
            <button
              className="btn"
              style={{ fontSize: 11.5, padding: '2px 8px' }}
              onClick={() => setMainTab('faq-hub')}
            >
              全部问答
            </button>
          </div>
          {activeTerm.faqs && activeTerm.faqs.length > 0 ? (
            activeTerm.faqs.map((f, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 10,
                  paddingBottom: 10,
                  borderBottom: '1px dashed var(--line)',
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13.5,
                    color: 'var(--ink)',
                    marginBottom: 4,
                  }}
                >
                  Q: {f.q}
                </div>
                <div
                  style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}
                  dangerouslySetInnerHTML={{
                    __html: renderChatMarkdownHtml(f.a, matchers, activeTerm.id),
                  }}
                />
              </div>
            ))
          ) : (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              暂无问答记录。
            </div>
          )}
        </div>

        <div className="layer-card" style={{ marginBottom: 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 750,
                  color: 'var(--ink)',
                }}
              >
                关联概念与流程
              </span>
              <span className="badge badge-blue" style={{ fontSize: 11 }}>
                {allEgoNeighbors.length}
              </span>
            </div>
            <button
              className="btn btn-primary"
              style={{ fontSize: 11.5, padding: '3px 9px' }}
              onClick={() => {
                focusGraphCenter(activeTerm.id);
                setMainTab('graph');
              }}
            >
              关联与对比
            </button>
          </div>

          {displayedEgoPills.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 8 }}>
              {displayedEgoPills.map((b) => {
                const targetObj = termMap.get(b.id);
                const isAsop = targetObj?.category === 'asop';
                return (
                  <div
                    key={b.id}
                    onClick={() => {
                      setPeekStack((prev) =>
                        prev[prev.length - 1] === b.id ? prev : [...prev, b.id]
                      );
                      if (viewMode === 'mobile') setMobileSheetOpen(true);
                      else openRightPanel('peek');
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      background: 'var(--surface-subtle)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flexWrap: 'wrap',
                          marginBottom: 2,
                        }}
                      >
                        <span
                          className={`badge ${
                            isAsop
                              ? 'badge-purple'
                              : b.dir === 'in'
                                ? 'badge-green'
                                : 'badge-blue'
                          }`}
                          style={{ fontSize: 10.5, padding: '1px 6px' }}
                        >
                          {isAsop ? '流程攻略' : b.dir === 'in' ? '上游引用' : '下游关联'}
                        </span>
                        <strong style={{ fontSize: 13, color: 'var(--ink)' }}>{b.title}</strong>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text)' }}>
                        {b.label}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {!isAsop && (
                        <button
                          className="btn"
                          style={{ fontSize: 11, padding: '3px 7px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            focusGraphCenter(activeTerm.id);
                            setCompareTargetId(b.id);
                            setComparePickerOpen(false);
                            setMainTab('graph');
                          }}
                        >
                          对比
                        </button>
                      )}
                      <button
                        className="btn"
                        style={{ fontSize: 11, padding: '3px 7px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          focusGraphCenter(b.id);
                          setMainTab('graph');
                        }}
                      >
                        查看关联
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>暂无直接上下游关联。</div>
          )}

          {allEgoNeighbors.length > 8 && (
            <button
              className="btn"
              style={{ fontSize: 11.5, padding: '4px 10px', width: '100%', justifyContent: 'center' }}
              onClick={() => setEgoExpandAll((prev) => !prev)}
            >
              {egoExpandAll
                ? '收起'
                : `展开全部 (${allEgoNeighbors.length})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
