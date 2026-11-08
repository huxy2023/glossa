import React, { useRef, useState } from 'react';
import type {
  CandidateAction,
  ConceptLookupResult,
  ExpansionCandidate,
  ExpansionRun,
  TermEntry,
} from '@glossa/schema';
import type { ChatMessage, RightTabType } from '../components/lexiconUiHelpers';
import type { AdvisorTurnItem, DecoderResultState } from '../components/FaqAndDecoderViews';

export interface UseAgentAndSproutActionsParams {
  activeTerm: TermEntry | undefined;
  termMap: Map<string, TermEntry>;
  viewMode: 'pc' | 'mobile';
  setMobileSheetOpen: (open: boolean) => void;
  setMobileTab: (tab: 'read' | 'dir' | 'chat') => void;
  openRightPanel: (tab: RightTabType) => void;
  setSelectionBar: (bar: { text: string; x: number; y: number } | null) => void;
  setAuthStatus: (status: 'checking' | 'unauthenticated' | 'authenticated') => void;
  setTerms: React.Dispatch<React.SetStateAction<TermEntry[]>>;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  showNotice: (msg: string) => void;
}

export function useAgentAndSproutActions({
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
}: UseAgentAndSproutActionsParams) {
  const [chatSessionId, setChatSessionId] = useState<string>(() => `sess_${Date.now()}`);
  const [chatSessions, setChatSessions] = useState<
    Array<{ id: string; title: string; activeTermId?: string; updatedAt: string }>
  >([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text: '可针对当前词条直接提问，或在正文中划选任意词句追问业务规则与流程细节。',
    },
  ]);

  const chatAbortRef = useRef<AbortController | null>(null);
  const chatSessionIdRef = useRef<string>(chatSessionId);

  // 业务参谋 (Advisor & Skills) 多轮连续会话状态
  const [advisorSessionId, setAdvisorSessionId] = useState<string>(
    () => `adv_${Date.now()}`
  );
  const [advisorTurns, setAdvisorTurns] = useState<AdvisorTurnItem[]>([]);
  const [decoderInput, setDecoderInput] = useState(
    '移动端首页附近门店，没有可执行的门店'
  );
  const [advisorSkill, setAdvisorSkill] = useState<string>('auto');
  const [advisorEngine, setAdvisorEngine] = useState<'auto' | 'codex-cli' | 'llm-api'>('auto');
  const [decoderLoading, setDecoderLoading] = useState(false);
  const [decoderResult, setDecoderResult] = useState<DecoderResultState | null>(null);

  // 闭环 3：「抓到触手，引爆全场，处处生花」AI Agent Harness 触手裂变与同义归并记忆中心状态
  const [sproutModalOpen, setSproutModalOpen] = useState(false);
  const [sproutTab, setSproutTab] = useState<
    'current' | 'pending' | 'generated' | 'merged' | 'rejected'
  >('current');
  const [sproutRuns, setSproutRuns] = useState<ExpansionRun[]>([]);
  const [sproutCandidates, setSproutCandidates] = useState<ExpansionCandidate[]>([]);
  const [sproutTermCandidates, setSproutTermCandidates] = useState<ExpansionCandidate[]>([]);
  const [sproutStats, setSproutStats] = useState<{
    totalCandidates: number;
    pendingCount: number;
    generatedCount: number;
    mergedAliasCount: number;
    linkedExistingCount: number;
    rejectedCount: number;
  }>({
    totalCandidates: 0,
    pendingCount: 0,
    generatedCount: 0,
    mergedAliasCount: 0,
    linkedExistingCount: 0,
    rejectedCount: 0,
  });
  const [sproutBusy, setSproutBusy] = useState(false);
  const [resolvingCandidateId, setResolvingCandidateId] = useState<string | null>(null);
  const [aliasTargetOverrides, setAliasTargetOverrides] = useState<Record<string, string>>({});
  const [lookupInput, setLookupInput] = useState('');
  const [lookupResult, setLookupResult] = useState<ConceptLookupResult | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const stopAgentHarness = () => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort();
      chatAbortRef.current = null;
    }
    setChatLoading(false);
  };

  const askAgentHarness = async (
    questionText: string,
    selectedSnippet?: string,
    termIdOverride?: string
  ) => {
    const q = questionText.trim();
    const targetTerm = (termIdOverride ? termMap.get(termIdOverride) : activeTerm) || activeTerm;
    if (!q || !targetTerm || chatLoading) return;
    const originTermId = targetTerm.id;
    const originTermTitle = targetTerm.title;
    const originSessionId = chatSessionIdRef.current;

    setChatInput('');
    setSelectionBar(null);
    if (viewMode === 'mobile') {
      setMobileSheetOpen(false);
      setMobileTab('chat');
    } else {
      openRightPanel('chat');
    }

    setChatMessages((prev) => [
      ...prev,
      {
        role: 'user',
        text: q,
        selectedPhrase: selectedSnippet,
        originTermId,
        originTermTitle,
      },
      {
        role: 'assistant',
        text: '',
        streamingStatus: '正在检索业务知识库...',
        selectedPhrase: selectedSnippet,
        originTermId,
        originTermTitle,
      },
    ]);
    setChatLoading(true);

    const abortCtrl = new AbortController();
    chatAbortRef.current = abortCtrl;

    const updateLastAssistant = (updater: (msg: ChatMessage) => ChatMessage) => {
      if (chatSessionIdRef.current !== originSessionId) return;
      setChatMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (next[lastIdx]?.role === 'assistant') {
          next[lastIdx] = updater(next[lastIdx]);
        }
        return next;
      });
    };

    try {
      const res = await fetch('/api/agent/ask/stream', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        signal: abortCtrl.signal,
        body: JSON.stringify({
          sessionId: originSessionId,
          question: q,
          activeTermId: originTermId,
          selectedText: selectedSnippet,
        }),
      });
      if (res.status === 401) {
        setAuthStatus('unauthenticated');
        setChatLoading(false);
        return;
      }
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        updateLastAssistant((m) => ({
          ...m,
          text: `请求未成功：${errData?.error || '服务端返回异常'}`,
          streamingStatus: undefined,
          retryQuestion: q,
          retrySnippet: selectedSnippet,
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const evtBlock of events) {
          const lines = evtBlock.split('\n');
          let eventType = 'message';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            if (eventType === 'status') {
              updateLastAssistant((m) => ({
                ...m,
                streamingStatus: payload.text,
                trace: payload.trace || m.trace,
              }));
            } else if (eventType === 'delta') {
              updateLastAssistant((m) => ({
                ...m,
                text: (m.text || '') + (payload.delta || ''),
                streamingStatus: undefined,
              }));
            } else if (eventType === 'done') {
              updateLastAssistant((m) => ({
                ...m,
                text: payload.answer || m.text,
                streamingStatus: undefined,
                trace: payload.trace,
                commits: payload.referencedCommits,
                mode: payload.mode,
              }));
            } else if (eventType === 'error') {
              updateLastAssistant((m) => ({
                ...m,
                text: payload.answer || `请求未成功：${payload.error || '未知错误'}`,
                streamingStatus: undefined,
                trace: payload.trace,
                commits: payload.referencedCommits,
                mode: payload.mode,
                retryQuestion: q,
                retrySnippet: selectedSnippet,
              }));
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        updateLastAssistant((m) => ({
          ...m,
          text: m.text ? `${m.text}\n\n*(已停止生成)*` : `已停止本次请求。`,
          streamingStatus: undefined,
          retryQuestion: q,
          retrySnippet: selectedSnippet,
        }));
        return;
      }
      updateLastAssistant((m) => ({
        ...m,
        text: `网络或服务端异常：${err?.message || '请检查网络连接'}`,
        streamingStatus: undefined,
        retryQuestion: q,
        retrySnippet: selectedSnippet,
      }));
    } finally {
      if (chatAbortRef.current === abortCtrl) {
        chatAbortRef.current = null;
        setChatLoading(false);
      }
    }
  };

  const loadChatSessions = async () => {
    try {
      const res = await fetch('/api/agent/sessions', {
        credentials: 'include',
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && Array.isArray(data.sessions)) {
        setChatSessions(data.sessions);
      }
    } catch {}
  };

  const switchChatSession = async (targetSessionId: string) => {
    stopAgentHarness();
    chatSessionIdRef.current = targetSessionId;
    setChatSessionId(targetSessionId);
    try {
      const res = await fetch(
        `/api/agent/history?sessionId=${encodeURIComponent(targetSessionId)}`,
        {
          credentials: 'include',
          headers: authHeaders(),
        }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && Array.isArray(data.messages) && data.messages.length > 0) {
        setChatMessages(
          data.messages.map((m: any) => ({
            role: m.role,
            text: m.content,
            trace: m.trace,
            mode: m.mode,
          }))
        );
      }
    } catch {}
  };

  const startNewChatSession = () => {
    stopAgentHarness();
    const nextId = `sess_${Date.now()}`;
    chatSessionIdRef.current = nextId;
    setChatSessionId(nextId);
    setChatMessages([
      {
        role: 'assistant',
        text: `已切换至新对话（当前词条：**${activeTerm?.title || ''}**）。`,
        originTermId: activeTerm?.id,
        originTermTitle: activeTerm?.title,
      },
    ]);
  };

  const handleSaveFaq = async (msgIdx: number) => {
    if (!activeTerm) return;
    const aiMsg = chatMessages[msgIdx];
    const userMsg = chatMessages[msgIdx - 1];
    if (!aiMsg) return;
    const targetTermId = aiMsg.originTermId || userMsg?.originTermId || activeTerm.id;
    const q = userMsg?.text || '问答记录';
    const a = aiMsg.text.trim();

    try {
      const res = await fetch('/api/lexicon/faq', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ termId: targetTermId, q, a }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data.term) {
        setTerms((prev) => prev.map((t) => (t.id === data.term.id ? data.term : t)));
        showNotice(`已收录至「${data.term.title}」FAQ`);
      } else {
        showNotice(`保存 FAQ 失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('保存 FAQ 失败：网络错误');
    }
  };

  const startNewAdvisorSession = () => {
    setAdvisorSessionId(`adv_${Date.now()}`);
    setAdvisorTurns([]);
    setDecoderResult(null);
    setDecoderInput('');
  };

  const handleDecodeParagraph = async (
    overrideText?: string,
    overrideSkill?: string,
    overrideEngine?: 'auto' | 'codex-cli' | 'llm-api'
  ) => {
    const targetText = (overrideText !== undefined ? overrideText : decoderInput).trim();
    if (!targetText || decoderLoading) return;
    if (overrideText !== undefined) setDecoderInput(overrideText);
    const effectiveSkill = overrideSkill !== undefined ? overrideSkill : advisorSkill;
    if (overrideSkill !== undefined) setAdvisorSkill(overrideSkill);
    const effectiveEngine = overrideEngine !== undefined ? overrideEngine : advisorEngine;
    if (overrideEngine !== undefined) setAdvisorEngine(overrideEngine);

    const historyPayload = advisorTurns.flatMap((turn) => [
      {
        role: 'user' as const,
        content: turn.question,
        skillId: turn.skillId,
      },
      {
        role: 'assistant' as const,
        content: turn.result.translationMarkdown,
        skillId: turn.result.skillId || turn.skillId,
      },
    ]);

    setDecoderLoading(true);
    try {
      const res = await fetch('/api/agent/consult', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          text: targetText,
          sessionId: advisorSessionId,
          history: historyPayload,
          skillId: effectiveSkill === 'auto' ? undefined : effectiveSkill,
          enginePreference: effectiveEngine,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        const nextTurn: AdvisorTurnItem = {
          id: `adv_turn_${Date.now()}`,
          question: targetText,
          skillId: data.skillId || effectiveSkill,
          enginePreference: effectiveEngine,
          result: data,
          createdAt: new Date().toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
        };
        setAdvisorTurns((prev) => [...prev, nextTurn]);
        setDecoderResult(data);
        setDecoderInput('');
      } else {
        showNotice(`参谋推演失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，业务参谋请求失败');
    } finally {
      setDecoderLoading(false);
    }
  };

  const refreshLexiconTermsSilently = async () => {
    try {
      const res = await fetch('/api/lexicon', {
        credentials: 'include',
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && Array.isArray(data.terms)) {
        setTerms(data.terms);
      }
    } catch {}
  };

  const loadHarnessOverview = async (targetTermId?: string) => {
    try {
      const effectiveTermId = targetTermId || activeTerm?.id || '';
      const res = await fetch(
        `/api/harness/overview?termId=${encodeURIComponent(effectiveTermId)}`,
        {
          credentials: 'include',
          headers: authHeaders(),
        }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok) {
        setSproutRuns(data.runs || []);
        setSproutCandidates(data.candidates || []);
        setSproutTermCandidates(data.termCandidates || []);
        if (data.stats) setSproutStats(data.stats);
      }
    } catch {}
  };

  const openSproutModal = async (targetTermId?: string) => {
    setSproutModalOpen(true);
    setSproutTab('current');
    await loadHarnessOverview(targetTermId || activeTerm?.id);
  };

  const handleDissectTerm = async (targetTermId?: string) => {
    const effectiveId = targetTermId || activeTerm?.id;
    if (!effectiveId) return;
    setSproutBusy(true);
    try {
      const res = await fetch('/api/harness/dissect', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sourceTermId: effectiveId }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        await loadHarnessOverview(effectiveId);
        await refreshLexiconTermsSilently();
        showNotice(
          `顺藤摸瓜剖析完成：新捕获 ${data.enqueued?.length || 0} 条触手，自动绑定既有词条 ${data.autoLinked?.length || 0} 条`
        );
      } else {
        showNotice(`剖析失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，触手剖析失败');
    } finally {
      setSproutBusy(false);
    }
  };

  const handleResolveSprout = async (
    candidate: ExpansionCandidate,
    action: CandidateAction,
    overrideTargetId?: string
  ) => {
    setResolvingCandidateId(candidate.id);
    try {
      const targetTermId =
        overrideTargetId ||
        aliasTargetOverrides[candidate.id] ||
        candidate.recommendedTargetTermId;
      const res = await fetch('/api/harness/resolve', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          candidateId: candidate.id,
          action,
          targetTermId,
          publishImmediately: true,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        await loadHarnessOverview(activeTerm?.id);
        await refreshLexiconTermsSilently();
        if (action === 'MERGE_AS_ALIAS') {
          showNotice(
            `已将「${candidate.name}」并入词条【${data.affectedTerm?.title || targetTermId}】别名并自动补齐双向关联`
          );
        } else if (action === 'GENERATE_TERM') {
          showNotice(
            `已生成独立词条【${data.affectedTerm?.title || candidate.name}】并补齐父子双向关联`
          );
        } else if (action === 'REJECT') {
          showNotice(`已将「${candidate.name}」记入剔除记忆，后续剖析将自动跳过`);
        }
      } else {
        showNotice(`执行失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，触手决议失败');
    } finally {
      setResolvingCandidateId(null);
    }
  };

  const handleRunSproutWave = async (seedTermId?: string) => {
    const effectiveId = seedTermId || activeTerm?.id || '';
    setSproutBusy(true);
    try {
      const res = await fetch('/api/harness/run-wave', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          seedTermId: effectiveId,
          maxDepth: 2,
          maxDrafts: 4,
          autoResolve: true,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        await loadHarnessOverview(effectiveId);
        await refreshLexiconTermsSilently();
        showNotice(
          `波次引爆完成：新增独立词条 ${data.generatedTerms?.length || 0} 条，归并同义别名 ${data.mergedAliases?.length || 0} 条，剔除噪音 ${data.rejectedCandidates?.length || 0} 条`
        );
      } else {
        showNotice(`波次引爆失败：${data?.error || '未知错误'}`);
      }
    } catch {
      showNotice('网络异常，波次引爆失败');
    } finally {
      setSproutBusy(false);
    }
  };

  const handleConceptLookup = async (rawQuery?: string) => {
    const q = (rawQuery !== undefined ? rawQuery : lookupInput).trim();
    if (!q) return;
    if (rawQuery !== undefined) setLookupInput(rawQuery);
    setLookupLoading(true);
    try {
      const res = await fetch('/api/harness/lookup', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          query: q,
          category: activeTerm?.category,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok) {
        setLookupResult(data);
      }
    } catch {
      showNotice('概念查重请求失败');
    } finally {
      setLookupLoading(false);
    }
  };

  return {
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
  };
}
