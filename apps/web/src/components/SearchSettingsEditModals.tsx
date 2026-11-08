import React from 'react';
import type { AIConfig, TermEntry } from '@glossa/schema';
import {
  cleanBusinessSubtitle,
  cleanCategoryLabel,
  type MainTabType,
} from './lexiconUiHelpers';

export interface CmdkSearchModalProps {
  cmdkQuery: string;
  setCmdkQuery: (v: string) => void;
  cmdkMatches: TermEntry[];
  mainTab: MainTabType;
  setCmdkOpen: (open: boolean) => void;
  focusGraphCenter: (tid: string) => void;
  openTermAsMain: (tid: string) => void;
  handleRecordFeedback: (
    type: 'MISSING_TERM' | 'CONTENT_CORRECTION',
    queryOrSelection: string,
    comment?: string
  ) => void;
  handleGenerateNewTerm: (title: string) => void;
}

export function CmdkSearchModal({
  cmdkQuery,
  setCmdkQuery,
  cmdkMatches,
  mainTab,
  setCmdkOpen,
  focusGraphCenter,
  openTermAsMain,
  handleRecordFeedback,
  handleGenerateNewTerm,
}: CmdkSearchModalProps) {
  return (
    <div className="modal-backdrop" onClick={() => setCmdkOpen(false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <input
            autoFocus
            value={cmdkQuery}
            onChange={(e) => setCmdkQuery(e.target.value)}
            placeholder="输入中文、拼音首字母 (如 FYMD / RWMD) 或业务别名..."
            style={{
              flex: 1,
              border: 'none',
              fontSize: 14.5,
              outline: 'none',
              color: 'var(--ink)',
            }}
          />
          <kbd
            style={{
              background: 'var(--surface-muted)',
              padding: '3px 7px',
              borderRadius: 5,
              fontSize: 11.5,
              color: 'var(--muted)',
            }}
          >
            ESC
          </kbd>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 8 }}>
          {cmdkMatches.map((t) => (
            <div
              key={t.id}
              className="nav-item"
              onClick={() => {
                if (mainTab === 'graph') {
                  focusGraphCenter(t.id);
                } else {
                  openTermAsMain(t.id);
                }
              }}
              style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}
            >
              <div>
                <div style={{ fontWeight: 700, color: 'var(--ink)' }}>
                  {t.title}{' '}
                  <span
                    style={{
                      fontWeight: 400,
                      fontSize: 12,
                      color: 'var(--muted)',
                    }}
                  >
                    {cleanBusinessSubtitle(t.subtitle)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--muted)',
                    marginTop: 2,
                  }}
                >
                  {t.summary.slice(0, 64)}...
                </div>
              </div>
              <span className="badge badge-blue">{t.pinyin}</span>
            </div>
          ))}

          {cmdkQuery.trim() && (
            <div
              style={{
                padding: 14,
                background: 'var(--primary-soft)',
                borderRadius: 10,
                marginTop: 8,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ fontWeight: 700, color: '#1E3A8A', fontSize: 13.5 }}>
                  未找到「{cmdkQuery}」相关词条
                </div>
                <div style={{ fontSize: 12, color: '#4338CA' }}>
                  可提交缺词工单，或立即生成词条草稿
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => {
                    handleRecordFeedback('MISSING_TERM', cmdkQuery.trim());
                    setCmdkOpen(false);
                  }}
                >
                  提交缺词工单
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleGenerateNewTerm(cmdkQuery)}
                >
                  生成词条草稿
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export interface AiSettingsModalProps {
  aiConfig: AIConfig & { hasKey?: boolean; maskedKey?: string };
  setAiConfig: React.Dispatch<
    React.SetStateAction<AIConfig & { hasKey?: boolean; maskedKey?: string }>
  >;
  aiSaveMsg: string;
  aiTesting: boolean;
  setSettingsOpen: (open: boolean) => void;
  handleTestAiConnection: () => void;
  handleSaveAiConfig: () => void;
}

