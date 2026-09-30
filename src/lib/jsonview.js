// Chrome-like collapsible JSON tree with lazy children, search highlighting and per-node copy.

export class EmbeddedJson {
  constructor(value, raw) {
    this.value = value;
    this.raw = raw;
  }
}

export function parseJsonString(str) {
  if (typeof str !== 'string' || str.length < 2) return undefined;
  const t = str.trim();
  if (!((t[0] === '{' && t[t.length - 1] === '}') || (t[0] === '[' && t[t.length - 1] === ']'))) return undefined;
  try {
    return JSON.parse(t);
  } catch (_) {
    return undefined;
  }
}

// Strings that contain JSON become EmbeddedJson nodes so the tree can open them.
export function expandEmbeddedJson(value, depth = 0) {
  if (depth > 64) return value;
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed === undefined ? value : new EmbeddedJson(expandEmbeddedJson(parsed, depth + 1), value);
  }
  if (Array.isArray(value)) return value.map((v) => expandEmbeddedJson(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = expandEmbeddedJson(value[k], depth + 1);
    return out;
  }
  return value;
}

// Plain JSON again, with embedded JSON kept as objects (pretty) or restored as strings (raw).
export function unwrap(value, keepParsed = true) {
  if (value instanceof EmbeddedJson) return keepParsed ? unwrap(value.value, true) : value.raw;
  if (Array.isArray(value)) return value.map((v) => unwrap(v, keepParsed));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = unwrap(value[k], keepParsed);
    return out;
  }
  return value;
}

const CHUNK = 100;
const SEP = '\u0000';

