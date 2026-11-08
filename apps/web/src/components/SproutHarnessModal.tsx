import React from 'react';
import type {
  CandidateAction,
  ConceptLookupResult,
  ExpansionCandidate,
  ExpansionRun,
  TermEntry,
} from '@glossa/schema';
import {
  compileMermaidToSvg,
  type KeywordMatcher,
} from './v5ArticleHtml';
import { isBusinessAlias } from './lexiconUiHelpers';

export interface SproutHarnessModalProps {
  activeTerm: TermEntry;
  terms: TermEntry[];
  termMap: Map<string, TermEntry>;
  sproutBusy: boolean;
  sproutTab: 'current' | 'pending' | 'generated' | 'merged' | 'rejected';
  setSproutTab: (tab: 'current' | 'pending' | 'generated' | 'merged' | 'rejected') => void;
  sproutRuns: ExpansionRun[];
  sproutCandidates: ExpansionCandidate[];
  sproutTermCandidates: ExpansionCandidate[];
  sproutStats: {
    totalCandidates: number;
    pendingCount: number;
    generatedCount: number;
    mergedAliasCount: number;
    linkedExistingCount: number;
    rejectedCount: number;
  };
  resolvingCandidateId: string | null;
  aliasTargetOverrides: Record<string, string>;
  setAliasTargetOverrides: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  lookupInput: string;
  setLookupInput: (v: string) => void;
  lookupResult: ConceptLookupResult | null;
  setLookupResult: (v: ConceptLookupResult | null) => void;
  lookupLoading: boolean;
  setSproutModalOpen: (open: boolean) => void;
  handleDissectTerm: (termId?: string) => void;
  handleRunSproutWave: (termId?: string) => void;
  handleConceptLookup: (rawQuery?: string) => void;
  handleResolveSprout: (
    candidate: ExpansionCandidate,
    action: CandidateAction,
    overrideTargetId?: string
  ) => void;
  openTermAsMain: (tid: string) => void;
}

