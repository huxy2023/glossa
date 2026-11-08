import React from 'react';
import type {
  FeedbackTicket,
  TermEntry,
  TermRevisionRecord,
} from '@glossa/schema';
import { cleanBusinessSubtitle, type AuthUser } from './lexiconUiHelpers';

export interface FeedbackTicketsModalProps {
  feedbackTickets: FeedbackTicket[];
  myResolvedTickets: FeedbackTicket[];
  feedbackTab: 'missing' | 'correction' | 'mine';
  setFeedbackTab: (tab: 'missing' | 'correction' | 'mine') => void;
  currentUser: AuthUser | null;
  activeTerm: TermEntry;
  termMap: Map<string, TermEntry>;
  resolvingTicketId: string | null;
  setFeedbackModalOpen: (open: boolean) => void;
  handleAiResolveMissingTicket: (tk: FeedbackTicket) => void;
  openEditTermModal: (term: TermEntry) => void;
  handleResolveFeedbackTicket: (
    ticketId: string,
    status: 'TRIAGING' | 'RESOLVED_UPDATED' | 'REJECTED',
    resolutionTermId?: string,
    resolutionNote?: string
  ) => void;
  openTermAsMain: (tid: string) => void;
}

export function FeedbackTicketsModal({
  feedbackTickets,
  myResolvedTickets,
  feedbackTab,
  setFeedbackTab,
  currentUser,
  activeTerm,
  termMap,
  resolvingTicketId,
  setFeedbackModalOpen,
  handleAiResolveMissingTicket,
  openEditTermModal,
  handleResolveFeedbackTicket,
  openTermAsMain,
}: FeedbackTicketsModalProps) {
  return (
    <div className="modal-backdrop" onClick={() => setFeedbackModalOpen(false)}>
      <div
        className="modal-card"
        style={{
          width: 780,
          maxWidth: '95vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          padding: 22,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)' }}>
              共建工单中心
            </h3>
          </div>
          <button className="btn" onClick={() => setFeedbackModalOpen(false)}>
            关闭
          </button>
        </div>

        {myResolvedTickets.length > 0 && (
          <div
            style={{
              background: '#ECFDF5',
              border: '1px solid #A7F3D0',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 12,
              fontSize: 13,
              color: '#065F46',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span>
              你提报的 <strong>{myResolvedTickets.length} 项</strong> 工单已处理完毕
            </span>
            <button
              className="btn"
              style={{ fontSize: 12, padding: '3px 10px', background: '#FFFFFF' }}
              onClick={() => setFeedbackTab('mine')}
            >
              查看结案记录
            </button>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 14,
            borderBottom: '1px solid var(--line)',
            paddingBottom: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            className={`btn ${feedbackTab === 'missing' ? 'btn-primary' : ''}`}
            onClick={() => setFeedbackTab('missing')}
          >
            缺词工单 ({feedbackTickets.filter((t) => t.type === 'MISSING_TERM').length})
          </button>
          <button
            className={`btn ${feedbackTab === 'correction' ? 'btn-primary' : ''}`}
            onClick={() => setFeedbackTab('correction')}
          >
            口径纠错 ({feedbackTickets.filter((t) => t.type !== 'MISSING_TERM').length})
          </button>
          <button
            className={`btn ${feedbackTab === 'mine' ? 'btn-primary' : ''}`}
            onClick={() => setFeedbackTab('mine')}
          >
            我提报的 (
            {
              feedbackTickets.filter((t) => t.reporter === currentUser?.username)
                .length
            }
            )
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(() => {
            const list = feedbackTickets.filter((t) => {
              if (feedbackTab === 'missing') return t.type === 'MISSING_TERM';
              if (feedbackTab === 'correction') return t.type !== 'MISSING_TERM';
              return t.reporter === currentUser?.username;
            });
            if (list.length === 0) {
              return (
                <div
                  style={{
                    padding: 28,
                    textAlign: 'center',
                    color: 'var(--muted)',
                    background: 'var(--surface-subtle)',
                    borderRadius: 10,
                    fontSize: 13.5,
                  }}
                >
                  当前分栏暂无工单记录
                </div>
              );
            }

            return list.map((tk) => {
              const relatedTerm = tk.resolutionTermId
                ? termMap.get(tk.resolutionTermId)
                : tk.termId
                   ? termMap.get(tk.termId)
                   : undefined;
              const isPending = tk.status === 'OPEN' || tk.status === 'TRIAGING';
              return (
                <div
                  key={tk.id}
                  style={{
                    background:
                      tk.status === 'RESOLVED_UPDATED'
                        ? '#F0FDF4'
                        : 'var(--surface-subtle)',
                    border: `1px solid ${
                      tk.status === 'RESOLVED_UPDATED' ? '#BBF7D0' : 'var(--line)'
                    }`,
                    borderRadius: 10,
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        className={`badge ${
                          tk.type === 'MISSING_TERM' ? 'badge-purple' : 'badge-amber'
                        }`}
                      >
                        {tk.type === 'MISSING_TERM' ? '缺词' : '口径纠错'}
                      </span>
                      <span
                        className={`badge ${
                          tk.status === 'RESOLVED_UPDATED'
                            ? 'badge-green'
                            : tk.status === 'REJECTED'
                              ? 'badge-blue'
                              : 'badge-amber'
                        }`}
                      >
                        {tk.status === 'RESOLVED_UPDATED'
                          ? '已解决'
                          : tk.status === 'REJECTED'
                            ? '已忽略'
                            : `待处理 (${tk.hitCount})`}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        提报人: <strong>{tk.reporter}</strong> · {tk.updatedAt.slice(0, 16).replace('T', ' ')}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {isPending && tk.type === 'MISSING_TERM' && (
                        <button
                          className="btn btn-primary"
                          disabled={resolvingTicketId === tk.id}
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => handleAiResolveMissingTicket(tk)}
                        >
                          {resolvingTicketId === tk.id
                            ? '生成词条中...'
                            : '生成词条并结案'}
                        </button>
                      )}
                      {isPending && tk.termId && termMap.has(tk.termId) && (
                        <button
                          className="btn"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => {
                            setFeedbackModalOpen(false);
                            openEditTermModal(termMap.get(tk.termId!)!);
                          }}
                        >
                          编辑词条
                        </button>
                      )}
                      {isPending && (
                        <button
                          className="btn"
                          disabled={resolvingTicketId === tk.id}
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => {
                            const note =
                              window.prompt(
                                '请输入处理说明：',
                                '已核实并补充更新对应词条口径'
                              ) || '已核实并更新';
                            handleResolveFeedbackTicket(
                              tk.id,
                              'RESOLVED_UPDATED',
                              tk.termId || activeTerm?.id,
                              note
                            );
                          }}
                        >
                          标记已解决
                        </button>
                      )}
                      {relatedTerm && (
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => {
                            setFeedbackModalOpen(false);
                            openTermAsMain(relatedTerm.id);
                          }}
                        >
                          查看「{relatedTerm.title}」
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 14.5,
                      fontWeight: 700,
                      color: 'var(--ink)',
                      marginBottom: 4,
                    }}
                  >
                    「{tk.queryOrSelection}」
                    {tk.termId && termMap.get(tk.termId) && (
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginLeft: 8 }}>
                        （来源：{termMap.get(tk.termId)?.title} · v{tk.termRevision || 1}）
                      </span>
                    )}
                  </div>

                  {tk.comment && (
                    <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 4 }}>
                      备注：{tk.comment}
                    </div>
                  )}

                  {tk.status === 'RESOLVED_UPDATED' && (
                    <div
                      style={{
                        marginTop: 6,
                        paddingTop: 6,
                        borderTop: '1px dashed #86EFAC',
                        fontSize: 12.5,
                        color: '#166534',
                      }}
                    >
                      <strong>处理说明</strong>（{tk.resolvedBy || 'admin'}）：
                      {tk.resolutionNote || '已完成词条补充与修订'}
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

export interface RevisionHistoryModalProps {
  activeTerm: TermEntry;
  viewMode: 'pc' | 'mobile';
  revisionLoading: boolean;
  termRevisions: TermRevisionRecord[];
  selectedRevision: TermRevisionRecord | null;
  setSelectedRevision: (rev: TermRevisionRecord | null) => void;
  setRevisionModalOpen: (open: boolean) => void;
  handleRollbackRevision: (targetRev: number) => void;
}

export function RevisionHistoryModal({
  activeTerm,
  viewMode,
  revisionLoading,
  termRevisions,
  selectedRevision,
  setSelectedRevision,
  setRevisionModalOpen,
  handleRollbackRevision,
}: RevisionHistoryModalProps) {
  return (
    <div className="modal-backdrop" onClick={() => setRevisionModalOpen(false)}>
      <div
        className="modal-card"
        style={{
          width: 820,
          maxWidth: '95vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          padding: 22,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)' }}>
              修订记录 · {activeTerm.title}
            </h3>
          </div>
          <button className="btn" onClick={() => setRevisionModalOpen(false)}>
            关闭
          </button>
        </div>

        {revisionLoading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
            正在加载修订记录...
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: viewMode === 'mobile' ? '1fr' : '270px 1fr',
              gap: 16,
            }}
          >
            <div
              style={{
                borderRight: viewMode === 'mobile' ? 'none' : '1px solid var(--line)',
                paddingRight: viewMode === 'mobile' ? 0 : 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {termRevisions.map((rev) => {
                const isSelected = selectedRevision?.id === rev.id;
                const isCurrent = rev.revision === activeTerm.meta?.revision;
                return (
                  <div
                    key={rev.id}
                    onClick={() => setSelectedRevision(rev)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 10,
                      cursor: 'pointer',
                      border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--line)'}`,
                      background: isSelected ? 'var(--primary-soft)' : 'var(--surface-subtle)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontWeight: 800, fontSize: 13.5, color: 'var(--ink)' }}>
                        版本 v{rev.revision}
                      </span>
                      {isCurrent ? (
                        <span className="badge badge-green">当前生效</span>
                      ) : (
                        <span className="badge badge-blue">{rev.status}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 4 }}>
                      {rev.reason}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      修订人: {rev.operator} · {rev.createdAt.slice(0, 16).replace('T', ' ')}
                    </div>
                  </div>
                );
              })}
            </div>

            <div>
              {selectedRevision ? (
                <div>
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
                    <div>
                      <span className="badge badge-purple">
                        版本 v{selectedRevision.revision}
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          color: 'var(--muted)',
                          marginLeft: 8,
                        }}
                      >
                        修订原因：{selectedRevision.reason}
                      </span>
                    </div>
                    {selectedRevision.revision !== activeTerm.meta?.revision && (
                      <button
                        className="btn btn-primary"
                        onClick={() => handleRollbackRevision(selectedRevision.revision)}
                      >
                        回滚到此版本 (v{selectedRevision.revision})
                      </button>
                    )}
                  </div>

                  {selectedRevision.termSnapshot ? (
                    <div
                      style={{
                        background: 'var(--surface-subtle)',
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        padding: 14,
                        fontSize: 13,
                        lineHeight: 1.65,
                      }}
                    >
                      <div style={{ marginBottom: 8 }}>
                        <strong>标题：</strong>
                        {selectedRevision.termSnapshot.title}{' '}
                        {cleanBusinessSubtitle(selectedRevision.termSnapshot.subtitle) && (
                          <span style={{ color: 'var(--muted)' }}>
                            ({cleanBusinessSubtitle(selectedRevision.termSnapshot.subtitle)})
                          </span>
                        )}
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <strong>一句话定义：</strong>
                        {selectedRevision.termSnapshot.summary}
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <strong>白话比喻：</strong>
                        {selectedRevision.termSnapshot.layman.analogy}
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <strong>业务白话：</strong>
                        {selectedRevision.termSnapshot.layman.plain}
                      </div>
                      <div>
                        <strong>正文快照预览：</strong>
                        <pre
                          style={{
                            marginTop: 6,
                            padding: 10,
                            borderRadius: 8,
                            background: '#0F172A',
                            color: '#E2E8F0',
                            fontSize: 12,
                            maxHeight: 240,
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {selectedRevision.termSnapshot.articleMarkdown}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                      暂无版本快照详情。
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  请从左侧选择一个历史版本查看详情。
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
