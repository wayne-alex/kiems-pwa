// Small, safe markdown → HTML renderer for guides.
// Supports: # headings, paragraphs, **bold**, *italic*, `code`, fenced code,
// links, images, bullet/numbered lists (nested, loose, tasks), blockquotes,
// callouts (> **Tip:** ...), tables and horizontal rules.
// All text is escaped. Only tags generated in this file are ever output.

const WORDS = 'tip|note|info|warning|caution|important|danger';
const CALLOUTS = {
  tip: ['tip', 'Tip'],
  note: ['info', 'Note'],
  info: ['info', 'Info'],
  warning: ['warn', 'Warning'],
  caution: ['warn', 'Caution'],
  important: ['danger', 'Important'],
  danger: ['danger', 'Danger'],
};
const CALLOUT_RE = new RegExp(`^\\s*(?:\\*\\*(${WORDS}):?\\*\\*:?|(${WORDS}):)\\s*(.*)$`, 'i');
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PH = '\uE000';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(u) {
  const url = String(u).trim();
  if (/^(https?:|mailto:|tel:)/i.test(url) || url.startsWith('/') || url.startsWith('#')) return url;
  return null;
}

function emph(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>');
}

function inline(text) {
  const stash = [];
  const hold = (html) => {
    stash.push(html);
    return `${PH}${stash.length - 1}${PH}`;
  };

  let s = escapeHtml(text);

  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`));

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = safeUrl(url);
    if (!u || !/^(https?:|\/)/i.test(u)) return alt;
    return hold(`<img src="${u}" alt="${alt}" loading="lazy" />`);
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url);
    if (!u) return label;
    const ext = /^https?:/i.test(u) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return hold(`<a href="${u}"${ext}>${emph(label)}</a>`);
  });

  s = emph(s);

  const back = new RegExp(`${PH}(\\d+)${PH}`, 'g');
  for (let n = 0; n < 3 && back.test(s); n++) {
    back.lastIndex = 0;
    s = s.replace(back, (_, i) => stash[+i]);
  }
  return s;
}

// ── Blocks ─────────────────────────────────────────────────

function heading(m, ctx) {
  const level = Math.max(2, m[1].length); // the page title is the h1
  const plain = m[2]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
  const base = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  let id = `sec-${base}`;
  let n = 2;
  while (ctx.used.has(id)) id = `sec-${base}-${n++}`;
  ctx.used.add(id);
  if (!ctx.nested && level === 2) ctx.toc.push({ id, text: plain });
  return `<h${level} id="${id}">${inline(m[2].trim())}</h${level}>`;
}

function figure(line) {
  const m = line.match(/!\[([^\]]*)\]\(([^)\s]+)\)/);
  if (!m) return '';
  const u = safeUrl(m[2]);
  if (!u || !/^(https?:|\/)/i.test(u)) return '';
  const alt = escapeHtml(m[1]);
  return `<figure><img src="${escapeHtml(u)}" alt="${alt}" loading="lazy" />${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`;
}

function splitRow(r) {
  let s = r.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function table(lines, i) {
  const head = splitRow(lines[i]);
  i += 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
  const tb = rows
    .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return {
    html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`,
    next: i,
  };
}

function quote(lines, i, ctx) {
  const buf = [];
  while (i < lines.length && /^\s*>/.test(lines[i])) {
    buf.push(lines[i].replace(/^\s*>\s?/, ''));
    i++;
  }
  const inner = { ...ctx, nested: true };
  const first = buf.findIndex((l) => l.trim());
  const m = first >= 0 ? buf[first].match(CALLOUT_RE) : null;

  if (m) {
    const [cls, label] = CALLOUTS[(m[1] || m[2]).toLowerCase()];
    const rest = (m[3] || '').trim();
    const body = buf.slice();
    if (rest) body[first] = rest;
    else body.splice(first, 1);
    return {
      html: `<div class="callout ${cls}"><div class="callout-title">${label}</div><div class="callout-body">${parse(body, inner)}</div></div>`,
      next: i,
    };
  }
  return { html: `<blockquote>${parse(buf, inner)}</blockquote>`, next: i };
}

function itemInner(text) {
  const t = text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
  const body = (t ? t[2] : text).split('\n').map(inline).join('<br/>');
  if (t) {
    return {
      cls: ` class="task${t[1] === ' ' ? '' : ' done'}"`,
      html: `<span class="box" aria-hidden="true"></span><span>${body}</span>`,
    };
  }
  return { cls: '', html: body };
}

function buildList(items) {
  let pos = 0;
  const level = (base) => {
    const first = items[pos];
    const tag = first.ordered ? 'ol' : 'ul';
    const style = first.ordered && first.num > 1 ? ` style="counter-reset: step ${first.num - 1}"` : '';
    let html = `<${tag}${style}>`;
    while (pos < items.length && items[pos].indent >= base) {
      const it = items[pos++];
      const inner = itemInner(it.text);
      let nested = '';
      if (pos < items.length && items[pos].indent > it.indent) nested = level(items[pos].indent);
      html += `<li${inner.cls}>${inner.html}${nested}</li>`;
    }
    return `${html}</${tag}>`;
  };
  return level(items[0].indent);
}

function list(lines, i) {
  const items = [];
  while (i < lines.length) {
    if (!lines[i].trim()) {
      // allow blank lines between items (loose lists)
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (items.length && j < lines.length && LIST_RE.test(lines[j]) && !HR_RE.test(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    const m = lines[i].match(LIST_RE);
    if (m && !HR_RE.test(lines[i])) {
      items.push({
        indent: m[1].replace(/\t/g, '    ').length,
        ordered: /^\d/.test(m[2]),
        num: parseInt(m[2], 10) || 1,
        text: m[3],
      });
      i++;
    } else if (items.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) {
      items[items.length - 1].text += '\n' + lines[i].trim();
      i++;
    } else break;
  }
  return { html: buildList(items), next: i };
}

function startsBlock(line, next) {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    HR_RE.test(line) ||
    LIST_RE.test(line) ||
    /^\s*>/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

function parse(lines, ctx) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(heading(h, ctx)); i++; continue; }

    if (HR_RE.test(line)) { out.push('<hr/>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      const r = quote(lines, i, ctx);
      out.push(r.html);
      i = r.next;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const r = table(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const r = list(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }

    if (/^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line)) {
      out.push(figure(line));
      i++;
      continue;
    }

    // Paragraph: contiguous non-blank lines
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push(`<p>${para.map(inline).join('<br/>')}</p>`);
  }

  return out.join('\n');
}

// ── Public ─────────────────────────────────────────────────

export function renderMarkdownWithToc(md) {
  if (!md) return { html: '', toc: [] };
  const ctx = { toc: [], used: new Set(), nested: false };
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const html = parse(lines, ctx);
  return { html, toc: ctx.toc };
}

export function renderMarkdown(md) {
  return renderMarkdownWithToc(md).html;
}