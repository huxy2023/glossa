import React, { useState } from 'react';
import type {
  AIConfig,
  FeedbackTicket,
  TermEntry,
  TermRevisionRecord,
} from '@glossa/schema';
import type { ChatMessage, MainTabType } from '../components/lexiconUiHelpers';
import type { TermEditFormState } from '../components/SearchSettingsEditModals';

export interface UseTermAndFeedbackActionsParams {
  terms: TermEntry[];
  setTerms: React.Dispatch<React.SetStateAction<TermEntry[]>>;
  termMap: Map<string, TermEntry>;
  activeTerm: TermEntry | undefined;
  activeTermId: string;
  setActiveTermId: (tid: string) => void;
  setMainTab: (tab: MainTabType) => void;
  viewMode: 'pc' | 'mobile';
  setMobileTab: (tab: 'read' | 'dir' | 'chat') => void;
  setSelectionBar: (bar: { text: string; x: number; y: number } | null) => void;
  setCmdkOpen: (open: boolean) => void;
  setAuthStatus: (status: 'checking' | 'unauthenticated' | 'authenticated') => void;
  chatMessages: ChatMessage[];
  feedbackTickets: FeedbackTicket[];
  setFeedbackTickets: React.Dispatch<React.SetStateAction<FeedbackTicket[]>>;
  aiConfig: AIConfig & { hasKey?: boolean; maskedKey?: string };
  setAiConfig: React.Dispatch<
    React.SetStateAction<AIConfig & { hasKey?: boolean; maskedKey?: string }>
  >;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  showNotice: (msg: string) => void;
}