export function AiSettingsModal({
  aiConfig,
  setAiConfig,
  aiSaveMsg,
  aiTesting,
  setSettingsOpen,
  handleTestAiConnection,
  handleSaveAiConfig,
}: AiSettingsModalProps) {
  return (
    <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <div
        className="modal-card"
        style={{ width: 500, padding: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{
            fontSize: 17,
            fontWeight: 800,
            color: 'var(--ink)',
            marginBottom: 6,
          }}
        >
          AI 引擎配置
        </h3>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16 }}>
          API Key 加密存储于服务端，前端不回读明文。
        </p>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            marginBottom: 18,
          }}
        >
          <div>
            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                display: 'block',
                marginBottom: 4,
              }}
            >
              协议格式
            </label>
            <select
              value={aiConfig.protocol}
              onChange={(e) =>
                setAiConfig({
                  ...aiConfig,
                  protocol: e.target.value as AIConfig['protocol'],
                })
              }
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}
            >
              <option value="openai-compatible">
                OpenAI Compatible (/v1/chat/completions - DeepSeek / OpenAI)
              </option>
              <option value="anthropic-messages">
                Anthropic Messages (/v1/messages - Claude)
              </option>
            </select>
          </div>
          <div>
            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Base URL
            </label>
            <input
              value={aiConfig.baseUrl}
              onChange={(e) => setAiConfig({ ...aiConfig, baseUrl: e.target.value })}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}
            />
          </div>
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
              }}
            >
              <label style={{ fontSize: 12.5, fontWeight: 600 }}>模型名称</label>
              <div style={{ display: 'flex', gap: 4 }}>
                {['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'].map((mName) => (
                  <button
                    key={mName}
                    type="button"
                    className={`btn ${aiConfig.model === mName ? 'btn-primary' : ''}`}
                    style={{ fontSize: 11, padding: '1px 7px' }}
                    onClick={() => setAiConfig({ ...aiConfig, model: mName })}
                  >
                    {mName}
                  </button>
                ))}
              </div>
            </div>
            <input
              value={aiConfig.model}
              onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                display: 'block',
                marginBottom: 4,
              }}
            >
              API Key{' '}
              {aiConfig.hasKey && (
                <span style={{ color: 'var(--emerald)', fontWeight: 700 }}>
                  （已配置：{aiConfig.maskedKey}，留空保持不变）
                </span>
              )}
            </label>
            <input
              type="password"
              value={aiConfig.apiKey}
              onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
              placeholder={
                aiConfig.hasKey
                  ? `已配置 (${aiConfig.maskedKey})，输入新 Key 可覆盖...`
                  : 'sk-...'
              }
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--line)',
              }}
            />
          </div>
          {aiSaveMsg && (
            <div style={{ fontSize: 12.5, color: 'var(--primary)', fontWeight: 600 }}>
              {aiSaveMsg}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <button
            className="btn"
            disabled={aiTesting}
            onClick={handleTestAiConnection}
          >
            {aiTesting ? '测试中...' : '测试连接'}
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={() => setSettingsOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={handleSaveAiConfig}>
              保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface TermEditFormState {
  id: string;
  revision: number;
  title: string;
  subtitle: string;
  category: string;
  aliasesText: string;
  summary: string;
  analogy: string;
  plain: string;
  articleMarkdown: string;
}

export interface TermEditModalProps {
  editForm: TermEditFormState;
  setEditForm: React.Dispatch<React.SetStateAction<TermEditFormState>>;
  categories: Array<{ id: string; name: string }>;
  editSaving: boolean;
  setEditModalOpen: (open: boolean) => void;
  handleSaveTermEdit: () => void;
}

export function TermEditModal({
  editForm,
  setEditForm,
  categories,
  editSaving,
  setEditModalOpen,
  handleSaveTermEdit,
}: TermEditModalProps) {
  return (
    <div className="modal-backdrop" onClick={() => setEditModalOpen(false)}>
      <div
        className="modal-card"
        style={{ width: 680, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', padding: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <h3 style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)' }}>
            编辑词条
          </h3>
          <span className="badge badge-blue">{editForm.id}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                词条名称
              </label>
              <input
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                副标题 / 补充说明
              </label>
              <input
                value={editForm.subtitle}
                onChange={(e) => setEditForm({ ...editForm, subtitle: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                所属业务分区
              </label>
              <select
                value={editForm.category}
                onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {cleanCategoryLabel(c.name)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                同义词 / 搜索别名（逗号分隔）
              </label>
              <input
                value={editForm.aliasesText}
                onChange={(e) => setEditForm({ ...editForm, aliasesText: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              一句话定义
            </label>
            <textarea
              rows={2}
              value={editForm.summary}
              onChange={(e) => setEditForm({ ...editForm, summary: e.target.value })}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                fontFamily: 'inherit',
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                直观比喻
              </label>
              <textarea
                rows={3}
                value={editForm.analogy}
                onChange={(e) => setEditForm({ ...editForm, analogy: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                业务白话解释
              </label>
              <textarea
                rows={3}
                value={editForm.plain}
                onChange={(e) => setEditForm({ ...editForm, plain: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              词条正文内容（Markdown）
            </label>
            <textarea
              rows={8}
              value={editForm.articleMarkdown}
              onChange={(e) => setEditForm({ ...editForm, articleMarkdown: e.target.value })}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                fontFamily: 'monospace',
                fontSize: 12.5,
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn" onClick={() => setEditModalOpen(false)}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={editSaving}
            onClick={handleSaveTermEdit}
          >
            {editSaving ? '保存中...' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  );
}
