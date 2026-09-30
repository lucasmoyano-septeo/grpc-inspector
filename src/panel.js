import {
  GRPC_STATUS,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  concatBytes,
  decodeBody,
  detectFormat,
  splitGrpcPath,
  toPlain,
} from './lib/decode.js';
import { createJsonView, expandEmbeddedJson, highlightJson, parseJsonString, unwrap } from './lib/jsonview.js';

const devtools = globalThis.chrome && chrome.devtools;
const tabId = devtools ? devtools.inspectedWindow.tabId : Number(new URLSearchParams(location.search).get('tabId'));

if (devtools && devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark');
else if (!devtools && matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark');

const $ = (s) => document.querySelector(s);
const els = {
  tbody: $('#list tbody'),
  empty: $('#empty'),
  count: $('#count'),
  filter: $('#filter'),
  errorsOnly: $('#errorsOnly'),
  preserve: $('#preserve'),
  detailPane: $('#detailPane'),
  subbar: $('#subbar'),
  detail: $('#detail'),
};

const calls = new Map(); // id -> call
let selectedId = null;
let activeTab = 'preview';

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('grpc-inspector-prefs') || '{}');
  } catch (_) {
    return {};
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem('grpc-inspector-prefs', JSON.stringify(prefs));
  } catch (_) {
    // storage blocked
  }
};
els.preserve.checked = !!prefs.preserve;
if (['headers', 'payload', 'preview', 'response', 'protobuf', 'timing'].includes(prefs.tab)) activeTab = prefs.tab;

const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8];
function applyZoom() {
  const z = prefs.zoom || 1.25;
  document.body.style.zoom = z;
  $('#zoomLabel').textContent = `${Math.round(z * 100)}%`;
}
applyZoom();

// ------------------------------------------------------------------ connection

let port;
function connect() {
  port = chrome.runtime.connect({ name: `panel:${tabId}` });
  port.onMessage.addListener((msg) => {
    if (msg.kind === 'replay') msg.events.forEach(applyEvent);
    else if (msg.kind === 'evt') applyEvent(msg.evt);
  });
  // the service worker can be restarted by the browser; reconnect silently
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}
connect();

if (devtools) {
  devtools.network.onNavigated.addListener(() => {
    if (!els.preserve.checked) clearAll();
  });
  devtools.network.onRequestFinished.addListener(onHarEntry);
}

// ------------------------------------------------------------------ model

function applyEvent(evt) {
  let c = calls.get(evt.id);
  if (evt.t === 'start') {
    if (c) return; // replay after reconnect
    const { service, method } = splitGrpcPath(evt.url);
    c = {
      id: evt.id,
      source: evt.transport,
      url: evt.url,
      service,
      method,
      httpMethod: evt.method,
      reqHeaders: evt.reqHeaders || {},
      reqBody: evt.reqBody ? base64ToBytes(evt.reqBody.data) : null,
      reqTruncated: !!(evt.reqBody && evt.reqBody.truncated),
      resHeaders: null,
      status: null,
      chunks: [],
      chunkCount: 0,
      chunkMarks: [], // [bytesReceivedSoFar, time]
      received: 0,
      resTruncated: false,
      startTime: evt.startTime,
      responseTime: null,
      endTime: null,
      error: null,
      frameUrl: evt.frameUrl,
      decoded: null,
      decodedAt: -1,
      warnings: [],
    };
    calls.set(c.id, c);
    scheduleDecode(c);
    return;
  }
  if (!c) return;
  if (evt.t === 'response') {
    if (c.resHeaders) return;
    c.resHeaders = evt.resHeaders || {};
    c.status = evt.status;
    c.statusText = evt.statusText;
    c.responseTime = evt.time;
  } else if (evt.t === 'chunk') {
    if (c.endTime) return;
    const bytes = base64ToBytes(evt.data);
    c.chunks.push(bytes);
    c.chunkCount++;
    c.received += bytes.length;
    c.chunkMarks.push([c.received, evt.time]);
    if (evt.truncated) c.resTruncated = true;
  } else if (evt.t === 'end') {
    if (c.endTime) return;
    c.endTime = evt.time;
    if (evt.error) c.error = evt.error;
  }
  scheduleDecode(c);
}

