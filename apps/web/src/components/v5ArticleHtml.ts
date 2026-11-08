import { marked } from 'marked';
import mermaid from 'mermaid';
import panzoom, { type PanZoom } from 'panzoom';
import type { TermEntry } from '@glossa/schema';

/**
 * 过滤 DeepSeek V3.2 内部工具调用标记（如 <｜DSML｜calls>...），防止内部 XML 泄露至前端气泡
 */
export function stripDsmlMarkup(text: string): string {
  return String(text || '')
    .replace(
      /<(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+(?:function_)?calls>[\s\S]*?<\/(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+(?:function_)?calls>/gi,
      ''
    )
    .replace(
      /<(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+invoke\b[^>]*>[\s\S]*?<\/(?:\s*[｜|]\s*)+DSML(?:\s*[｜|]\s*)+invoke>/gi,
      ''
    )
    .replace(/<\/?(?:\s*[｜|]\s*)+DSML[^>]*>/gi, '')
    .replace(/<(?:\s*[｜|]\s*)+DSML[\s\S]*$/gi, '')
    .trim();
}

export function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface KeywordMatcher {
  word: string;
  id: string;
}

export function buildKeywordMatchers(terms: TermEntry[]): KeywordMatcher[] {
  const entries: KeywordMatcher[] = [];
  for (const t of terms) {
    entries.push({ word: t.title, id: t.id });
    for (const a of t.aliases || []) {
      if (a && a.length >= 2) entries.push({ word: a, id: t.id });
    }
  }
  entries.sort((a, b) => b.word.length - a.word.length);
  return entries;
}

export function autoLinkHtml(
  rawText: string,
  excludeTermId: string,
  matchers: Array<{ word: string; id: string }>
): string {
  const safe = escapeHtml(rawText);
  const placeholders: string[] = [];
  let working = safe;

  for (const item of matchers) {
    if (item.id === excludeTermId) continue;
    const escapedWord = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reg = new RegExp(escapedWord, 'g');
    working = working.replace(reg, (match) => {
      const token = `__GLOSSA_LINK_${placeholders.length}__`;
      placeholders.push(`<span class="term-link" data-term-id="${item.id}">${match}</span>`);
      return token;
    });
  }

  placeholders.forEach((html, idx) => {
    working = working.replace(`__GLOSSA_LINK_${idx}__`, html);
  });
  return working;
}

let mermaidInitialized = false;
let mermaidRenderSeq = 0;
const panzoomInstanceMap = new WeakMap<HTMLElement, PanZoom>();

function ensureMermaidInitialized() {
  if (mermaidInitialized || typeof window === 'undefined') return;
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    securityLevel: 'strict',
    theme: 'base',
    flowchart: {
      htmlLabels: false,
      curve: 'basis',
      padding: 16,
      nodeSpacing: 40,
      rankSpacing: 48,
      useMaxWidth: false,
    },
    themeVariables: {
      primaryColor: '#EFF6FF',
      primaryTextColor: '#1E3A8A',
      primaryBorderColor: '#2457F5',
      lineColor: '#64748B',
      secondaryColor: '#F8FAFC',
      tertiaryColor: '#ECFDF5',
      fontFamily:
        'Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: '13px',
    },
  });
  mermaidInitialized = true;
}

/**
 * 将 ```mermaid 流程图源码包裹为标准 Mermaid + Panzoom 交互式画布容器
 * 实际 SVG 渲染与拖拽缩放由 hydrateMermaidDiagrams 使用官方 mermaid + panzoom 库完成
 */
export function compileMermaidToSvg(
  mermaidCode: string,
  _matchers: Array<{ word: string; id: string }>,
  customTitle?: string
): string {
  const cleanCode = String(mermaidCode || '').trim();
  const lines = cleanCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));

  const firstLine = lines[0] || 'flowchart TD';
  if (lines.length === 0) {
    return `<pre class="code-block">${escapeHtml(mermaidCode)}</pre>`;
  }

  const encoded = encodeURIComponent(cleanCode);
  const titleText = customTitle || '业务流程图';

  return [
    `<div class="mermaid-box" data-mermaid-code="${escapeHtml(encoded)}" data-mermaid-title="${escapeHtml(titleText)}">`,
    `<div class="mermaid-caption">`,
    `<span><strong>${escapeHtml(titleText)}</strong></span>`,
    `</div>`,
    `<div class="mermaid-viewport">`,
    `<div class="mermaid-panzoom-scene">`,
    `<pre class="code-block" style="margin:12px;opacity:0.65">${escapeHtml(cleanCode)}</pre>`,
    `</div>`,
    `</div>`,
    `</div>`,
  ].join('');
}

