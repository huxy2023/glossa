import React from 'react';
import type { TermEntry } from '@glossa/schema';
import {
  renderV5BespokeArticleHtml,
  type KeywordMatcher,
} from './v5ArticleHtml';
import {
  cleanBusinessSubtitle,
  type RightTabType,
} from './lexiconUiHelpers';

export interface RelationCompareWorkspaceProps {
  terms: TermEntry[];
  termMap: Map<string, TermEntry>;
  categories: Array<{ id: string; name: string }>;
  activeTerm: TermEntry;
  graphCenterId: string;
  setGraphCenterId: (tid: string) => void;
  graphSearchQuery: string;
  setGraphSearchQuery: (v: string) => void;
  compareTargetId: string | null;
  setCompareTargetId: (tid: string | null) => void;
  comparePickerOpen: boolean;
  setComparePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  compareSearchQuery: string;
  setCompareSearchQuery: (v: string) => void;
  expandedAsopId: string | null;
  setExpandedAsopId: (tid: string | null) => void;
  viewMode: 'pc' | 'mobile';
  matchers: KeywordMatcher[];
  focusGraphCenter: (tid: string) => void;
  openTermAsMain: (tid: string) => void;
  setPeekStack: React.Dispatch<React.SetStateAction<string[]>>;
  setMobileSheetOpen: (open: boolean) => void;
  openRightPanel: (tab: RightTabType) => void;
  handleContainerClick: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOver: (e: React.MouseEvent<HTMLElement>) => void;
  handleContainerMouseOut: () => void;
}