const resBytes = (c) => {
  if (c.chunks.length > 1) c.chunks = [concatBytes(c.chunks)];
  return c.chunks[0] || new Uint8Array(0);
};

const encodingOf = (headers) => (headers && (headers['grpc-encoding'] || headers['connect-content-encoding'])) || undefined;

async function decodeCall(c) {
  const version = c.chunkCount + (c.endTime ? 1e9 : 0) + (c.resHeaders ? 1e6 : 0);
  if (c.decodedAt === version && c.decoded) return c.decoded;
  const reqCt = c.reqHeaders['content-type'] || '';
  const resCt = (c.resHeaders && c.resHeaders['content-type']) || reqCt;
  const [req, res] = await Promise.all([
    decodeBody(c.reqBody, reqCt, encodingOf(c.reqHeaders)),
    decodeBody(resBytes(c), resCt, encodingOf(c.resHeaders)),
  ]);
  c.decoded = { req, res };
  c.decodedAt = version;
  return c.decoded;
}

// Coalesce redraws: streams can push hundreds of chunks per second.
const dirty = new Set();
let raf = 0;
function scheduleDecode(c) {
  dirty.add(c);
  if (!raf) raf = setTimeout(flush, 60);
}
async function flush() {
  raf = 0;
  const batch = [...dirty];
  dirty.clear();
  await Promise.all(batch.map((c) => decodeCall(c).catch((e) => c.warnings.push(String(e)))));
  batch.forEach(renderRow);
  updateEmpty();
  if (batch.some((c) => c.id === selectedId)) renderDetail();
}

function grpcStatusOf(c) {
  const d = c.decoded && c.decoded.res;
  const h = c.resHeaders || {};
  if (d && d.trailers && d.trailers['grpc-status'] != null) return { code: Number(d.trailers['grpc-status']), message: d.trailers['grpc-message'] };
  if (h['grpc-status'] != null) return { code: Number(h['grpc-status']), message: h['grpc-message'] };
  if (d && d.endStream) {
    const err = d.endStream.error;
    return err ? { code: codeFromName(err.code), message: err.message, name: err.code } : { code: 0 };
  }
  // Connect unary: HTTP status carries the result, error body is JSON {code, message}
  if (d && d.format === 'connect-unary' && c.status != null) {
    if (c.status === 200) return { code: 0 };
    const j = d.messages[0] && d.messages[0].json;
    return { code: j ? codeFromName(j.code) : 2, message: j && j.message, name: j && j.code };
  }
  return null;
}

function codeFromName(name) {
  const i = GRPC_STATUS.indexOf(String(name || '').toUpperCase());
  return i >= 0 ? i : 2;
}

function statusLabel(c) {
  if (c.error && !c.resHeaders) return { text: c.error, error: true };
  const s = grpcStatusOf(c);
  if (s) {
    const name = s.name ? s.name.toUpperCase() : GRPC_STATUS[s.code] || `CODE_${s.code}`;
    return { text: s.code === 0 ? 'OK' : `${s.code} ${name}`, error: s.code !== 0, message: s.message };
  }
  if (c.status != null && (c.status < 200 || c.status >= 300)) return { text: `HTTP ${c.status}`, error: true };
  if (!c.endTime) return { text: c.resHeaders ? 'streaming…' : 'pending…', pending: true };
  if (c.error) return { text: c.error, error: true };
  return { text: 'no status', error: false };
}