/**
 * 当大模型输出的 Mermaid 节点文本包含未加双引号的括号 ()、斜杠 / 等特殊字符导致严格解析失败时，
 * 自动为节点标签与边标签补齐安全双引号后重试渲染
 */
function sanitizeMermaidCodeForFallback(raw: string): string {
  return String(raw || '')
    .replace(/(\b[A-Za-z0-9_]+)\[(?![/"\\])([^\]"\n]+)\]/g, (_m, id: string, label: string) => {
      return `${id}["${label.replace(/"/g, "'").trim()}"]`;
    })
    .replace(/(\b[A-Za-z0-9_]+)\{(?![{"])([^}"\n]+)\}/g, (_m, id: string, label: string) => {
      return `${id}{"${label.replace(/"/g, "'").trim()}"}`;
    })
    .replace(/-->\|([^|"\n]+)\|/g, (_m, label: string) => {
      return `-->|"${label.replace(/"/g, "'").trim()}"|`;
    });
}

/**
 * 使用官方 mermaid 库 + panzoom 库，将容器内所有 .mermaid-box 渲染为可拖拽、自适应居中、支持 Ctrl/⌘+滚轮缩放与右下角控制盘的交互图
 */
export async function hydrateMermaidDiagrams(
  rootEl: HTMLElement | null,
  matchers: Array<{ word: string; id: string }>,
  onOpenFullscreen?: (mermaidCode: string, title: string) => void
): Promise<void> {
  if (!rootEl || typeof window === 'undefined') return;
  ensureMermaidInitialized();

  const boxes = Array.from(rootEl.querySelectorAll<HTMLElement>('.mermaid-box[data-mermaid-code]'));
  for (const box of boxes) {
    const encoded = box.getAttribute('data-mermaid-code') || '';
    if (!encoded) continue;

    const sceneEl = box.querySelector<HTMLElement>('.mermaid-panzoom-scene');
    const viewportEl = box.querySelector<HTMLElement>('.mermaid-viewport');
    if (!sceneEl || !viewportEl) continue;

    const alreadyHydrated =
      box.getAttribute('data-hydrated-code') === encoded && Boolean(sceneEl.querySelector('svg'));
    if (alreadyHydrated) {
      continue;
    }

    let mermaidCode = '';
    try {
      mermaidCode = decodeURIComponent(encoded);
    } catch {
      mermaidCode = encoded;
    }

    const renderId = `glossa-mmd-${Date.now()}-${++mermaidRenderSeq}`;
    try {
      let svg = '';
      try {
        const rendered = await mermaid.render(renderId, mermaidCode);
        svg = rendered.svg;
      } catch (firstErr) {
        const strayFirst = document.getElementById(`d${renderId}`);
        if (strayFirst) strayFirst.remove();
        const fallbackCode = sanitizeMermaidCodeForFallback(mermaidCode);
        if (fallbackCode !== mermaidCode) {
          const retryId = `glossa-mmd-${Date.now()}-${++mermaidRenderSeq}`;
          try {
            const retried = await mermaid.render(retryId, fallbackCode);
            svg = retried.svg;
            mermaidCode = fallbackCode;
          } catch (retryErr) {
            const strayRetry = document.getElementById(`d${retryId}`);
            if (strayRetry) strayRetry.remove();
            throw retryErr;
          }
        } else {
          throw firstErr;
        }
      }
      if (!box.isConnected) continue;

      // 清理已有 panzoom 实例
      const prevPz = panzoomInstanceMap.get(sceneEl);
      if (prevPz) {
        try {
          prevPz.dispose();
        } catch {
          // ignore
        }
      }

      sceneEl.innerHTML = svg;
      box.setAttribute('data-hydrated-code', encoded);

      const svgEl = sceneEl.querySelector('svg');
      if (!svgEl) continue;

      // 解析 SVG 原始几何尺寸（优先取 viewBox，兜底 getBBox），用于自适应缩放并居中
      let natW = 720;
      let natH = 320;
      const vb = svgEl.getAttribute('viewBox');
      if (vb) {
        const parts = vb
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          natW = parts[2];
          natH = parts[3];
        }
      } else {
        try {
          const bbox = svgEl.getBBox();
          if (bbox.width > 0 && bbox.height > 0) {
            natW = bbox.width;
            natH = bbox.height;
          }
        } catch {
          // ignore
        }
      }

      const isFullscreenModal = Boolean(box.closest('.mermaid-fullscreen-modal'));
      if (!isFullscreenModal) {
        const idealVpH = Math.max(240, Math.min(440, Math.round(natH + 44)));
        viewportEl.style.height = `${idealVpH}px`;
      }

      sceneEl.style.width = `${Math.ceil(natW)}px`;
      sceneEl.style.height = `${Math.ceil(natH)}px`;
      sceneEl.style.minHeight = '0';
      sceneEl.style.padding = '0';
      sceneEl.style.display = 'block';

      svgEl.style.maxWidth = 'none';
      svgEl.style.width = `${Math.ceil(natW)}px`;
      svgEl.style.height = `${Math.ceil(natH)}px`;
      svgEl.style.display = 'block';

      // 自动识别节点文本中的词条并注入 data-peek-term 与高亮描边
      const nodeGroups = svgEl.querySelectorAll<SVGGElement>(
        'g.node, g.actor, g.statediagram-state'
      );
      nodeGroups.forEach((g) => {
        const text = (g.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        for (const m of matchers) {
          if (text.includes(m.word)) {
            g.setAttribute('data-peek-term', m.id);
            g.style.cursor = 'pointer';
            const shape = g.querySelector<SVGElement>('rect, polygon, path, circle');
            if (shape) {
              shape.style.stroke = '#2457F5';
              shape.style.strokeWidth = '2.2px';
            }
            break;
          }
        }
      });

      // 挂载第三方 panzoom 引擎（正文内普通滚轮放行给页面滚动，按住 Ctrl/⌘+滚轮或全屏模式下直接滚轮缩放）
      const pz = panzoom(sceneEl, {
        maxZoom: 4,
        minZoom: 0.15,
        bounds: false,
        zoomDoubleClickSpeed: 1,
        beforeWheel: (e: WheelEvent) => {
          if (isFullscreenModal) return false;
          return !(e.ctrlKey || e.metaKey);
        },
        beforeMouseDown: (e: MouseEvent) => {
          const target = e.target as HTMLElement | null;
          return Boolean(target?.closest('.mermaid-floating-controls'));
        },
      });
      panzoomInstanceMap.set(sceneEl, pz);

      const fitAndCenter = () => {
        const vpW = viewportEl.clientWidth || 680;
        const vpH = viewportEl.clientHeight || 320;
        const pad = isFullscreenModal ? 48 : 28;
        const scaleX = Math.max(80, vpW - pad) / Math.max(1, natW);
        const scaleY = Math.max(80, vpH - pad) / Math.max(1, natH);
        const maxInitialScale = isFullscreenModal ? 1.35 : 1.05;
        const fitScale = Math.max(0.16, Math.min(scaleX, scaleY, maxInitialScale));
        const tx = Math.round((vpW - natW * fitScale) / 2);
        const ty = Math.round((vpH - natH * fitScale) / 2);
        pz.zoomAbs(0, 0, fitScale);
        pz.moveTo(tx, ty);
      };

      // 注入右下角悬浮控制盘
      let controlsEl = viewportEl.querySelector<HTMLElement>('.mermaid-floating-controls');
      if (!controlsEl) {
        controlsEl = document.createElement('div');
        controlsEl.className = 'mermaid-floating-controls';
        controlsEl.innerHTML = `
          <div class="mermaid-dpad">
            <button type="button" class="mmd-icon-btn" data-mmd-cmd="pan-up" title="向上平移">↑</button>
            <div class="mermaid-dpad-mid">
              <button type="button" class="mmd-icon-btn" data-mmd-cmd="pan-left" title="向左平移">←</button>
              <button type="button" class="mmd-icon-btn mmd-reset-btn" data-mmd-cmd="reset" title="适应窗口并居中">⟲</button>
              <button type="button" class="mmd-icon-btn" data-mmd-cmd="pan-right" title="向右平移">→</button>
            </div>
            <button type="button" class="mmd-icon-btn" data-mmd-cmd="pan-down" title="向下平移">↓</button>
          </div>
          <div class="mermaid-zoom-bar">
            <button type="button" class="mmd-icon-btn" data-mmd-cmd="zoom-in" title="放大 (或 Ctrl/⌘ + 滚轮)">＋</button>
            <span class="mmd-zoom-badge" data-mmd-cmd="reset" style="cursor:pointer" title="点击适应窗口并居中">100%</span>
            <button type="button" class="mmd-icon-btn" data-mmd-cmd="zoom-out" title="缩小 (或 Ctrl/⌘ + 滚轮)">－</button>
            <button type="button" class="mmd-icon-btn" data-mmd-cmd="fullscreen" title="全屏交互查看">⛶</button>
          </div>
        `;
        viewportEl.appendChild(controlsEl);
      }

      const zoomBadge = controlsEl.querySelector<HTMLElement>('.mmd-zoom-badge');
      pz.on('transform', () => {
        if (zoomBadge) {
          const t = pz.getTransform();
          zoomBadge.textContent = `${Math.round((t.scale || 1) * 100)}%`;
        }
      });

      // 首次渲染自动执行适应窗口并居中
      fitAndCenter();

      controlsEl.onclick = (ev: MouseEvent) => {
        ev.stopPropagation();
        const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-mmd-cmd]');
        if (!btn) return;
        const cmd = btn.getAttribute('data-mmd-cmd');
        const rect = viewportEl.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;

        if (cmd === 'zoom-in') {
          pz.smoothZoom(cx, cy, 1.25);
        } else if (cmd === 'zoom-out') {
          pz.smoothZoom(cx, cy, 0.8);
        } else if (cmd === 'reset') {
          fitAndCenter();
        } else if (cmd === 'pan-up') {
          pz.moveBy(0, 60, true);
        } else if (cmd === 'pan-down') {
          pz.moveBy(0, -60, true);
        } else if (cmd === 'pan-left') {
          pz.moveBy(60, 0, true);
        } else if (cmd === 'pan-right') {
          pz.moveBy(-60, 0, true);
        } else if (cmd === 'fullscreen' && onOpenFullscreen) {
          const title = box.getAttribute('data-mermaid-title') || 'Mermaid 交互式流程图';
          onOpenFullscreen(mermaidCode, title);
        }
      };
    } catch {
      // 流式输出尚未闭合或语法不完整时保留原文代码块展示
      const strayErr = document.getElementById(`d${renderId}`);
      if (strayErr) strayErr.remove();
    }
  }
}

/**
 * 行内 Markdown 格式化：先保护 `code` 不被双链切碎，再执行双链注入与 **加粗** / *斜体* 转换
 */
function formatInlineMarkdown(
  rawText: string,
  excludeTermId: string,
  matchers: Array<{ word: string; id: string }>
): string {
  const codeSpans: string[] = [];
  const withoutCode = String(rawText || '').replace(/`([^`]+)`/g, (_, codeContent) => {
    const token = `__GLOSSA_INLINECODE_${codeSpans.length}__`;
    codeSpans.push(`<code>${escapeHtml(codeContent)}</code>`);
    return token;
  });

  let linked = autoLinkHtml(withoutCode, excludeTermId, matchers)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  codeSpans.forEach((html, idx) => {
    linked = linked.replace(`__GLOSSA_INLINECODE_${idx}__`, html);
  });
  return linked;
}

/**
 * 将纯 Markdown 正文动态编译为支持双链 + 表格 + Mermaid 图的 V5 卡片或紧凑聊天气泡 HTML
 */
function renderMarkdownToHtml(
  md: string,
  termId: string,
  matchers: Array<{ word: string; id: string }>,
  mode: 'article' | 'chat' = 'article'
): string {
  const link = (text: string) => formatInlineMarkdown(text, termId, matchers);
  const isChat = mode === 'chat';

  const lines = String(md || '').split('\n');
  const out: string[] = [
    isChat ? '<div class="chat-md">' : '<div class="layer-card rich-article">',
  ];
  let inTable = false;
  let tableHeaderDone = false;
  let inUl = false;
  let inOl = false;
  let inCodeFence = false;
  let codeFenceLang = '';
  let codeFenceTitle = '';
  let codeFenceLines: string[] = [];
  let hasContentInCurrentCard = false;

  const closeOpenBlocks = () => {
    if (inTable) {
      out.push('</tbody></table></div>');
      inTable = false;
      tableHeaderDone = false;
    }
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      closeOpenBlocks();
      if (!inCodeFence) {
        inCodeFence = true;
        const fenceInfo = trimmed.slice(3).trim();
        const firstSpace = fenceInfo.indexOf(' ');
        codeFenceLang = (firstSpace === -1 ? fenceInfo : fenceInfo.slice(0, firstSpace)).toLowerCase();
        codeFenceTitle = firstSpace === -1 ? '' : fenceInfo.slice(firstSpace + 1).trim();
        codeFenceLines = [];
      } else {
        inCodeFence = false;
        const blockContent = codeFenceLines.join('\n');
        if (codeFenceLang === 'mermaid') {
          out.push(compileMermaidToSvg(blockContent, matchers, codeFenceTitle || undefined));
        } else {
          out.push(`<div class="code-block">${escapeHtml(blockContent)}</div>`);
        }
        hasContentInCurrentCard = true;
      }
      continue;
    }

    if (inCodeFence) {
      codeFenceLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      closeOpenBlocks();
      continue;
    }

    if (trimmed === '---' || trimmed === '***') {
      closeOpenBlocks();
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }
      if (!inTable) {
        out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>');
        for (const c of cells) out.push(`<th>${link(c)}</th>`);
        out.push('</tr></thead><tbody>');
        inTable = true;
        tableHeaderDone = true;
      } else if (tableHeaderDone) {
        out.push('<tr>');
        for (const c of cells) out.push(`<td>${link(c)}</td>`);
        out.push('</tr>');
      }
      hasContentInCurrentCard = true;
      continue;
    }

    closeOpenBlocks();

    if (trimmed.startsWith('#### ')) {
      out.push(`<h4>${link(trimmed.slice(5))}</h4>`);
      hasContentInCurrentCard = true;
    } else if (trimmed.startsWith('### ')) {
      out.push(`<h3>${link(trimmed.slice(4))}</h3>`);
      hasContentInCurrentCard = true;
    } else if (trimmed.startsWith('## ')) {
      if (!isChat && hasContentInCurrentCard) {
        out.push('</div><div class="layer-card rich-article">');
      }
      out.push(isChat ? `<h3>${link(trimmed.slice(3))}</h3>` : `<h2>${link(trimmed.slice(3))}</h2>`);
      hasContentInCurrentCard = true;
    } else if (trimmed.startsWith('# ')) {
      out.push(isChat ? `<h3>${link(trimmed.slice(2))}</h3>` : `<h2>${link(trimmed.slice(2))}</h2>`);
      hasContentInCurrentCard = true;
    } else if (trimmed.startsWith('> ')) {
      out.push(`<blockquote class="md-blockquote">${link(trimmed.slice(2))}</blockquote>`);
      hasContentInCurrentCard = true;
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inUl) {
        out.push(isChat ? '<ul class="chat-md-list">' : '<ul style="padding-left:20px;margin:8px 0;">');
        inUl = true;
      }
      out.push(`<li>${link(trimmed.slice(2))}</li>`);
      hasContentInCurrentCard = true;
    } else if (/^\d+\.\s+/.test(trimmed)) {
      if (!inOl) {
        out.push(isChat ? '<ol class="chat-md-list">' : '<ol style="padding-left:20px;margin:8px 0;">');
        inOl = true;
      }
      out.push(`<li>${link(trimmed.replace(/^\d+\.\s+/, ''))}</li>`);
      hasContentInCurrentCard = true;
    } else {
      out.push(`<p>${link(trimmed)}</p>`);
      hasContentInCurrentCard = true;
    }
  }

  if (inCodeFence && codeFenceLines.length > 0) {
    out.push(`<div class="code-block">${escapeHtml(codeFenceLines.join('\n'))}</div>`);
  }
  closeOpenBlocks();
  out.push('</div>');
  return out.join('\n');
}

/**
 * 专门用于 AI 伴读会话气泡与 FAQ 的第三方 GFM Markdown 渲染器（基于 marked + 交互式 Mermaid SVG + XSS 净化 + 领域词自动双链）
 */
export function renderChatMarkdownHtml(
  md: string,
  matchers: Array<{ word: string; id: string }>,
  excludeTermId = ''
): string {
  const cleaned = stripDsmlMarkup(md);
  if (!cleaned) {
    return '<div class="chat-md"></div>';
  }

  // 1. 先将 ```mermaid 块抽离并编译为可点击 SVG 流程图占位符
  const mermaidBlocks: string[] = [];
  const withoutMermaid = cleaned.replace(/```mermaid\s*\n([\s\S]*?)```/gi, (_, code) => {
    const token = `GLOSSAMERMAIDBLOCK${mermaidBlocks.length}END`;
    mermaidBlocks.push(compileMermaidToSvg(code, matchers));
    return `\n\n${token}\n\n`;
  });

  // 2. 使用成熟的第三方 marked 引擎将 GFM Markdown 编译为标准 HTML
  const rawHtml = marked.parse(withoutMermaid, {
    gfm: true,
    breaks: true,
    async: false,
  }) as string;

  // 3. 适配工作台样式类名（代码块、表格横向滚动容器、引用块、列表）并还原 Mermaid SVG
  let styledHtml = rawHtml
    .replace(/<pre><code(?:\s+class="[^"]*")?>([\s\S]*?)<\/code><\/pre>/gi, '<div class="code-block">$1</div>')
    .replace(/<table>/gi, '<div class="md-table-wrap"><table class="md-table">')
    .replace(/<\/table>/gi, '</table></div>')
    .replace(/<blockquote>/gi, '<blockquote class="md-blockquote">')
    .replace(/<ul>/gi, '<ul class="chat-md-list">')
    .replace(/<ol>/gi, '<ol class="chat-md-list">');

  mermaidBlocks.forEach((svgHtml, idx) => {
    styledHtml = styledHtml
      .replace(`<p>GLOSSAMERMAIDBLOCK${idx}END</p>`, svgHtml)
      .replace(`GLOSSAMERMAIDBLOCK${idx}END`, svgHtml);
  });

  // 4. 严格白名单 XSS 净化 + 在非代码/非 SVG 的纯文本节点上自动注入 .term-link 领域词双链
  const sanitized = sanitizeRichHtml(`<div class="chat-md">${styledHtml}</div>`);
  return enrichSanitizedHtmlWithDynamicLinks(sanitized, excludeTermId, matchers);
}

const ALLOWED_RICH_TAGS = new Set([
  'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'del', 'hr', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'svg', 'defs', 'marker', 'path', 'rect', 'text', 'line', 'g',
]);

const ALLOWED_RICH_ATTRS = new Set([
  'class', 'data-term-id', 'data-peek-term', 'data-code-key', 'data-mermaid-code', 'data-mermaid-title', 'style', 'id',
  'viewbox', 'refx', 'refy', 'markerwidth', 'markerheight', 'orient', 'd', 'fill',
  'x', 'y', 'width', 'height', 'rx', 'text-anchor', 'font-size', 'font-weight',
  'x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'marker-end', 'stroke-dasharray',
]);

const ATTR_CASED_NAMES: Record<string, string> = {
  viewbox: 'viewBox',
  refx: 'refX',
  refy: 'refY',
  markerwidth: 'markerWidth',
  markerheight: 'markerHeight',
};

export function sanitizeRichHtml(rawHtml: string): string {
  const normalized = String(rawHtml || '').replace(
    /<a\s+class="term-link"\s+data-term="([^"]+)">([^<]+)<\/a>/g,
    '<span class="term-link" data-term-id="$1">$2</span>'
  );

  // Strip dangerous script/style/iframe/object blocks completely
  const withoutDangerousBlocks = normalized.replace(
    /<(script|iframe|object|embed|style|foreignObject)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ''
  );

  return withoutDangerousBlocks.replace(/<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g, (fullMatch, slash, rawTagName, rawAttrs) => {
    const lowerTag = String(rawTagName).toLowerCase();
    if (!ALLOWED_RICH_TAGS.has(lowerTag)) {
      return escapeHtml(fullMatch);
    }

    if (slash) {
      return `</${lowerTag}>`;
    }

    const cleanAttrs: string[] = [];
    const attrRegex = /([a-zA-Z0-9-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(String(rawAttrs || ''))) !== null) {
      const attrNameLower = match[1].toLowerCase();
      if (attrNameLower.startsWith('on') || !ALLOWED_RICH_ATTRS.has(attrNameLower)) {
        continue;
      }
      const rawVal = (match[2] ?? match[3] ?? match[4] ?? '').trim();
      if (/(?:javascript|vbscript|data)\s*:|expression\s*\(|url\s*\(/i.test(rawVal)) {
        continue;
      }
      const safeVal = escapeHtml(rawVal).replace(/"/g, '&quot;');
      const finalAttrName = ATTR_CASED_NAMES[attrNameLower] || attrNameLower;
      cleanAttrs.push(`${finalAttrName}="${safeVal}"`);
    }

    const selfClosing = /\/\s*$/.test(String(rawAttrs || '')) || lowerTag === 'br';
    const attrStr = cleanAttrs.length > 0 ? ` ${cleanAttrs.join(' ')}` : '';
    return `<${lowerTag}${attrStr}${selfClosing && lowerTag !== 'div' && lowerTag !== 'span' ? ' /' : ''}>`;
  });
}

/**
 * 在已净化的富文本 HTML 中，对非 SVG / 非 code / 非既有双链 的纯文本节点动态注入新词条双链
 */
function enrichSanitizedHtmlWithDynamicLinks(
  sanitizedHtml: string,
  excludeTermId: string,
  matchers: Array<{ word: string; id: string }>
): string {
  if (!matchers.length) return sanitizedHtml;
  const protectedBlocks: string[] = [];
  const working = sanitizedHtml.replace(
    /(<svg[\s\S]*?<\/svg>|<div class="code-block">[\s\S]*?<\/div>|<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<span class="term-link"[\s\S]*?<\/span>|<[^>]+>)/gi,
    (m) => {
      const token = `__GLOSSA_TAG_${protectedBlocks.length}__`;
      protectedBlocks.push(m);
      return token;
    }
  );

  let linked = working;
  const linkTokens: string[] = [];
  for (const item of matchers) {
    if (item.id === excludeTermId) continue;
    const escapedWord = escapeHtml(item.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedWord) continue;
    const reg = new RegExp(escapedWord, 'g');
    linked = linked.replace(reg, (match) => {
      const token = `__GLOSSA_DYNLINK_${linkTokens.length}__`;
      linkTokens.push(`<span class="term-link" data-term-id="${item.id}">${match}</span>`);
      return token;
    });
  }

  linkTokens.forEach((html, idx) => {
    linked = linked.replace(`__GLOSSA_DYNLINK_${idx}__`, html);
  });
  protectedBlocks.forEach((block, idx) => {
    linked = linked.replace(`__GLOSSA_TAG_${idx}__`, block);
  });
  return linked;
}

/**
 * 统一动态正文渲染器（零硬编码词条内容 + 严格白名单防 XSS 净化 + 全站新词动态双链）
 */
export function renderV5BespokeArticleHtml(
  term: TermEntry,
  matchers: Array<{ word: string; id: string }>
): string {
  const raw = String(term.articleMarkdown || '').trim();
  if (!raw) {
    return `<div class="layer-card rich-article"><p>${autoLinkHtml(term.summary || '', term.id, matchers)}</p></div>`;
  }

  if (raw.startsWith('<div') || raw.includes('class="layer-card')) {
    const withMermaid = raw.replace(
      /```mermaid(?:\s+([^\n]+))?\s*\n([\s\S]*?)```/gi,
      (_, customTitle, code) => compileMermaidToSvg(code, matchers, customTitle?.trim())
    );
    return enrichSanitizedHtmlWithDynamicLinks(sanitizeRichHtml(withMermaid), term.id, matchers);
  }

  return renderMarkdownToHtml(raw, term.id, matchers);
}
