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
  summary: $('#summary'),
  detail: $('#detail'),
  jsonView: $('#jsonView'),
};

const calls = new Map(); // id -> call
let selectedId = null;
let activeTab = 'response';

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
els.jsonView.checked = !!prefs.json;
if (prefs.tab) activeTab = prefs.tab;

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
    c.chunks.push(base64ToBytes(evt.data));
    c.chunkCount++;
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
    tr.innerHTML = '<td class="c-method"></td><td class="c-status"></td><td class="c-msgs"></td><td class="c-size"></td><td class="c-time"></td>';
    els.tbody.appendChild(tr);
  }
  const st = statusLabel(c);
  const [tdM, tdS, tdN, tdZ, tdT] = tr.children;
  const svcShort = c.service.split('.').pop();
  tdM.innerHTML = '';
  tdM.append(el('span', 'svc', svcShort ? `${svcShort}/` : ''), document.createTextNode(c.method));
  tdM.title = `${c.url}${c.source === 'devtools' ? '\n(captured from DevTools network log)' : ''}`;
  tdS.textContent = st.text;
  tdS.title = st.message || st.text;
  const d = c.decoded;
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

function renderDetail() {
  const c = calls.get(selectedId);
  if (!c) {
    els.detailPane.hidden = true;
    return;
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));

  const st = statusLabel(c);
  els.summary.innerHTML = '';
  const line1 = el('div');
  line1.append(el('strong', null, `${c.service}/${c.method}`), document.createTextNode('  '));
  line1.append(el('span', st.error ? 'status-err' : st.pending ? 'muted' : 'status-ok', st.text));
  if (st.message) line1.append(document.createTextNode(` — ${st.message}`));
  const line2 = el('div', 'muted', `${c.httpMethod} ${c.url}`);
  const meta = [
    c.status != null ? `HTTP ${c.status}` : null,
    fmtMs(c),
    c.source === 'devtools' ? 'from DevTools log' : c.source,
    c.decoded ? c.decoded.res.format : null,
  ].filter(Boolean);
  const line3 = el('div', 'muted', meta.join(' · '));
  els.summary.append(line1, line2, line3);

  const scroll = els.detail.scrollTop;
  els.detail.innerHTML = '';
  const d = c.decoded;
  if (!d) {
    els.detail.append(el('p', 'muted', 'Decoding…'));
    return;
  }
  if (activeTab === 'request') renderMessages(d.req, c.reqTruncated, c.reqBody, c);
  else if (activeTab === 'response') renderMessages(d.res, c.resTruncated, resBytes(c), c);
  else if (activeTab === 'headers') renderHeaders(c);
  else renderRaw(c);
  els.detail.scrollTop = scroll;
}

function renderMessages(side, truncated, raw, c) {
  const root = els.detail;
  if (c.source === 'devtools' && side === c.decoded.req) {
    root.append(el('div', 'warn', 'Request body comes from the DevTools network log and binary bytes may be altered. Calls made from the page (not workers) are captured byte-exact.'));
  }
  if (truncated) root.append(el('div', 'warn', 'Body truncated at 10 MB.'));
  side.warnings.forEach((w) => root.append(el('div', 'warn', w)));
  if (!raw || !raw.length) {
    root.append(el('p', 'muted', side === c.decoded.req ? 'Empty request body.' : c.endTime ? 'Empty response body.' : 'Waiting for data…'));
  }

  const all = [];
  side.messages.forEach((m, i) => {
    const box = el('div', 'msg');
    const head = el('div', 'msg-head');
    head.append(el('strong', null, side.messages.length > 1 ? `Message #${i + 1}` : 'Message'), el('span', 'muted', fmtSize(m.size)));
    head.append(el('span', 'spacer'));
    const copy = el('button', null, 'Copy JSON');
    copy.addEventListener('click', () => copyText(JSON.stringify(messageAsJson(m), jsonReplacer, 2)));
    head.append(copy);
    const body = el('div', 'msg-body');
    if (m.error) body.append(el('div', 'error-text', m.error));
    if (m.fields && !els.jsonView.checked) body.append(renderTree(m.fields));
    else if (m.fields || m.json !== undefined) body.append(el('pre', null, JSON.stringify(messageAsJson(m), jsonReplacer, 2)));
    else if (m.text != null) body.append(el('pre', null, m.text));
    if (m.hex) body.append(el('pre', 'muted', m.hex));
    box.append(head, body);
    root.append(box);
    all.push(messageAsJson(m));
  });

  if (side.messages.length > 1) {
    const copyAll = el('button', null, `Copy all ${side.messages.length} messages as JSON`);
    copyAll.addEventListener('click', () => copyText(JSON.stringify(all, jsonReplacer, 2)));
    root.prepend(copyAll);
  }
  if (side.trailers) {
    root.append(el('h3', null, 'Trailers'));
    root.append(kvTable(side.trailers));
  }
  if (side.endStream) {
    root.append(el('h3', null, 'End of stream'));
    root.append(el('pre', null, JSON.stringify(side.endStream, null, 2)));
  }
}