// ------------------------------------------------------------------ list

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtMs(c) {
  const end = c.endTime || (c.resHeaders ? Date.now() : null);
  if (!end) return '';
  const ms = end - c.startTime;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function matchesFilter(c) {
  const q = els.filter.value.trim().toLowerCase();
  if (q && !`${c.service}/${c.method} ${c.url}`.toLowerCase().includes(q)) return false;
  if (els.errorsOnly.checked && !statusLabel(c).error) return false;
  return true;
}

function renderRow(c) {
  let tr = document.getElementById(`row-${c.id}`);
  if (!tr) {
    tr = document.createElement('tr');
    tr.id = `row-${c.id}`;
    tr.addEventListener('click', () => select(c.id));
    tr.innerHTML = '<td class="c-method"></td><td class="c-status"></td><td class="c-type"></td><td class="c-msgs"></td><td class="c-size"></td><td class="c-time"></td>';
    els.tbody.appendChild(tr);
  }
  const st = statusLabel(c);
  const [tdM, tdS, tdY, tdN, tdZ, tdT] = tr.children;
  const svcShort = c.service.split('.').pop();
  tdM.innerHTML = '';
  tdM.append(el('span', 'svc', svcShort ? `${svcShort}/` : ''), document.createTextNode(c.method));
  tdM.title = `${c.url}${c.source === 'devtools' ? '\n(captured from DevTools network log)' : ''}`;
  tdS.textContent = st.text;
  tdS.title = st.message || st.text;
  const d = c.decoded;
  tdY.textContent = d ? d.res.format : '';
  tdN.textContent = d ? `${d.req.messages.length} / ${d.res.messages.length}` : '';
  tdZ.textContent = fmtSize((c.reqBody ? c.reqBody.length : 0) + resBytes(c).length);
  tdT.textContent = fmtMs(c);
  tr.classList.toggle('error', !!st.error);
  tr.classList.toggle('pending', !!st.pending);
  tr.classList.toggle('selected', c.id === selectedId);
  tr.hidden = !matchesFilter(c);
}

function rerenderList() {
  calls.forEach(renderRow);
  updateEmpty();
}

function updateEmpty() {
  const visible = [...calls.values()].filter(matchesFilter).length;
  els.empty.hidden = calls.size > 0;
  els.count.textContent = calls.size ? `${visible} / ${calls.size} calls` : '';
}

function clearAll() {
  calls.clear();
  els.tbody.innerHTML = '';
  selectedId = null;
  els.detailPane.hidden = true;
  updateEmpty();
  try {
    port.postMessage({ kind: 'clear' });
  } catch (_) {
    // reconnecting
  }
}

function select(id) {
  if (id !== selectedId) view.depth = 3;
  selectedId = id;
  document.querySelectorAll('#list tr.selected').forEach((r) => r.classList.remove('selected'));
  const tr = document.getElementById(`row-${id}`);
  if (tr) tr.classList.add('selected');
  els.detailPane.hidden = false;
  renderDetail();
}

// ------------------------------------------------------------------ detail

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function btn(label, onClick, title) {
  const b = el('button', null, label);
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function copyText(text) {
  const ta = el('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

const jsonReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

function messageAsJson(m) {
  if (m.json !== undefined) return m.json;
  if (m.fields) return toPlain(m.fields);
  return m.text != null ? m.text : { error: m.error, hex: m.hex };
}

// One message -> that message; a stream -> array of messages.
function sideValue(side) {
  const values = side.messages.map((m) => expandEmbeddedJson(messageAsJson(m)));
  return values.length === 1 ? values[0] : values;
}

// View state shared by Payload / Preview / Response.
const view = { search: '', depth: 3 };

function renderDetail() {
  const c = calls.get(selectedId);
  if (!c) {
    els.detailPane.hidden = true;
    return;
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  const scroll = els.detail.scrollTop;
  els.detail.innerHTML = '';
  els.subbar.innerHTML = '';
  const d = c.decoded;
  if (!d) {
    els.detail.append(el('p', 'muted', 'Decoding…'));
    return;
  }
  if (activeTab === 'headers') renderHeaders(c);
  else if (activeTab === 'payload') renderTreeTab(c, d.req, true);
  else if (activeTab === 'preview') renderTreeTab(c, d.res, false);
  else if (activeTab === 'response') renderSource(c, d.res);
  else if (activeTab === 'protobuf') renderProtobuf(c);
  else renderTiming(c);
  els.detail.scrollTop = scroll;
  // jump to the first match once per new search text
  if (view.search && view.search !== view.scrolledFor && (activeTab === 'preview' || activeTab === 'payload')) {
    view.scrolledFor = view.search;
    const hit = els.detail.querySelector('.jv-hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
  }
}

function statusBanner(c) {
  const st = statusLabel(c);
  if (!st.error) return null;
  return el('div', 'banner err', `${st.text}${st.message ? ` — ${st.message}` : ''}`);
}

function sideNotices(c, side, isReq) {
  const out = [];
  if (isReq && c.source === 'devtools')
    out.push(el('div', 'banner warn', 'Request body taken from the DevTools network log: binary bytes may be altered.'));
  if ((isReq ? c.reqTruncated : c.resTruncated)) out.push(el('div', 'banner warn', 'Body truncated at 10 MB.'));
  side.warnings.forEach((w) => out.push(el('div', 'banner warn', w)));
  side.messages.forEach((m, i) => {
    if (m.error) out.push(el('div', 'banner err', `${side.messages.length > 1 ? `Message #${i + 1}: ` : ''}${m.error}`));
  });
  return out;
}

function emptyText(c, isReq) {
  if (isReq) return 'Empty request body.';
  return c.endTime ? 'Empty response body.' : 'Waiting for data…';
}

function searchBox(onChange) {
  const s = el('input');
  s.type = 'search';
  s.placeholder = 'Find in body';
  s.value = view.search;
  let t = 0;
  s.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      view.search = s.value;
      onChange();
      const again = els.subbar.querySelector('input[type=search]');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 200);
  });
  return s;
}

function renderTreeTab(c, side, isReq) {
  const value = sideValue(side);
  const multi = side.messages.length > 1;
  const sourceMode = isReq ? prefs.payloadSource : false;

  els.subbar.append(
    btn('Expand all', () => {
      view.depth = 100;
      renderDetail();
    }, 'Alt+click a node to expand only that subtree'),
    btn('Collapse all', () => {
      view.depth = 1;
      renderDetail();
    }),
    searchBox(renderDetail),
  );
  if (isReq) {
    const b = btn(sourceMode ? 'View parsed' : 'View source', () => {
      prefs.payloadSource = !sourceMode;
      savePrefs();
      renderDetail();
    });
    els.subbar.append(b);
  }
  const matches = el('span', 'muted');
  els.subbar.append(el('span', 'spacer'), matches, btn(multi ? `Copy ${side.messages.length} messages` : 'Copy JSON', () => copyText(JSON.stringify(unwrap(value, true), jsonReplacer, 2))));

  const root = els.detail;
  if (!isReq) {
    const b = statusBanner(c);
    if (b) root.append(b);
  }
  sideNotices(c, side, isReq).forEach((n) => root.append(n));
  if (!side.messages.length) {
    root.append(el('p', 'muted', emptyText(c, isReq)));
    return;
  }
  if (sourceMode) {
    renderSourceBody(root, c, side, true);
    return;
  }
  const tree = createJsonView(value, {
    expandDepth: view.depth,
    search: view.search,
    onCopy: copyText,
    rootLabel: multi ? `${side.messages.length} messages` : null,
  });
  if (view.search) matches.textContent = `${tree.dataset.matches} match${tree.dataset.matches === '1' ? '' : 'es'}`;
  root.append(tree);
}

// Response tab: text body, pretty or raw like Chrome's {} toggle.
function renderSource(c, side) {
  els.subbar.append(
    toggle('Pretty print', 'pretty', true),
    toggle('Wrap lines', 'wrap', true),
    el('span', 'spacer'),
    btn('Copy', () => copyText(sourceText(c, side, prefs.pretty !== false))),
  );
  const b = statusBanner(c);
  if (b) els.detail.append(b);
  sideNotices(c, side, false).forEach((n) => els.detail.append(n));
  if (!side.messages.length) {
    els.detail.append(el('p', 'muted', emptyText(c, false)));
    return;
  }
  renderSourceBody(els.detail, c, side, prefs.pretty !== false);
}

function toggle(label, key, def) {
  const on = prefs[key] ?? def;
  const b = btn(label, () => {
    prefs[key] = !on;
    savePrefs();
    renderDetail();
  });
  if (on) b.classList.add('on');
  return b;
}

function sourceText(c, side, pretty) {
  if (pretty) return JSON.stringify(unwrap(sideValue(side), true), jsonReplacer, 2);
  // raw: JSON bodies as received, protobuf as compact JSON with strings untouched; one message per line
  return side.messages
    .map((m) => (m.json !== undefined || m.text != null ? m.text ?? JSON.stringify(m.json) : JSON.stringify(messageAsJson(m), jsonReplacer)))
    .join('\n');
}

function renderSourceBody(root, c, side, pretty) {
  const pre = el('pre', `source${prefs.wrap ?? true ? ' wrap' : ''}`);
  pre.append(highlightJson(sourceText(c, side, pretty)));
  root.append(pre);
}

// ---- Headers (Chrome-like General / Response / Request sections, each with raw view)

function kvTable(obj) {
  const t = el('table', 'kv');
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      const tr = el('tr');
      tr.append(el('td', null, k), el('td', null, String(obj[k])));
      t.append(tr);
    });
  return t;
}

function section(title, obj, key) {
  const det = el('details', 'sec');
  det.open = prefs[`sec-${key}`] ?? true;
  det.addEventListener('toggle', () => {
    prefs[`sec-${key}`] = det.open;
    savePrefs();
  });
  const sum = el('summary');
  sum.append(el('span', null, title), el('span', 'muted', obj ? `(${Object.keys(obj).length})` : ''), el('span', 'spacer'));
  const rawKey = `raw-${key}`;
  let body;
  const draw = () => {
    if (body) body.remove();
    if (!obj) body = el('p', 'muted', '(none)');
    else if (prefs[rawKey]) body = el('pre', 'source wrap', Object.keys(obj).map((k) => `${k}: ${obj[k]}`).join('\n'));
    else body = kvTable(obj);
    det.append(body);
  };
  if (obj && key !== 'general') {
    const rawBtn = btn('Raw', (e) => {
      e.preventDefault();
      prefs[rawKey] = !prefs[rawKey];
      savePrefs();
      rawBtn.classList.toggle('on', !!prefs[rawKey]);
      draw();
    });
    rawBtn.classList.toggle('on', !!prefs[rawKey]);
    sum.append(rawBtn);
  }
  det.append(sum);
  draw();
  return det;
}

function renderHeaders(c) {
  const st = statusLabel(c);
  const root = els.detail;
  root.append(
    section('General', {
      'Request URL': c.url,
      Service: c.service,
      Method: c.method,
      'HTTP method': c.httpMethod,
      'HTTP status': c.status != null ? `${c.status} ${c.statusText || ''}`.trim() : '(none)',
      'gRPC status': `${st.text}${st.message ? ` — ${st.message}` : ''}`,
      Protocol: c.decoded ? c.decoded.res.format : '',
      Captured: c.source === 'devtools' ? 'DevTools network log' : c.source,
      Frame: c.frameUrl || '',
    }, 'general'),
  );
  root.append(section('Response Headers', c.resHeaders, 'res'));
  if (c.decoded && c.decoded.res.trailers) root.append(section('Trailers', c.decoded.res.trailers, 'trailers'));
  if (c.decoded && c.decoded.res.endStream) root.append(section('End of stream', flatten(c.decoded.res.endStream), 'endstream'));
  root.append(section('Request Headers', c.reqHeaders, 'req'));
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object') flatten(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
}

// ---- Protobuf: wire-level view (field numbers, wire types) + hex dump

function renderProtobuf(c) {
  const root = els.detail;
  const side = (title, s, bytes) => {
    root.append(el('h3', null, `${title} · ${fmtSize(bytes ? bytes.length : 0)}`));
    if (!s.messages.length) root.append(el('p', 'muted', '(empty)'));
    s.messages.forEach((m, i) => {
      if (s.messages.length > 1) root.append(el('div', 'msg-sep', `Message #${i + 1}`));
      if (m.fields) root.append(renderWireTree(m.fields));
      else if (m.json !== undefined) root.append(el('p', 'muted', 'JSON message (no protobuf wire data).'));
      else if (m.error) root.append(el('div', 'error-text', m.error));
    });
    if (bytes && bytes.length) {
      const det = el('details', 'sec');
      const sum = el('summary');
      sum.append(el('span', null, 'Hex dump'), el('span', 'spacer'));
      sum.append(btn('Copy base64', (e) => {
        e.preventDefault();
        copyText(bytesToBase64(bytes));
      }));
      det.append(sum, el('pre', 'source', hexDump(bytes, 64 * 1024)));
      root.append(det);
    }
  };
  side('Request', c.decoded.req, c.reqBody);
  side('Response', c.decoded.res, resBytes(c));
}

function renderWireTree(fields, depth = 0) {
  const wrap = el('div', depth === 0 ? 'tree' : 'node');
  for (const f of fields) wrap.append(renderField(f, depth));
  return wrap;
}

function renderField(f, depth) {
  const box = el('div', 'node');
  const row = el('div', 'row');
  box.append(row);
  row.append(el('span', 'fno', String(f.no)), el('span', 'type', f.type));

  const expandable = (childFields, label, startOpen) => {
    const tog = el('span', 'tog', '');
    row.prepend(tog);
    let child = null;
    let open = startOpen;
    const set = () => {
      tog.textContent = open ? '▾' : '▸';
      if (open && !child) box.append((child = renderWireTree(childFields, depth + 1)));
      if (child) child.hidden = !open;
    };
    const flip = () => {
      open = !open;
      set();
    };
    tog.addEventListener('click', flip);
    const l = el('span', 'hint', label);
    l.style.cursor = 'pointer';
    l.addEventListener('click', flip);
    row.append(l);
    set();
  };

  const altToggle = (label, build) => {
    const alt = el('span', 'alt', label);
    row.append(alt);
    let child = null;
    alt.addEventListener('click', () => {
      if (child) {
        child.remove();
        child = null;
      } else box.append((child = build()));
    });
  };

  switch (f.type) {
    case 'message':
      expandable(f.fields, `{ ${f.fields.length} field${f.fields.length === 1 ? '' : 's'} }  ${fmtSize(f.length)}`, depth < 4);
      break;
    case 'string': {
      const json = parseJsonString(f.value);
      const shown = json !== undefined && f.value.length > 120 ? `${f.value.slice(0, 120)}…` : f.value;
      row.append(el('span', 'v-str', JSON.stringify(shown)));
      if (json !== undefined) {
        altToggle('as JSON', () => {
          const d = el('div', 'inline-json');
          d.append(createJsonView(expandEmbeddedJson(json), { expandDepth: 1, onCopy: copyText }));
          return d;
        });
      }
      if (f.asMessage) altToggle('as message', () => renderWireTree(f.asMessage, depth + 1));
      break;
    }
    case 'bytes':
      row.append(el('span', 'v-num', f.hex), el('span', 'hint', fmtSize(f.length)));
      if (f.asPacked) row.append(el('span', 'hint', `packed: [${f.asPacked.join(', ')}]`));
      break;
    case 'fixed32':
      row.append(el('span', 'v-num', f.value), el('span', 'hint', `int32 ${f.int32} · float ${f.float}`));
      break;
    case 'fixed64':
      row.append(el('span', 'v-num', f.value), el('span', 'hint', `int64 ${f.int64} · double ${f.double}`));
      break;
    default: {
      row.append(el('span', 'v-num', f.value));
      const hints = [];
      if (f.int64) hints.push(`int64 ${f.int64}`);
      if (f.sint) hints.push(`sint ${f.sint}`);
      if (f.bool !== undefined) hints.push(`bool ${f.bool}`);
      const ts = Number(f.value);
      if (ts > 946684800 && ts < 4102444800) hints.push(new Date(ts * 1000).toISOString());
      else if (ts > 946684800000 && ts < 4102444800000) hints.push(new Date(ts).toISOString());
      if (hints.length) row.append(el('span', 'hint', hints.join(' · ')));
    }
  }
  return box;
}

function hexDump(bytes, max) {
  const n = Math.min(bytes.length, max);
  const lines = [];
  for (let o = 0; o < n; o += 16) {
    const row = bytes.subarray(o, Math.min(o + 16, n));
    const hex = bytesToHex(row).padEnd(47, ' ');
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${o.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  if (n < bytes.length) lines.push(`… ${bytes.length - n} more bytes`);
  return lines.join('\n');
}

// ---- Timing

function msText(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function renderTiming(c) {
  const root = els.detail;
  const end = c.endTime || Date.now();
  const total = Math.max(1, end - c.startTime);
  const pct = (t) => `${((t - c.startTime) / total) * 100}%`;
  const t = el('table', 'timing');
  const row = (label, from, to, cls) => {
    const tr = el('tr');
    const bar = el('td', 'bar');
    const track = el('div', 'track');
    if (from != null && to != null) {
      const f = el('div', `fill ${cls}`);
      f.style.left = pct(from);
      f.style.width = `max(2px, ${((to - from) / total) * 100}%)`;
      track.append(f);
    }
    bar.append(track);
    tr.append(el('td', null, label), bar, el('td', null, from != null && to != null ? msText(to - from) : '—'));
    t.append(tr);
  };
  root.append(el('p', 'muted', `Started at ${new Date(c.startTime).toLocaleTimeString()}.${String(c.startTime % 1000).padStart(3, '0')}${c.endTime ? '' : ' · still open'}`));
  row('Waiting for server (TTFB)', c.startTime, c.responseTime, 'wait');
  row(c.decoded && c.decoded.res.messages.length > 1 ? 'Streaming messages' : 'Content download', c.responseTime, c.responseTime ? end : null, 'dl');
  const tot = el('tr');
  const totCell = el('td');
  totCell.append(el('strong', null, msText(end - c.startTime)));
  tot.append(el('td', null, 'Total'), el('td'), totCell);
  t.append(tot);
  root.append(t);

  const arrivals = messageArrivals(c);
  if (arrivals.length > 1) {
    root.append(el('h3', null, `Messages (${arrivals.length})`));
    const mt = el('table', 'timing');
    arrivals.forEach((time, i) => {
      const tr = el('tr');
      const bar = el('td', 'bar');
      const track = el('div', 'track');
      if (time) {
        const f = el('div', 'fill msg');
        f.style.left = pct(time);
        track.append(f);
      }
      bar.append(track);
      const size = c.decoded.res.messages[i] ? fmtSize(c.decoded.res.messages[i].size) : '';
      tr.append(el('td', null, `#${i + 1}  ${size}`), bar, el('td', null, time ? `+${msText(time - c.startTime)}` : '—'));
      mt.append(tr);
    });
    root.append(mt);
  }
}

// When each response message arrived, from the chunk timestamps and frame end offsets.
function messageArrivals(c) {
  const msgs = (c.decoded && c.decoded.res.messages) || [];
  return msgs.map((m) => {
    if (m.end == null) return null;
    const mark = c.chunkMarks.find(([offset]) => offset >= m.end);
    return mark ? mark[1] : null;
  });
}

// ------------------------------------------------------------------ DevTools network log fallback
// Catches calls the page hooks cannot see (Web Workers, requests started before document_start).

const GRPC_CT = /^application\/(grpc|connect\+)/i;

function harHeaders(list) {
  const out = {};
  (list || []).forEach((h) => {
    out[h.name.toLowerCase()] = h.value;
  });
  return out;
}

function onHarEntry(entry) {
  const reqHeaders = harHeaders(entry.request.headers);
  const resHeaders = harHeaders(entry.response.headers);
  if (!GRPC_CT.test(reqHeaders['content-type'] || '') && !GRPC_CT.test(resHeaders['content-type'] || '')) return;
  const started = Date.parse(entry.startedDateTime);
  // Give hook events (which travel through the service worker) time to arrive first.
  setTimeout(() => {
    for (const c of calls.values()) {
      if (c.url === entry.request.url && c.source !== 'devtools' && !c.harMatched && Math.abs(c.startTime - started) < 3000) {
        c.harMatched = true;
        return;
      }
    }
    entry.getContent((content, encoding) => {
      const id = `har-${started}-${Math.random().toString(36).slice(2, 8)}`;
      const post = entry.request.postData && entry.request.postData.text;
      const reqCt = reqHeaders['content-type'] || '';
      applyEvent({
        t: 'start',
        id,
        transport: 'devtools',
        url: entry.request.url,
        method: entry.request.method,
        reqHeaders,
        reqBody: post ? { data: harTextToBase64(post, detectFormat(reqCt).text) } : null,
        startTime: started,
      });
      const c = calls.get(id);
      c.source = 'devtools';
      applyEvent({ t: 'response', id, status: entry.response.status, statusText: entry.response.statusText, resHeaders, time: started });
      if (content) {
        applyEvent({ t: 'chunk', id, data: encoding === 'base64' ? content : bytesToBase64(new TextEncoder().encode(content)) });
      }
      applyEvent({ t: 'end', id, time: started + Math.round(entry.time || 0) });
    });
  }, 1500);
}

function harTextToBase64(text, isTextFormat) {
  if (isTextFormat) return bytesToBase64(new TextEncoder().encode(text));
  // DevTools exposes binary bodies as latin1-ish strings; best effort.
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytesToBase64(bytes);
}

// ------------------------------------------------------------------ toolbar

$('#clear').addEventListener('click', clearAll);
$('#closeDetail').addEventListener('click', () => {
  selectedId = null;
  els.detailPane.hidden = true;
  rerenderList();
});
els.filter.addEventListener('input', rerenderList);
els.errorsOnly.addEventListener('change', rerenderList);
els.preserve.addEventListener('change', () => {
  prefs.preserve = els.preserve.checked;
  savePrefs();
});
const zoomBy = (dir) => {
  const cur = prefs.zoom || 1.25;
  const i = ZOOMS.findIndex((z) => z >= cur - 0.001);
  prefs.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
  savePrefs();
  applyZoom();
};
$('#zoomIn').addEventListener('click', () => zoomBy(1));
$('#zoomOut').addEventListener('click', () => zoomBy(-1));
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = prefs.tab = b.dataset.tab;
    savePrefs();
    els.detail.scrollTop = 0;
    renderDetail();
  }),
);

$('#export').addEventListener('click', async () => {
  const out = [];
  for (const c of calls.values()) {
    const d = await decodeCall(c);
    out.push({
      service: c.service,
      method: c.method,
      url: c.url,
      status: statusLabel(c).text,
      httpStatus: c.status,
      durationMs: c.endTime ? c.endTime - c.startTime : null,
      startTime: new Date(c.startTime).toISOString(),
      requestHeaders: c.reqHeaders,
      responseHeaders: c.resHeaders,
      trailers: d.res.trailers,
      request: d.req.messages.map(messageAsJson),
      response: d.res.messages.map(messageAsJson),
      requestBodyBase64: c.reqBody ? bytesToBase64(c.reqBody) : null,
      responseBodyBase64: bytesToBase64(resBytes(c)),
    });
  }
  const blob = new Blob([JSON.stringify(out, jsonReplacer, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `grpc-calls-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (document.activeElement === els.filter) return;
  const rows = [...els.tbody.querySelectorAll('tr:not([hidden])')];
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.id === `row-${selectedId}`);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  select(next.id.slice(4));
  next.scrollIntoView({ block: 'nearest' });
  e.preventDefault();
});

// Keep durations of open streams ticking.
setInterval(() => {
  calls.forEach((c) => {
    if (!c.endTime && c.resHeaders) renderRow(c);
  });
}, 1000);

updateEmpty();
