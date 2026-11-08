import React from 'react';
import type { TermEntry } from '@glossa/schema';
import {
  autoLinkHtml,
  escapeHtml,
  renderChatMarkdownHtml,
  type KeywordMatcher,
} from './v5ArticleHtml';
import {
  cleanBusinessSubtitle,
  type ChatMessage,
  type MainTabType,
} from './lexiconUiHelpers';

export interface PeekCardViewProps {
  targetTerm: TermEntry;
  terms: TermEntry[];
  termMap: Map<string, TermEntry>;
  activeTerm: TermEntry;
  graphCenterId: string;
  mainTab: MainTabType;
  peekStack: string[];
  setPeekStack: React.Dispatch<React.SetStateAction<string[]>>;
  matchers: KeywordMatcher[];
  focusGraphCenter: (tid: string) => void;
  setMobileSheetOpen: (open: boolean) => void;
  openTermAsMain: (tid: string) => void;
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOver: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOut: () => void;
}

export function PeekCardView({
  targetTerm,
  terms,
  termMap,
  activeTerm,
  graphCenterId,
  mainTab,
  peekStack,
  setPeekStack,
  matchers,
  focusGraphCenter,
  setMobileSheetOpen,
  openTermAsMain,
  handleContainerClick,
  handleContainerMouseOver,
  handleContainerMouseOut,
}: PeekCardViewProps) {
  const centerTerm = termMap.get(graphCenterId) || activeTerm || terms[0];
  const inLabelsFromTarget =
    mainTab === 'graph' && centerTerm && targetTerm.id !== centerTerm.id
      ? (targetTerm.relations || [])
          .filter((r) => r.target === centerTerm.id)
          .map((r) => r.label || '直接引用')
      : [];
  const outLabelsToTarget =
    mainTab === 'graph' && centerTerm && targetTerm.id !== centerTerm.id
      ? (centerTerm.relations || [])
          .filter((r) => r.target === targetTerm.id)
          .map((r) => r.label || '直接关联')
      : [];

  return (
    <div
      onClick={handleContainerClick}
      onMouseOver={handleContainerMouseOver}
      onMouseOut={handleContainerMouseOut}
    >
      {peekStack.length > 1 && (
        <div
          style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--surface-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          {peekStack.map((id, idx) => {
            const t = termMap.get(id);
            if (!t) return null;
            const isLast = idx === peekStack.length - 1;
            return (
              <React.Fragment key={`${id}-${idx}`}>
                <span
                  onClick={() => setPeekStack(peekStack.slice(0, idx + 1))}
                  style={{
                    fontSize: 12,
                    cursor: 'pointer',
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: isLast ? 'var(--primary)' : '#E2E8F0',
                    color: isLast ? '#fff' : 'var(--ink)',
                    fontWeight: isLast ? 600 : 400,
                  }}
                >
                  {t.title}
                </span>
                {!isLast && <span style={{ color: 'var(--muted)' }}>/</span>}
              </React.Fragment>
            );
          })}
        </div>
      )}

      <div style={{ padding: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 10,
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h3 style={{ fontSize: 19, fontWeight: 800, color: 'var(--ink)' }}>
              {targetTerm.title}
            </h3>
            {cleanBusinessSubtitle(targetTerm.subtitle) && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {cleanBusinessSubtitle(targetTerm.subtitle)}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mainTab === 'graph' && centerTerm && targetTerm.id !== centerTerm.id && (
              <button
                className="btn"
                onClick={() => {
                  focusGraphCenter(targetTerm.id);
                  setMobileSheetOpen(false);
                }}
              >
                查看关联
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={() => openTermAsMain(targetTerm.id)}
            >
              阅读全文
            </button>
          </div>
        </div>

        {(inLabelsFromTarget.length > 0 || outLabelsToTarget.length > 0) && (
          <div
            style={{
              background: '#EFF6FF',
              border: '1px solid #BFDBFE',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 12.5,
              lineHeight: 1.6,
              color: '#1E3A8A',
            }}
          >
            {inLabelsFromTarget.length > 0 && (
              <div>
                <strong>引用「{centerTerm.title}」：</strong>
                {inLabelsFromTarget.join('；')}
              </div>
            )}
            {outLabelsToTarget.length > 0 && (
              <div>
                <strong>被「{centerTerm.title}」引用：</strong>
                {outLabelsToTarget.join('；')}
              </div>
            )}
          </div>
        )}

        <div
          style={{
            background: 'var(--surface-subtle)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: 12,
            marginBottom: 12,
            fontSize: 13.5,
            lineHeight: 1.65,
            color: 'var(--ink)',
          }}
          dangerouslySetInnerHTML={{
            __html: `<strong>一句话定义：</strong>${autoLinkHtml(
              targetTerm.summary,
              targetTerm.id,
              matchers
            )}`,
          }}
        />

        <div
          style={{
            background: '#ECFDF5',
            border: '1px solid #A7F3D0',
            borderRadius: 10,
            padding: 12,
            marginBottom: 12,
            fontSize: 13.5,
            lineHeight: 1.68,
            color: '#065F46',
          }}
          dangerouslySetInnerHTML={{
            __html: `<strong>直观类比：</strong>${autoLinkHtml(
              targetTerm.layman.analogy,
              targetTerm.id,
              matchers
            )}`,
          }}
        />

        <div style={{ marginBottom: 4 }}>
          <div className="badge badge-blue" style={{ marginBottom: 6 }}>
            业务说明
          </div>
          <p
            style={{ fontSize: 13.5, lineHeight: 1.68, color: 'var(--text)' }}
            dangerouslySetInnerHTML={{
              __html: autoLinkHtml(
                targetTerm.layman.plain,
                targetTerm.id,
                matchers
              ),
            }}
          />
        </div>
      </div>
    </div>
  );
}

export interface CompanionChatPanelProps {
  activeTerm: TermEntry;
  chatSessionId: string;
  chatSessions: Array<{ id: string; title: string; activeTermId?: string; updatedAt: string }>;
  chatMessages: ChatMessage[];
  chatInput: string;
  setChatInput: (v: string) => void;
  chatLoading: boolean;
  matchers: KeywordMatcher[];
  loadChatSessions: () => void;
  switchChatSession: (id: string) => void;
  startNewChatSession: () => void;
  askAgentHarness: (q: string, snippet?: string, termIdOverride?: string) => void;
  stopAgentHarness: () => void;
  handleSaveFaq: (idx: number) => void;
  handleAdoptAiAnswerAsTerm: (idx: number, asAsop?: boolean) => void;
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
  handleMouseUpSelection: () => void;
}

export function CompanionChatPanel({
  activeTerm,
  chatSessionId,
  chatSessions,
  chatMessages,
  chatInput,
  setChatInput,
  chatLoading,
  matchers,
  loadChatSessions,
  switchChatSession,
  startNewChatSession,
  askAgentHarness,
  stopAgentHarness,
  handleSaveFaq,
  handleAdoptAiAnswerAsTerm,
  handleContainerClick,
  handleMouseUpSelection,
}: CompanionChatPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--primary-soft)',
          borderBottom: '1px solid #C7D2FE',
          fontSize: 12,
          color: '#1E3A8A',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <span>
          当前词条：<strong>{activeTerm?.title || ''}</strong>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {chatSessions.length > 0 && (
            <select
              value={chatSessionId}
              onFocus={loadChatSessions}
              onChange={(e) => switchChatSession(e.target.value)}
              style={{
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 6,
                border: '1px solid #93C5FD',
                background: '#FFFFFF',
                maxWidth: 135,
              }}
            >
              <option value={chatSessionId}>当前会话</option>
              {chatSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title.slice(0, 14)}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn"
            style={{ fontSize: 11, padding: '2px 7px', background: '#FFFFFF' }}
            onClick={() => {
              loadChatSessions();
              startNewChatSession();
            }}
          >
            + 新对话
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
        onClick={handleContainerClick}
        onMouseUp={handleMouseUpSelection}
      >
        {chatMessages.map((m, idx) => (
          <div
            key={idx}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '94%',
              background: m.role === 'user' ? 'var(--primary)' : 'var(--surface-subtle)',
              color: m.role === 'user' ? '#fff' : 'var(--ink)',
              border: `1px solid ${
                m.role === 'user' ? 'var(--primary)' : 'var(--line)'
              }`,
              borderRadius: 12,
              padding: '11px 14px',
              fontSize: 13.5,
              lineHeight: 1.65,
            }}
          >
            {m.streamingStatus && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--primary)',
                  fontWeight: 600,
                  marginBottom: m.text ? 8 : 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>{m.streamingStatus}</span>
              </div>
            )}

            {m.text && (
              <div
                dangerouslySetInnerHTML={{
                  __html:
                    m.role === 'user'
                      ? escapeHtml(m.text)
                      : renderChatMarkdownHtml(
                          m.text,
                          matchers,
                          m.originTermId || activeTerm?.id || ''
                        ),
                }}
              />
            )}

            {m.role === 'assistant' && m.retryQuestion && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--line)' }}>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 11.5, padding: '3px 9px' }}
                  disabled={chatLoading}
                  onClick={() =>
                    askAgentHarness(
                      m.retryQuestion!,
                      m.retrySnippet,
                      m.originTermId
                    )
                  }
                >
                  重新发送
                </button>
              </div>
            )}

            {m.role === 'assistant' &&
              idx > 0 &&
              !m.retryQuestion &&
              !m.streamingStatus &&
              m.text.trim().length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: '1px dashed var(--line)',
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  className="btn"
                  style={{ fontSize: 11.5, padding: '3px 8px' }}
                  onClick={() => handleSaveFaq(idx)}
                >
                  收入「{m.originTermTitle || activeTerm.title}」FAQ
                </button>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 11.5, padding: '3px 8px' }}
                  onClick={() => handleAdoptAiAnswerAsTerm(idx, false)}
                >
                  建为新词条
                </button>
                <button
                  className="btn"
                  style={{ fontSize: 11.5, padding: '3px 8px', color: '#6D28D9', borderColor: '#C4B5FD' }}
                  onClick={() => handleAdoptAiAnswerAsTerm(idx, true)}
                >
                  存为业务攻略
                </button>
              </div>
            )}
          </div>
        ))}
        {chatLoading && (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: '#F8FAFC',
              border: '1px dashed #CBD5E1',
              borderRadius: 10,
              padding: '8px 12px',
            }}
          >
            <span>正在生成回答...</span>
            <button
              className="btn"
              style={{ fontSize: 11, padding: '2px 8px', color: '#DC2626' }}
              onClick={stopAgentHarness}
            >
              停止
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          padding: '10px 12px',
          borderTop: '1px solid var(--line)',
          background: 'var(--surface-subtle)',
        }}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            className="btn"
            style={{ fontSize: 11.5, padding: '3px 8px' }}
            disabled={chatLoading}
            onClick={() => askAgentHarness('为什么费用门店和任务门店经常重叠？')}
          >
            为什么费用店与任务店常重叠？
          </button>
          <button
            className="btn"
            style={{ fontSize: 11.5, padding: '3px 8px' }}
            disabled={chatLoading}
            onClick={() =>
              askAgentHarness(`「${activeTerm.title}」有哪些业务准入条件与常见异常原因？`)
            }
          >
            「{activeTerm.title.slice(0, 6)}」有哪些准入条件与常见异常？
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !chatLoading) askAgentHarness(chatInput);
            }}
            placeholder={
              chatLoading
                ? '正在生成回答...'
                : `针对「${activeTerm.title}」提问...`
            }
            style={{
              flex: 1,
              padding: '9px 12px',
              borderRadius: 8,
              border: '1px solid var(--line)',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button
            className="btn btn-primary"
            disabled={chatLoading || !chatInput.trim()}
            onClick={() => askAgentHarness(chatInput)}
          >
            {chatLoading ? '生成中' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