export function SproutHarnessModal({
  activeTerm,
  terms,
  termMap,
  sproutBusy,
  sproutTab,
  setSproutTab,
  sproutRuns,
  sproutCandidates,
  sproutTermCandidates,
  sproutStats,
  resolvingCandidateId,
  aliasTargetOverrides,
  setAliasTargetOverrides,
  lookupInput,
  setLookupInput,
  lookupResult,
  setLookupResult,
  lookupLoading,
  setSproutModalOpen,
  handleDissectTerm,
  handleRunSproutWave,
  handleConceptLookup,
  handleResolveSprout,
  openTermAsMain,
}: SproutHarnessModalProps) {
  return (
    <div
      className="modal-backdrop"
      onClick={() => setSproutModalOpen(false)}
      style={{ zIndex: 255 }}
    >
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '92vw',
          maxWidth: 1020,
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingBottom: 14,
            borderBottom: '1px solid var(--line)',
            marginBottom: 14,
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)' }}>
              触手裂变与同义归并中心
            </h3>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              顺藤摸瓜剖析业务词条中的衍生触手：属于同物异名的并入已有词条别名（全站自动双链），属于独立规则的分叉生成新词条，通用词记入免重审记忆
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={sproutBusy}
              onClick={() => handleDissectTerm(activeTerm.id)}
            >
              {sproutBusy ? '处理中...' : `顺藤摸瓜剖析「${activeTerm.title}」`}
            </button>
            <button
              className="btn btn-primary"
              disabled={sproutBusy}
              onClick={() => handleRunSproutWave(activeTerm.id)}
            >
              {sproutBusy ? '正在裂变...' : `一键引爆「${activeTerm.title}」波次`}
            </button>
            <button className="btn" onClick={() => setSproutModalOpen(false)}>
              关闭
            </button>
          </div>
        </div>

        {/* 概念查重与同义别名检测栏 */}
        <div
          style={{
            background: 'var(--surface-subtle)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>
              概念查重与同义词检测：
            </span>
            <input
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConceptLookup();
              }}
              placeholder="输入任意业务叫法查重或召回相似词条（如：行销费用门店、活动准入店、锁量协议）..."
              style={{
                flex: 1,
                minWidth: 240,
                padding: '6px 10px',
                borderRadius: 7,
                border: '1px solid var(--line)',
                fontSize: 12.5,
              }}
            />
            <button
              className="btn"
              style={{ fontSize: 12, padding: '5px 12px' }}
              disabled={lookupLoading || !lookupInput.trim()}
              onClick={() => handleConceptLookup()}
            >
              {lookupLoading ? '检索中...' : '查重检测'}
            </button>
            {lookupResult && (
              <button
                className="btn"
                style={{ fontSize: 12, padding: '5px 10px' }}
                onClick={() => setLookupResult(null)}
              >
                收起结果
              </button>
            )}
          </div>

          {lookupResult && (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: '1px dashed var(--line)',
                fontSize: 12.5,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {lookupResult.exactMatch ? (
                <div style={{ color: '#065F46', fontWeight: 600 }}>
                  已精确命中既有词条：【{lookupResult.exactMatch.title}】（匹配方式：
                  {lookupResult.exactMatch.matchedVia === 'alias' ? '标准别名' : '词条主名'}
                  ）——{' '}
                  <button
                    className="btn"
                    style={{ fontSize: 11.5, padding: '2px 8px', marginLeft: 6 }}
                    onClick={() => {
                      setSproutModalOpen(false);
                      openTermAsMain(lookupResult.exactMatch!.termId);
                    }}
                  >
                    跳转查看
                  </button>
                </div>
              ) : (
                <div style={{ color: 'var(--ink)' }}>
                  库内暂无完全同名的词条或别名。
                  {lookupResult.memoryMatch && (
                    <span style={{ marginLeft: 8, color: '#2457F5', fontWeight: 600 }}>
                      （已在繁衍记忆账本中记录，当前状态：{lookupResult.memoryMatch.status}）
                    </span>
                  )}
                </div>
              )}

              {lookupResult.similarTerms.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontWeight: 700, color: 'var(--muted)' }}>
                    召回相近词条（可判断是否为同物异名或上下游关联）：
                  </div>
                  {lookupResult.similarTerms.slice(0, 3).map((sim) => (
                    <div
                      key={sim.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: '#FFFFFF',
                        padding: '6px 10px',
                        borderRadius: 6,
                        border: '1px solid var(--line)',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <strong>{sim.title}</strong>
                        {sim.aliases.length > 0 && (
                          <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
                            （现有别名：{sim.aliases.filter(isBusinessAlias).join('、')}）
                          </span>
                        )}
                        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          {sim.matchHint}
                        </div>
                      </div>
                      <button
                        className="btn"
                        style={{ fontSize: 11.5, padding: '3px 8px' }}
                        onClick={() => {
                          setSproutModalOpen(false);
                          openTermAsMain(sim.id);
                        }}
                      >
                        查看【{sim.title}】
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 繁衍批次记忆摘要与分类筛选栏 */}
        {sproutRuns[0] && (
          <div
            style={{
              fontSize: 12,
              color: '#1E3A8A',
              background: '#EFF6FF',
              border: '1px solid #BFDBFE',
              borderRadius: 8,
              padding: '8px 12px',
              marginBottom: 12,
            }}
          >
            <strong>最新繁衍记忆账本：</strong>
            {sproutRuns[0].memorySummary}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 12,
            flexWrap: 'wrap',
          }}
        >
          <button
            className={`btn ${sproutTab === 'current' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSproutTab('current')}
          >
            当前词条「{activeTerm.title}」触手 ({sproutTermCandidates.length})
          </button>
          <button
            className={`btn ${sproutTab === 'pending' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSproutTab('pending')}
          >
            待裂变队列 ({sproutStats.pendingCount})
          </button>
          <button
            className={`btn ${sproutTab === 'merged' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSproutTab('merged')}
          >
            已并入同义别名 ({sproutStats.mergedAliasCount})
          </button>
          <button
            className={`btn ${sproutTab === 'generated' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSproutTab('generated')}
          >
            已生成新词条 ({sproutStats.generatedCount})
          </button>
          <button
            className={`btn ${sproutTab === 'rejected' ? 'btn-primary' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setSproutTab('rejected')}
          >
            已剔除记忆 ({sproutStats.rejectedCount})
          </button>
        </div>

        {/* 触手卡片列表 */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingRight: 4,
          }}
        >
          {(() => {
            const list =
              sproutTab === 'current'
                ? sproutTermCandidates
                : sproutTab === 'pending'
                  ? sproutCandidates.filter((c) => c.status === 'PENDING')
                  : sproutTab === 'merged'
                    ? sproutCandidates.filter((c) => c.status === 'MERGED_ALIAS')
                    : sproutTab === 'generated'
                      ? sproutCandidates.filter((c) => c.status === 'GENERATED')
                      : sproutCandidates.filter((c) => c.status === 'REJECTED');

            if (list.length === 0) {
              return (
                <div
                  style={{
                    padding: 28,
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: 13,
                    background: 'var(--surface-subtle)',
                    borderRadius: 10,
                    border: '1px dashed var(--line)',
                  }}
                >
                  当前视图下暂无触手记录。可点击右上角「顺藤摸瓜剖析「{activeTerm.title}」」抓出正文中的衍生概念与同义别名。
                </div>
              );
            }

            return list.map((cand) => {
              const isBusy = resolvingCandidateId === cand.id;
              const selectedTargetId =
                aliasTargetOverrides[cand.id] ||
                cand.recommendedTargetTermId ||
                activeTerm.id;
              const targetTermObj = termMap.get(
                cand.targetTermId || selectedTargetId
              );

              const statusLabelMap: Record<string, { text: string; cls: string }> = {
                PENDING: { text: '待决策', cls: 'badge-amber' },
                GENERATED: { text: '已生成独立词条', cls: 'badge-green' },
                MERGED_ALIAS: { text: '已并入同义别名', cls: 'badge-blue' },
                LINKED_EXISTING: { text: '已绑定既有词条', cls: 'badge-blue' },
                REJECTED: { text: '已记入剔除记忆', cls: '' },
              };
              const st = statusLabelMap[cand.status] || {
                text: cand.status,
                cls: '',
              };

              const recActionMap: Record<string, string> = {
                MERGE_AS_ALIAS: `建议：作为同义词并入【${cand.recommendedTargetTermTitle || targetTermObj?.title || '目标词条'}】别名`,
                GENERATE_TERM: '建议：分叉生成独立业务词条',
                LINK_EXISTING: '已匹配既有词条并自动双向关联',
                REJECT: '建议：通用词剔除并记入免重审记忆',
              };

              return (
                <div
                  key={cand.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    background: '#FFFFFF',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>
                        {cand.name}
                      </span>
                      <span className={`badge ${st.cls}`}>{st.text}</span>
                      <span className="badge badge-blue" style={{ fontWeight: 500 }}>
                        {recActionMap[cand.recommendedAction] || cand.recommendedAction}
                      </span>
                    </div>

                    {cand.targetTermId && termMap.has(cand.targetTermId) && (
                      <button
                        className="btn"
                        style={{ fontSize: 12, padding: '3px 10px' }}
                        onClick={() => {
                          setSproutModalOpen(false);
                          openTermAsMain(cand.targetTermId!);
                        }}
                      >
                        查看【{termMap.get(cand.targetTermId!)?.title}】
                      </button>
                    )}
                  </div>

                  {cand.origins.map((orig, oIdx) => (
                    <div
                      key={`${cand.id}-orig-${oIdx}`}
                      style={{
                        fontSize: 12.5,
                        color: 'var(--muted)',
                        background: 'var(--surface-subtle)',
                        padding: '6px 10px',
                        borderRadius: 6,
                        marginBottom: 6,
                      }}
                    >
                      <div>
                        <strong>来源词条：</strong>
                        {orig.sourceTermTitle}（关系：{orig.relationLabel}）
                      </div>
                      <div>
                        <strong>原文摘录：</strong>「{orig.quote}」
                      </div>
                      <div>
                        <strong>业务价值：</strong>
                        {orig.whyItMatters}
                      </div>
                    </div>
                  ))}

                  <div style={{ fontSize: 12.5, color: 'var(--ink)', marginBottom: 8 }}>
                    <strong>AI 研判依据：</strong>
                    {cand.decisionNote || cand.recommendationReason}
                  </div>

                  {cand.status === 'PENDING' && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                        paddingTop: 8,
                        borderTop: '1px solid var(--line)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                          并入目标词条：
                        </span>
                        <select
                          value={selectedTargetId}
                          onChange={(e) =>
                            setAliasTargetOverrides((prev) => ({
                              ...prev,
                              [cand.id]: e.target.value,
                            }))
                          }
                          style={{
                            padding: '4px 8px',
                            borderRadius: 6,
                            border: '1px solid var(--line)',
                            fontSize: 12,
                          }}
                        >
                          {terms.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.title} ({t.id})
                            </option>
                          ))}
                        </select>
                        <button
                          className={`btn ${cand.recommendedAction === 'MERGE_AS_ALIAS' ? 'btn-primary' : ''}`}
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          disabled={isBusy}
                          onClick={() =>
                            handleResolveSprout(
                              cand,
                              'MERGE_AS_ALIAS',
                              selectedTargetId
                            )
                          }
                        >
                          并入【{termMap.get(selectedTargetId)?.title || selectedTargetId}】别名
                        </button>
                      </div>

                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          className={`btn ${cand.recommendedAction === 'GENERATE_TERM' ? 'btn-primary' : ''}`}
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          disabled={isBusy}
                          onClick={() => handleResolveSprout(cand, 'GENERATE_TERM')}
                        >
                          生成独立词条
                        </button>
                        <button
                          className="btn"
                          style={{ fontSize: 12, padding: '4px 10px', color: '#DC2626' }}
                          disabled={isBusy}
                          onClick={() => handleResolveSprout(cand, 'REJECT')}
                        >
                          剔除
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      </div>
    </div>
  );
}

export interface FullscreenMermaidModalProps {
  fullscreenMermaid: { code: string; title: string };
  setFullscreenMermaid: (val: { code: string; title: string } | null) => void;
  matchers: KeywordMatcher[];
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
}

export function FullscreenMermaidModal({
  fullscreenMermaid,
  setFullscreenMermaid,
  matchers,
  handleContainerClick,
}: FullscreenMermaidModalProps) {
  return (
    <div
      className="modal-backdrop"
      onClick={() => setFullscreenMermaid(null)}
      style={{ zIndex: 260 }}
    >
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '94vw',
          maxWidth: 1240,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 18,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--ink)' }}>
              {fullscreenMermaid.title}
            </h3>
          </div>
          <button className="btn" onClick={() => setFullscreenMermaid(null)}>
            关闭
          </button>
        </div>
        <div
          onClick={(e) => {
            handleContainerClick(e);
          }}
          style={{ flex: 1, overflow: 'hidden' }}
          dangerouslySetInnerHTML={{
            __html: compileMermaidToSvg(
              fullscreenMermaid.code,
              matchers,
              fullscreenMermaid.title
            ).replace(
              'class="mermaid-viewport"',
              'class="mermaid-viewport" style="height:72vh;max-height:72vh"'
            ),
          }}
        />
      </div>
    </div>
  );
}
