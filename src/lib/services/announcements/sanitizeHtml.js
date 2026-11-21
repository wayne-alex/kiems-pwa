//
// Minimal HTML sanitizer for rendering IEBC article body_html.
// Whitelist-only: allow a small set of text/formatting tags,
// strip everything else. Never allow <script>, <iframe>, event
// handlers, or javascript: URLs.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'blockquote', 'ul', 'ol', 'li',
  'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'a', 'hr', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
]);

const ALLOWED_ATTRS = {
  img: ['src', 'alt', 'title'],
  a: ['href', 'title'],
  '*': [],
};

export function sanitizeHtml(html) {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild;
  if (!root) return '';

  walk(root);
  return root.innerHTML;
}

function walk(node) {
  // Walk children in reverse so removal doesn't skip siblings
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap: keep the text, drop the element
        const frag = document.createDocumentFragment();
        while (child.firstChild) frag.appendChild(child.firstChild);
        child.replaceWith(frag);
        // Re-walk the newly inserted children
        walk(node);
        continue;
      }
      // Strip disallowed attributes
      for (const attr of [...child.attributes]) {
        const allowed = ALLOWED_ATTRS[tag] || ALLOWED_ATTRS['*'];
        if (!allowed.includes(attr.name)) {
          child.removeAttribute(attr.name);
        }
      }
      // Block javascript: URLs
      if (tag === 'a' && child.hasAttribute('href')) {
        const href = child.getAttribute('href').trim();
        if (/^javascript:/i.test(href)) child.setAttribute('href', '#');
        // Force external links to open safely
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'img' && child.hasAttribute('src')) {
        const src = child.getAttribute('src').trim();
        if (!/^https?:\/\//i.test(src) && !src.startsWith('data:image/')) {
          child.remove();
          continue;
        }
      }
      walk(child);
    } else if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
    }
  }
}