function renderTree(fields, depth = 0) {
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
    const set = (open) => {
      tog.textContent = open ? '▾' : '▸';
      if (open && !child) {
        child = renderTree(childFields, depth + 1);
        box.append(child);
      }
      if (child) child.hidden = !open;
    };
    let open = startOpen;
    tog.addEventListener('click', () => set((open = !open)));
    if (label) {
      const l = el('span', 'hint', label);
      l.style.cursor = 'pointer';
      l.addEventListener('click', () => set((open = !open)));
      row.append(l);
    }
    set(open);
  };

  switch (f.type) {
    case 'message':
      expandable(f.fields, `{ ${f.fields.length} field${f.fields.length === 1 ? '' : 's'} }  ${fmtSize(f.length)}`, depth < 4);
      break;
    case 'string': {
      row.append(el('span', 'v-str', JSON.stringify(f.value)));
      if (f.asMessage) {
        const alt = el('span', 'alt', 'as message');
        alt.title = 'These bytes are also a valid protobuf message';
        row.append(alt);
        let child = null;
        alt.addEventListener('click', () => {
          if (child) {
            child.remove();
            child = null;
          } else box.append((child = renderTree(f.asMessage, depth + 1)));
        });
      }
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

function renderHeaders(c) {
  const root = els.detail;
  root.append(el('h3', null, 'General'));
  root.append(kvTable({ URL: c.url, 'HTTP method': c.httpMethod, 'HTTP status': c.status != null ? `${c.status} ${c.statusText || ''}` : '(none)', Transport: c.source, Frame: c.frameUrl || '' }));
  root.append(el('h3', null, 'Request headers'));
  root.append(kvTable(c.reqHeaders));
  root.append(el('h3', null, 'Response headers'));
  root.append(c.resHeaders ? kvTable(c.resHeaders) : el('p', 'muted', '(none)'));
  if (c.decoded && c.decoded.res.trailers) {
    root.append(el('h3', null, 'Trailers'));
    root.append(kvTable(c.decoded.res.trailers));
  }
}

function renderRaw(c) {
  const root = els.detail;
  const side = (title, bytes) => {
    root.append(el('h3', null, `${title} (${fmtSize(bytes ? bytes.length : 0)})`));
    if (!bytes || !bytes.length) {
      root.append(el('p', 'muted', '(empty)'));
      return;
    }
    const b64 = el('button', null, 'Copy base64');
    b64.addEventListener('click', () => copyText(bytesToBase64(bytes)));
    root.append(b64, el('pre', null, hexDump(bytes, 64 * 1024)));
  };
  side('Request body', c.reqBody);
  side('Response body', resBytes(c));
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
els.jsonView.addEventListener('change', () => {
  prefs.json = els.jsonView.checked;
  savePrefs();
  renderDetail();
});
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    activeTab = prefs.tab = b.dataset.tab;
    savePrefs();
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