export function RelationCompareWorkspace({
  terms,
  termMap,
  categories,
  activeTerm,
  graphCenterId,
  setGraphCenterId,
  graphSearchQuery,
  setGraphSearchQuery,
  compareTargetId,
  setCompareTargetId,
  comparePickerOpen,
  setComparePickerOpen,
  compareSearchQuery,
  setCompareSearchQuery,
  expandedAsopId,
  setExpandedAsopId,
  viewMode,
  matchers,
  focusGraphCenter,
  openTermAsMain,
  setPeekStack,
  setMobileSheetOpen,
  openRightPanel,
  handleContainerClick,
  handleContainerMouseOver,
  handleContainerMouseOut,
}: RelationCompareWorkspaceProps) {
  const centerTerm = termMap.get(graphCenterId) || activeTerm || terms[0];
  const compareTargetTerm =
    compareTargetId && compareTargetId !== centerTerm.id
      ? termMap.get(compareTargetId) || null
      : null;

  const gq = graphSearchQuery.trim().toLowerCase();
  const searchMatches = gq
    ? terms
        .filter(
          (t) =>
            t.title.toLowerCase().includes(gq) ||
            t.pinyin.toLowerCase().includes(gq) ||
            (t.subtitle || '').toLowerCase().includes(gq) ||
            (t.aliases || []).some((a) => a.toLowerCase().includes(gq))
        )
        .slice(0, 8)
    : [];

  const cq = compareSearchQuery.trim().toLowerCase();
  const compareMatches = cq
    ? terms
        .filter(
          (t) =>
            t.id !== centerTerm.id &&
            (t.title.toLowerCase().includes(cq) ||
              t.pinyin.toLowerCase().includes(cq) ||
              (t.subtitle || '').toLowerCase().includes(cq) ||
              (t.aliases || []).some((a) => a.toLowerCase().includes(cq)))
        )
        .slice(0, 8)
    : [];

  const domainMetaMap: Record<
    string,
    { name: string; color: string; bg: string; border: string }
  > = {
    asop: { name: '流程攻略', color: '#6D28D9', bg: '#F5F3FF', border: '#C4B5FD' },
    terminal: { name: '门店终端', color: '#1D4ED8', bg: '#EFF6FF', border: '#93C5FD' },
    task: { name: '任务稽查', color: '#047857', bg: '#ECFDF5', border: '#6EE7B7' },
    activity: { name: '行销TPM', color: '#B45309', bg: '#FFFBEB', border: '#FCD34D' },
    visit: { name: '拜访执行', color: '#0E7490', bg: '#ECFEFF', border: '#67E8F9' },
    role: { name: '组织角色', color: '#4338CA', bg: '#EEF2FF', border: '#A5B4FC' },
    order: { name: '订单商品', color: '#C2410C', bg: '#FFF7ED', border: '#FDBA74' },
    funds: { name: '资金结算', color: '#BE185D', bg: '#FDF2F8', border: '#F9A8D4' },
  };

  const handleOpenPeek = (tid: string) => {
    if (!termMap.has(tid)) return;
    setPeekStack((prev) => (prev[prev.length - 1] === tid ? prev : [...prev, tid]));
    if (viewMode === 'mobile') {
      setMobileSheetOpen(true);
    } else {
      openRightPanel('peek');
    }
  };

  const handleStartCompare = (targetId: string) => {
    if (!targetId || targetId === centerTerm.id || !termMap.has(targetId)) return;
    setCompareTargetId(targetId);
    setComparePickerOpen(false);
    setCompareSearchQuery('');
  };

  interface MergedNeighbor {
    term: TermEntry;
    reasons: Array<{ sourceTitle: string; text: string }>;
  }

  const mergedNeighbors: MergedNeighbor[] = [];
  for (const t of terms) {
    if (t.id === centerTerm.id) continue;
    const fromCenter = (centerTerm.relations || [])
      .filter((r) => r.target === t.id && r.label && r.label.trim())
      .map((r) => r.label.trim());
    const fromNeighbor = (t.relations || [])
      .filter((r) => r.target === centerTerm.id && r.label && r.label.trim())
      .map((r) => r.label.trim());

    if (fromCenter.length === 0 && fromNeighbor.length === 0) continue;

    const reasons: Array<{ sourceTitle: string; text: string }> = [];
    const seenTexts = new Set<string>();
    for (const txt of fromCenter) {
      if (!seenTexts.has(txt)) {
        seenTexts.add(txt);
        reasons.push({ sourceTitle: centerTerm.title, text: txt });
      }
    }
    for (const txt of fromNeighbor) {
      if (!seenTexts.has(txt)) {
        seenTexts.add(txt);
        reasons.push({ sourceTitle: t.title, text: txt });
      }
    }
    mergedNeighbors.push({ term: t, reasons });
  }

  const asopNeighbors = mergedNeighbors.filter((n) => n.term.category === 'asop');
  const conceptNeighbors = mergedNeighbors.filter((n) => n.term.category !== 'asop');

  const conceptDomainGroups = categories
    .filter((c) => c.id !== 'asop')
    .map((c) => ({
      catId: c.id,
      meta: domainMetaMap[c.id] || domainMetaMap.terminal,
      items: conceptNeighbors
        .filter((n) => n.term.category === c.id)
        .sort((a, b) => a.term.title.localeCompare(b.term.title, 'zh-CN')),
    }))
    .filter((g) => g.items.length > 0);

  interface RelationPathStep {
    from: TermEntry;
    to: TermEntry;
    records: Array<{ sourceTitle: string; targetTitle: string; label: string }>;
  }

  const computeSingleShortestPath = (
    fromId: string,
    toId: string
  ): RelationPathStep[] | null => {
    if (!fromId || !toId || fromId === toId) return null;
    const adj = new Map<string, Set<string>>();
    for (const t of terms) {
      if (!adj.has(t.id)) adj.set(t.id, new Set());
      for (const r of t.relations || []) {
        if (!termMap.has(r.target) || r.target === t.id) continue;
        adj.get(t.id)!.add(r.target);
        if (!adj.has(r.target)) adj.set(r.target, new Set());
        adj.get(r.target)!.add(t.id);
      }
    }

    const visited = new Set<string>([fromId]);
    const queue: Array<{ curr: string; nodes: string[] }> = [
      { curr: fromId, nodes: [fromId] },
    ];

    while (queue.length > 0) {
      const { curr, nodes } = queue.shift()!;
      const edgeCount = nodes.length - 1;
      if (curr === toId) {
        const steps: RelationPathStep[] = [];
        for (let i = 0; i < nodes.length - 1; i++) {
          const u = termMap.get(nodes[i])!;
          const v = termMap.get(nodes[i + 1])!;
          const records: RelationPathStep['records'] = [];
          for (const r of u.relations || []) {
            if (r.target === v.id && r.label) {
              records.push({
                sourceTitle: u.title,
                targetTitle: v.title,
                label: r.label,
              });
            }
          }
          for (const r of v.relations || []) {
            if (r.target === u.id && r.label) {
              records.push({
                sourceTitle: v.title,
                targetTitle: u.title,
                label: r.label,
              });
            }
          }
          steps.push({ from: u, to: v, records });
        }
        return steps;
      }
      if (edgeCount >= 4) continue;
      for (const nextId of adj.get(curr) || []) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ curr: nextId, nodes: [...nodes, nextId] });
        }
      }
    }
    return null;
  };

  const centerCat = domainMetaMap[centerTerm.category] || domainMetaMap.terminal;

  return (
    <div className="article-container" style={{ maxWidth: 960 }}>
      {/* 顶栏：当前词条标题 + 搜索切换词条 + 与另一词对比入口 */}
      <div className="layer-card" style={{ marginBottom: 16, padding: '18px 22px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2
              style={{
                fontSize: 21,
                fontWeight: 800,
                color: 'var(--ink)',
                margin: 0,
              }}
            >
              关联与对比 · {centerTerm.title}
            </h2>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 6,
                color: centerCat.color,
                background: centerCat.bg,
                border: `1px solid ${centerCat.border}`,
              }}
            >
              {centerCat.name}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: viewMode === 'mobile' ? '100%' : 240 }}>
              <input
                value={graphSearchQuery}
                onChange={(e) => setGraphSearchQuery(e.target.value)}
                placeholder="搜索并切换词条..."
                style={{
                  width: '100%',
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  fontSize: 12.5,
                  background: '#FFFFFF',
                  outline: 'none',
                }}
              />
              {searchMatches.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    right: 0,
                    background: '#FFFFFF',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    boxShadow: '0 12px 28px rgba(15, 23, 42, 0.14)',
                    zIndex: 60,
                    maxHeight: 260,
                    overflowY: 'auto',
                    padding: 4,
                  }}
                >
                  {searchMatches.map((m) => (
                    <div
                      key={m.id}
                      onClick={() => focusGraphCenter(m.id)}
                      style={{
                        padding: '7px 10px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        fontSize: 12.5,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{m.title}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>切换</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {compareTargetTerm ? (
              <button
                className="btn"
                style={{ fontSize: 12.5, padding: '6px 12px' }}
                onClick={() => {
                  setCompareTargetId(null);
                  setComparePickerOpen(false);
                  setCompareSearchQuery('');
                }}
              >
                返回关联列表
              </button>
            ) : (
              <button
                className={`btn ${comparePickerOpen ? 'btn-primary' : ''}`}
                style={{ fontSize: 12.5, padding: '6px 12px' }}
                onClick={() => setComparePickerOpen((prev) => !prev)}
              >
                与另一词对比
              </button>
            )}

            <button
              className="btn"
              style={{ fontSize: 12.5, padding: '6px 12px' }}
              onClick={() => openTermAsMain(centerTerm.id)}
            >
              阅读全文
            </button>
          </div>
        </div>

        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            color: 'var(--text)',
            lineHeight: 1.6,
          }}
        >
          {centerTerm.summary}
        </div>

        {(comparePickerOpen || compareTargetTerm) && (
          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 750, color: 'var(--ink)' }}>
                双词对比：
              </span>
              <span className="badge badge-blue" style={{ fontSize: 12 }}>
                A · {centerTerm.title}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>vs</span>
              {compareTargetTerm ? (
                <span className="badge badge-purple" style={{ fontSize: 12 }}>
                  B · {compareTargetTerm.title}
                </span>
              ) : (
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  请选择对比词条
                </span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', width: viewMode === 'mobile' ? '100%' : 240 }}>
                <input
                  value={compareSearchQuery}
                  onChange={(e) => setCompareSearchQuery(e.target.value)}
                  placeholder={
                    compareTargetTerm
                      ? `更换对比词条（当前：${compareTargetTerm.title}）...`
                      : '搜索选择对比词条...'
                  }
                  style={{
                    width: '100%',
                    padding: '6px 11px',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    fontSize: 12.5,
                    background: '#FFFFFF',
                    outline: 'none',
                  }}
                />
                {compareMatches.length > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      right: 0,
                      background: '#FFFFFF',
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      boxShadow: '0 12px 28px rgba(15, 23, 42, 0.14)',
                      zIndex: 60,
                      maxHeight: 260,
                      overflowY: 'auto',
                      padding: 4,
                    }}
                  >
                    {compareMatches.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => handleStartCompare(m.id)}
                        style={{
                          padding: '7px 10px',
                          borderRadius: 7,
                          cursor: 'pointer',
                          fontSize: 12.5,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{m.title}</span>
                        <span style={{ fontSize: 11, color: 'var(--primary)' }}>对比</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {compareTargetTerm && (
                <button
                  className="btn"
                  style={{ fontSize: 12, padding: '5px 10px' }}
                  onClick={() => {
                    const prevCenter = centerTerm.id;
                    const nextCenter = compareTargetTerm.id;
                    setGraphCenterId(nextCenter);
                    setCompareTargetId(prevCenter);
                  }}
                >
                  互换 A / B
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {compareTargetTerm ? (
        (() => {
          const directNeighborEntry = mergedNeighbors.find(
            (n) => n.term.id === compareTargetTerm.id
          );
          const shortestPath = directNeighborEntry
            ? null
            : computeSingleShortestPath(centerTerm.id, compareTargetTerm.id);

          const sharedAsops = terms.filter((t) => {
            if (t.category !== 'asop') return false;
            const relTargets = new Set((t.relations || []).map((r) => r.target));
            const hasA =
              relTargets.has(centerTerm.id) ||
              (centerTerm.relations || []).some((r) => r.target === t.id);
            const hasB =
              relTargets.has(compareTargetTerm.id) ||
              (compareTargetTerm.relations || []).some((r) => r.target === t.id);
            return hasA && hasB;
          });

          return (
            <>
              <div className="layer-card" style={{ padding: 0, overflow: 'hidden' }}>
                <div
                  style={{
                    padding: '14px 20px',
                    borderBottom: '1px solid var(--line)',
                    background: 'var(--surface-subtle)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>
                    并排对比：{centerTerm.title} vs {compareTargetTerm.title}
                  </span>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table className="rel-compare-table">
                    <thead>
                      <tr>
                        <th className="rel-compare-label">比较项</th>
                        <th style={{ width: '44%' }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span>
                              {centerTerm.title}{' '}
                              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>
                                {cleanBusinessSubtitle(centerTerm.subtitle)}
                              </span>
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                className="btn"
                                style={{ fontSize: 11.5, padding: '2px 8px' }}
                                onClick={() => handleOpenPeek(centerTerm.id)}
                              >
                                查看
                              </button>
                              <button
                                className="btn"
                                style={{ fontSize: 11.5, padding: '2px 8px' }}
                                onClick={() => openTermAsMain(centerTerm.id)}
                              >
                                阅读全文
                              </button>
                            </div>
                          </div>
                        </th>
                        <th style={{ width: '44%' }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span>
                              {compareTargetTerm.title}{' '}
                              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>
                                {cleanBusinessSubtitle(compareTargetTerm.subtitle)}
                              </span>
                            </span>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                className="btn"
                                style={{ fontSize: 11.5, padding: '2px 8px' }}
                                onClick={() => handleOpenPeek(compareTargetTerm.id)}
                              >
                                查看
                              </button>
                              <button
                                className="btn"
                                style={{ fontSize: 11.5, padding: '2px 8px' }}
                                onClick={() => openTermAsMain(compareTargetTerm.id)}
                              >
                                阅读全文
                              </button>
                            </div>
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="rel-compare-label">一句话定义</td>
                        <td>{centerTerm.summary || '未维护'}</td>
                        <td>{compareTargetTerm.summary || '未维护'}</td>
                      </tr>
                      <tr>
                        <td className="rel-compare-label">业务说明</td>
                        <td>{centerTerm.layman?.plain || '未维护'}</td>
                        <td>{compareTargetTerm.layman?.plain || '未维护'}</td>
                      </tr>
                      <tr>
                        <td className="rel-compare-label">直观类比</td>
                        <td>{centerTerm.layman?.analogy || '未维护'}</td>
                        <td>{compareTargetTerm.layman?.analogy || '未维护'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="layer-card">
                <div className="rel-section-title">
                  <span>
                    关联关系：{centerTerm.title} 与 {compareTargetTerm.title}
                  </span>
                </div>

                {directNeighborEntry ? (
                  <div style={{ paddingTop: 8 }}>
                    {directNeighborEntry.reasons.map((r, idx) => (
                      <div key={idx} className="rel-reason-line">
                        <span className="rel-reason-source">{r.sourceTitle}：</span>
                        {r.text}
                      </div>
                    ))}
                  </div>
                ) : shortestPath && shortestPath.length > 0 ? (
                  <div style={{ paddingTop: 6 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--muted)',
                        marginBottom: 6,
                      }}
                    >
                      关联路径（共 {shortestPath.length} 步）：
                    </div>
                    <div>
                      {shortestPath.map((step, sIdx) => (
                        <div key={sIdx} className="rel-path-step">
                          <span className="step-num blue" style={{ marginTop: 2, flexShrink: 0 }}>
                            {sIdx + 1}
                          </span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 750, color: 'var(--ink)', marginBottom: 3 }}>
                              <span
                                className="rel-row-title"
                                onClick={() => handleOpenPeek(step.from.id)}
                              >
                                {step.from.title}
                              </span>
                              <span style={{ color: 'var(--muted)', margin: '0 8px' }}>—</span>
                              <span
                                className="rel-row-title"
                                onClick={() => handleOpenPeek(step.to.id)}
                              >
                                {step.to.title}
                              </span>
                            </div>
                            {step.records.map((rec, rIdx) => (
                              <div key={rIdx} className="rel-reason-line">
                                <span className="rel-reason-source">
                                  {rec.sourceTitle} → {rec.targetTitle}：
                                </span>
                                {rec.label}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ paddingTop: 10, fontSize: 13, color: 'var(--muted)' }}>
                    未找到 4 步以内的关联路径。
                  </div>
                )}

                {sharedAsops.length > 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid var(--line)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: 'var(--ink)',
                        marginBottom: 6,
                      }}
                    >
                      共同涉及的业务流程：
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {sharedAsops.map((asop) => (
                        <button
                          key={asop.id}
                          className="btn"
                          style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => openTermAsMain(asop.id)}
                        >
                          {asop.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          );
        })()
      ) : (
        <>
          <div className="layer-card">
            <div className="rel-section-title">
              <span>参与的业务流程 ({asopNeighbors.length})</span>
            </div>

            {asopNeighbors.length === 0 ? (
              <div style={{ padding: '14px 4px', fontSize: 13, color: 'var(--muted)' }}>
                暂无直接关联的业务流程攻略。
              </div>
            ) : (
              <div>
                {asopNeighbors.map((item) => {
                  const isExpanded = expandedAsopId === item.term.id;
                  const cleanTitle = item.term.title
                    .replace(/^攻略\s*ASOP\s*[·:：-]?\s*/i, '')
                    .trim();
                  return (
                    <div
                      key={item.term.id}
                      style={{ borderBottom: '1px solid var(--line)' }}
                    >
                      <div className="rel-row" style={{ borderBottom: 'none' }}>
                        <div className="rel-row-main">
                          <div className="rel-row-title-bar">
                            <span
                              className="rel-row-title"
                              onClick={() => handleOpenPeek(item.term.id)}
                            >
                              {cleanTitle}
                            </span>
                            <span className="badge badge-purple" style={{ fontSize: 10.5 }}>
                              流程攻略
                            </span>
                          </div>
                          {item.reasons.map((r, idx) => (
                            <div key={idx} className="rel-reason-line">
                              <span className="rel-reason-source">参与环节：</span>
                              {r.text}
                            </div>
                          ))}
                        </div>
                        <div className="rel-row-actions">
                          <button
                            className={`btn ${isExpanded ? 'btn-primary' : ''}`}
                            style={{ fontSize: 12, padding: '5px 10px' }}
                            onClick={() =>
                              setExpandedAsopId(isExpanded ? null : item.term.id)
                            }
                          >
                            {isExpanded ? '收起攻略' : '展开攻略'}
                          </button>
                          <button
                            className="btn"
                            style={{ fontSize: 12, padding: '5px 10px' }}
                            onClick={() => openTermAsMain(item.term.id)}
                          >
                            阅读全文
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div
                          style={{
                            margin: '4px 6px 14px',
                            padding: '14px 16px',
                            borderRadius: 10,
                            background: 'var(--surface-subtle)',
                            border: '1px solid var(--line)',
                          }}
                          onClick={handleContainerClick}
                          onMouseOver={handleContainerMouseOver}
                          onMouseOut={handleContainerMouseOut}
                          dangerouslySetInnerHTML={{
                            __html: renderV5BespokeArticleHtml(item.term, matchers),
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="layer-card">
            <div className="rel-section-title">
              <span>直接业务关联 ({conceptNeighbors.length})</span>
            </div>

            {conceptDomainGroups.length === 0 ? (
              <div style={{ padding: '14px 4px', fontSize: 13, color: 'var(--muted)' }}>
                暂无直接业务关联。
              </div>
            ) : (
              <div>
                {conceptDomainGroups.map((group) => (
                  <div key={group.catId} style={{ marginBottom: 8 }}>
                    <div className="rel-domain-heading">
                      <span
                        className="rel-dot"
                        style={{ background: group.meta.color }}
                      />
                      <span>
                        {group.meta.name} · {group.items.length}
                      </span>
                    </div>

                    <div>
                      {group.items.map((item) => {
                        const cleanSub = cleanBusinessSubtitle(item.term.subtitle);
                        return (
                          <div key={item.term.id} className="rel-row">
                            <div className="rel-row-main">
                              <div className="rel-row-title-bar">
                                <span
                                  className="rel-row-title"
                                  onClick={() => handleOpenPeek(item.term.id)}
                                >
                                  {item.term.title}
                                </span>
                                {cleanSub && (
                                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                                    {cleanSub}
                                  </span>
                                )}
                              </div>
                              {item.reasons.map((r, idx) => (
                                <div key={idx} className="rel-reason-line">
                                  <span className="rel-reason-source">{r.sourceTitle}：</span>
                                  {r.text}
                                </div>
                              ))}
                            </div>

                            <div className="rel-row-actions">
                              <button
                                className="btn"
                                style={{ fontSize: 12, padding: '5px 10px' }}
                                onClick={() => handleOpenPeek(item.term.id)}
                              >
                                查看
                              </button>
                              <button
                                className="btn"
                                style={{ fontSize: 12, padding: '5px 10px' }}
                                onClick={() => handleStartCompare(item.term.id)}
                              >
                                对比
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