function kind(v) {
  if (v instanceof EmbeddedJson) return 'embedded';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isContainer(v) {
  const k = kind(v);
  return k === 'array' || k === 'object' || k === 'embedded';
}

function childrenOf(v) {
  if (v instanceof EmbeddedJson) return childrenOf(v.value);
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  return Object.keys(v).map((k) => [k, v[k]]);
}

function inner(v) {
  return v instanceof EmbeddedJson ? v.value : v;
}

function previewOf(v, budget = 90) {
  const x = inner(v);
  if (!isContainer(x)) return scalarText(x);
  const arr = Array.isArray(x);
  const parts = [];
  let len = 0;
  for (const [k, c] of childrenOf(x)) {
    const p = isContainer(inner(c)) ? (Array.isArray(inner(c)) ? `Array(${inner(c).length})` : '{…}') : scalarText(c, 30);
    const s = arr ? p : `${k}: ${p}`;
    len += s.length + 2;
    if (len > budget) {
      parts.push('…');
      break;
    }
    parts.push(s);
  }
  return arr ? `(${x.length}) [${parts.join(', ')}]` : `{${parts.join(', ')}}`;
}

function scalarText(v, max = Infinity) {
  if (typeof v === 'string') {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…"` : s;
  }
  return String(v);
}

// Paths (joined by SEP) that must be open to show every match, plus the matching paths.
function searchPaths(value, q) {
  const open = new Set();
  const hits = new Set();
  let count = 0;
  const walk = (v, path) => {
    if (count > 2000) return false;
    let found = false;
    if (isContainer(inner(v))) {
      for (const [k, c] of childrenOf(v)) {
        const p = path ? path + SEP + k : k;
        const selfHit = k.toLowerCase().includes(q) || (!isContainer(inner(c)) && String(inner(c)).toLowerCase().includes(q));
        if (selfHit) {
          hits.add(p);
          count++;
          found = true;
        }
        if (walk(c, p)) found = true;
      }
      if (found) open.add(path);
    }
    return found;
  };
  walk(value, '');
  return { open, hits, count };
}

function highlight(el, text, q) {
  if (!q) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let i = 0;
  let j;
  while ((j = lower.indexOf(q, i)) >= 0) {
    el.append(document.createTextNode(text.slice(i, j)));
    const m = document.createElement('mark');
    m.textContent = text.slice(j, j + q.length);
    el.append(m);
    i = j + q.length;
  }
  el.append(document.createTextNode(text.slice(i)));
}

/**
 * @param value JSON-ish value (EmbeddedJson allowed)
 * @param opts.expandDepth levels open by default
 * @param opts.search case-insensitive text to highlight and reveal
 * @param opts.onCopy (text) => void
 * @param opts.rootLabel optional label for the root row
 */
export function createJsonView(value, opts = {}) {
  const q = (opts.search || '').toLowerCase();
  const { open: searchOpen, hits, count } = q ? searchPaths(value, q) : { open: new Set(), hits: new Set(), count: 0 };
  const expandDepth = opts.expandDepth ?? 1;
  const root = document.createElement('div');
  root.className = opts.rootLabel == null ? 'jv jv-noroot' : 'jv';
  root.dataset.matches = String(count);

  const renderValue = (span, v) => {
    const k = kind(v);
    span.className = `jv-v jv-${k === 'embedded' ? 'object' : k}`;
    highlight(span, scalarText(v), q);
  };

  const renderEntry = (parentEl, key, v, path, depth, isIndex) => {
    const row = document.createElement('div');
    row.className = 'jv-row';
    row.style.paddingLeft = `${depth * 16 + 16}px`;
    const tog = document.createElement('span');
    tog.className = 'jv-tog';
    row.append(tog);
    if (key !== null) {
      const ks = document.createElement('span');
      ks.className = isIndex ? 'jv-k jv-idx' : 'jv-k';
      highlight(ks, key, q);
      row.append(ks, document.createTextNode(': '));
    }
    if (hits.has(path)) row.classList.add('jv-hit');
    parentEl.append(row);

    const copy = document.createElement('button');
    copy.className = 'jv-copy';
    copy.title = 'Copy value';
    copy.textContent = 'copy';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      const plain = unwrap(v, true);
      opts.onCopy && opts.onCopy(typeof plain === 'string' ? plain : JSON.stringify(plain, null, 2));
    });

    if (!isContainer(inner(v)) && !(v instanceof EmbeddedJson)) {
      const val = document.createElement('span');
      renderValue(val, v);
      row.append(val, copy);
      return;
    }

    row.classList.add('jv-container');
    if (v instanceof EmbeddedJson) {
      const b = document.createElement('span');
      b.className = 'jv-badge';
      b.textContent = 'JSON string';
      b.title = 'This string contains JSON; shown parsed';
      row.append(b);
    }
    const summary = document.createElement('span');
    summary.className = 'jv-sum';
    row.append(summary, copy);

    const box = document.createElement('div');
    box.className = 'jv-children';
    parentEl.append(box);
    let rendered = false;
    let isOpen = false;

    const renderChildren = (deep) => {
      box.innerHTML = '';
      const entries = childrenOf(v);
      const arr = Array.isArray(inner(v));
      let shown = 0;
      const more = () => {
        const next = entries.slice(shown, shown + CHUNK);
        next.forEach(([k, c]) => {
          const p = path ? path + SEP + k : k;
          const child = renderEntry(box, k, c, p, depth + 1, arr);
          if (child && (deep || depth + 1 < expandDepth || searchOpen.has(p))) child(true, deep);
        });
        shown += next.length;
        if (shown < entries.length) {
          const m = document.createElement('div');
          m.className = 'jv-more';
          m.style.paddingLeft = `${(depth + 1) * 16 + 16}px`;
          m.textContent = `Show ${Math.min(CHUNK, entries.length - shown)} more of ${entries.length - shown} remaining…`;
          m.addEventListener('click', () => {
            m.remove();
            more();
          });
          box.append(m);
        }
      };
      more();
      rendered = true;
    };

    const set = (openIt, deep) => {
      isOpen = openIt;
      tog.textContent = isOpen ? '▾' : '▸';
      const x = inner(v);
      summary.textContent = isOpen ? (Array.isArray(x) ? `Array(${x.length})` : '') : previewOf(v);
      if (isOpen && (!rendered || deep)) renderChildren(deep);
      box.hidden = !isOpen;
    };
    // alt+click opens the whole subtree, like Chrome
    row.addEventListener('click', (e) => set(!isOpen, e.altKey && !isOpen));
    set(false);
    return set;
  };

  const top = renderEntry(root, opts.rootLabel ?? null, value, '', 0, false);
  if (top) top(true, expandDepth > 50);
  return root;
}

// Lightweight JSON syntax highlight for the Response tab.
export function highlightJson(text) {
  const frag = document.createDocumentFragment();
  if (text.length > 2_000_000) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const s = document.createElement('span');
    if (m[1]) {
      s.className = m[2] ? 'jv-k' : 'jv-string';
      s.textContent = m[1];
      frag.append(s);
      if (m[2]) frag.append(document.createTextNode(m[2]));
    } else {
      s.className = m[3] ? 'jv-boolean' : m[0] === 'null' ? 'jv-null' : 'jv-number';
      s.textContent = m[0];
      frag.append(s);
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