export function useTermAndFeedbackActions({
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
  setFeedbackTickets,
  aiConfig,
  setAiConfig,
  authHeaders,
  showNotice,
}: UseTermAndFeedbackActionsParams) {
  // 闭环 1：缺词雷达与划词纠错工单弹窗状态
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackTab, setFeedbackTab] = useState<'missing' | 'correction' | 'mine'>('missing');
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);

  // 闭环 2：词条历史版本时光机状态
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [termRevisions, setTermRevisions] = useState<TermRevisionRecord[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<TermRevisionRecord | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);

  // 词条编辑与 AI 设置弹窗状态
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiSaveMsg, setAiSaveMsg] = useState('');
  const [aiTesting, setAiTesting] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm] = useState<TermEditFormState>({
    id: '',
    revision: 1,
    title: '',
    subtitle: '',
    category: 'terminal',
    aliasesText: '',
    summary: '',
    analogy: '',
    plain: '',
    articleMarkdown: '',
  });

  const handleGenerateNewTerm = async (
    rawTitle: string,
    contextSnippet?: string,
    aiExplanation?: string,
    categoryOverride?: string
  ): Promise<TermEntry | null> => {
    const cleanTitle = rawTitle.replace(/[「」"'，。！？]/g, '').trim();
    if (!cleanTitle) return null;
    setSelectionBar(null);
    setCmdkOpen(false);
    showNotice(`正在生成「${cleanTitle}」词条草稿...`);

    try {
      const res = await fetch('/api/terms/evolve', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          title: cleanTitle,
          contextSnippet: contextSnippet || rawTitle,
          aiExplanation,
          sourceTermId: activeTerm?.id,
          category: categoryOverride || activeTerm?.category,
        }),
      });
      if (res.status === 401) {
        setAuthStatus('unauthenticated');
        return null;
      }
      const data = await res.json();
      if (res.ok && data?.ok && data.term) {
        setTerms((prev) => [data.term, ...prev.filter((t) => t.id !== data.term.id)]);
        setActiveTermId(data.term.id);
        setMainTab('article');
        if (viewMode === 'mobile') setMobileTab('read');
        showNotice(`已生成新词条草稿「${data.term.title}」`);
        return data.term as TermEntry;
      } else {
        showNotice(`生成失败：${data?.error || '未知错误'}`);
        return null;
      }
    } catch {
      showNotice('后端接口不可达，生成失败');
      return null;
    }
  };

  const handleAdoptAiAnswerAsTerm = async (msgIdx: number, asAsop = false) => {
    const aiMsg = chatMessages[msgIdx];
    const userMsg = chatMessages[msgIdx - 1];
    if (!aiMsg) return;
    const rawPhrase =
      aiMsg.selectedPhrase ||
      userMsg?.selectedPhrase ||
      (userMsg?.text.match(/「([^」]{2,28})」/)?.[1] ?? '') ||
      (userMsg?.text || '').replace(/^请结合.*?解释这句话[：:]?/g, '').trim().slice(0, 18);
    const defaultTitle = asAsop
      ? `${rawPhrase.slice(0, 14) || activeTerm?.title || '核心业务'}全流程攻略`
      : rawPhrase.slice(0, 20) || '新业务概念';
    const inputTitle = window.prompt(
      asAsop ? '请输入流程攻略标题：' : '请输入新词条名称：',
      defaultTitle
    );
    if (!inputTitle || !inputTitle.trim()) return;
    await handleGenerateNewTerm(
      inputTitle.trim(),
      aiMsg.selectedPhrase || userMsg?.text || inputTitle.trim(),
      aiMsg.text,
      asAsop ? 'asop' : undefined
    );
  };

  const openRevisionModal = async (termId: string) => {
    setRevisionModalOpen(true);
    setRevisionLoading(true);
    setSelectedRevision(null);
    try {
      const res = await fetch(`/api/revisions?termId=${encodeURIComponent(termId)}`, {
        credentials: 'include',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (res.ok && data?.ok && Array.isArray(data.revisions)) {
        setTermRevisions(data.revisions);
        if (data.revisions.length > 0) {
          setSelectedRevision(data.revisions[0]);
        }
      }
    } catch {
      showNotice('加载历史版本记录失败');
    } finally {
      setRevisionLoading(false);
    }
  };

  const handleRollbackRevision = async (targetRev: number) => {
    if (!activeTerm) return;
    const confirmed = window.confirm(
      `确认将词条「${activeTerm.title}」回滚至 v${targetRev} 吗？`
    );
    if (!confirmed) return;
    try {
      const res = await fetch(
        `/api/terms/${encodeURIComponent(activeTerm.id)}/rollback`,
        {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            targetRevision: targetRev,
            expectedRevision: activeTerm.meta?.revision,
          }),
        }
      );
      const data = await res.json();
      if (res.ok && data?.ok && data.term) {
        setTerms((prev) => prev.map((t) => (t.id === data.term.id ? data.term : t)));
        setRevisionModalOpen(false);
        showNotice(`已将「${data.term.title}」回滚至 v${targetRev}`);
      } else {
        showNotice(`回滚失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，版本回滚失败');
    }
  };

  const handlePublishTerm = async (termId: string) => {
    const target = termMap.get(termId);
    try {
      const res = await fetch(`/api/terms/${encodeURIComponent(termId)}/publish`, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: target?.meta?.revision,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.term) {
        setTerms((prev) => prev.map((t) => (t.id === data.term.id ? data.term : t)));
        showNotice(`词条「${data.term.title}」已发布`);
      } else {
        showNotice(`发布失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，词条发布失败');
    }
  };

  const openEditTermModal = (term: TermEntry) => {
    setEditForm({
      id: term.id,
      revision: term.meta?.revision || 1,
      title: term.title,
      subtitle: term.subtitle || '',
      category: term.category,
      aliasesText: (term.aliases || []).join(', '),
      summary: term.summary,
      analogy: term.layman?.analogy || '',
      plain: term.layman?.plain || '',
      articleMarkdown: term.articleMarkdown || '',
    });
    setEditModalOpen(true);
  };

  const handleSaveTermEdit = async () => {
    if (!editForm.id || !editForm.title.trim()) return;
    setEditSaving(true);
    try {
      const aliases = editForm.aliasesText
        .split(/[,，]/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      const res = await fetch(`/api/terms/${encodeURIComponent(editForm.id)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          title: editForm.title.trim(),
          subtitle: editForm.subtitle.trim(),
          category: editForm.category,
          aliases,
          summary: editForm.summary.trim(),
          laymanAnalogy: editForm.analogy.trim(),
          laymanPlain: editForm.plain.trim(),
          articleMarkdown: editForm.articleMarkdown,
          expectedRevision: editForm.revision,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.term) {
        setTerms((prev) => prev.map((t) => (t.id === data.term.id ? data.term : t)));
        setEditModalOpen(false);
        showNotice(`词条「${data.term.title}」已保存 (v${data.term.meta?.revision || 1})`);
      } else {
        showNotice(`保存失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，保存失败');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteTerm = async (term: TermEntry) => {
    const confirmed = window.confirm(
      `确认删除词条「${term.title}」吗？该操作不可恢复。`
    );
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/terms/${encodeURIComponent(term.id)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        const remaining = terms.filter((t) => t.id !== term.id);
        setTerms(remaining);
        if (activeTermId === term.id && remaining.length > 0) {
          setActiveTermId(remaining[0].id);
        }
        showNotice(`已删除词条「${term.title}」`);
      } else {
        showNotice(`删除失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，删除失败');
    }
  };

  const handleTestAiConnection = async () => {
    setAiTesting(true);
    setAiSaveMsg('正在测试接口连通性...');
    try {
      const res = await fetch('/api/settings/ai/test', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          protocol: aiConfig.protocol,
          baseUrl: aiConfig.baseUrl,
          model: aiConfig.model,
          apiKey: aiConfig.apiKey || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setAiSaveMsg(`连接成功 (${data.model} · ${data.latencyMs}ms)`);
      } else {
        setAiSaveMsg(`连接未通过：${data?.error || '未知错误'}`);
      }
    } catch {
      setAiSaveMsg('网络异常，测试连接失败');
    } finally {
      setAiTesting(false);
    }
  };

  const handleSaveAiConfig = async () => {
    setAiSaveMsg('正在保存...');
    try {
      const res = await fetch('/api/settings/ai', {
        method: 'PUT',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          protocol: aiConfig.protocol,
          baseUrl: aiConfig.baseUrl,
          model: aiConfig.model,
          apiKey: aiConfig.apiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setAiSaveMsg(data?.error || '保存失败');
        return;
      }
      setAiConfig((prev) => ({
        ...prev,
        protocol: data.aiConfig.protocol,
        baseUrl: data.aiConfig.baseUrl,
        model: data.aiConfig.model,
        hasKey: Boolean(data.aiConfig.hasKey),
        maskedKey: data.aiConfig.maskedKey || '',
        apiKey: '',
      }));
      setAiSaveMsg('');
      setSettingsOpen(false);
      showNotice('AI 接口配置已保存');
    } catch {
      setAiSaveMsg('网络异常，保存失败');
    }
  };

  const handleRecordFeedback = async (
    type: 'MISSING_TERM' | 'CONTENT_CORRECTION',
    queryOrSelection: string,
    comment?: string
  ) => {
    setSelectionBar(null);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          type,
          termId: activeTerm?.id,
          termRevision: activeTerm?.meta?.revision || 1,
          queryOrSelection,
          comment,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.ticket) {
        setFeedbackTickets((prev) => [
          data.ticket,
          ...prev.filter((t) => t.id !== data.ticket.id),
        ]);
        showNotice(
          type === 'MISSING_TERM'
            ? `已记录缺词「${queryOrSelection}」`
            : `已提交纠错工单`
        );
      }
    } catch {
      showNotice('提交反馈工单失败');
    }
  };

  const handleResolveFeedbackTicket = async (
    ticketId: string,
    status: 'TRIAGING' | 'RESOLVED_UPDATED' | 'REJECTED',
    resolutionTermId?: string,
    resolutionNote?: string
  ) => {
    setResolvingTicketId(ticketId);
    try {
      const res = await fetch(`/api/feedback/${encodeURIComponent(ticketId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          status,
          resolutionTermId,
          resolutionNote,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.ticket) {
        setFeedbackTickets((prev) =>
          prev.map((t) => (t.id === data.ticket.id ? data.ticket : t))
        );
        showNotice(
          status === 'RESOLVED_UPDATED'
            ? `工单已标记解决`
            : `工单状态已更新为 ${status}`
        );
      } else {
        showNotice(`更新工单失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，工单处理失败');
    } finally {
      setResolvingTicketId(null);
    }
  };

  const handleAiResolveMissingTicket = async (ticket: FeedbackTicket) => {
    setResolvingTicketId(ticket.id);
    const created = await handleGenerateNewTerm(
      ticket.queryOrSelection,
      ticket.comment || ticket.queryOrSelection
    );
    if (created) {
      await handleResolveFeedbackTicket(
        ticket.id,
        'RESOLVED_UPDATED',
        created.id,
        `已生成词条「${created.title}」`
      );
      setFeedbackModalOpen(false);
    } else {
      setResolvingTicketId(null);
    }
  };

  return {
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
  };
}
