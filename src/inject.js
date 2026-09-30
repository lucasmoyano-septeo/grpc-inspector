// Runs in the page's MAIN world at document_start. Wraps fetch and XMLHttpRequest,
// copies the bytes of gRPC-Web / Connect calls and hands them to bridge.js.
(() => {
  if (window.__grpcInspectorInstalled) return;
  window.__grpcInspectorInstalled = true;

  const EVENT = '__grpc_inspector_evt';
  const MAX_BODY = 10 * 1024 * 1024;
  const GRPC_CT = /^application\/(grpc|connect\+|grpc-web)/i;
  const CONNECT_UNARY_CT = /^application\/(proto|json)/i;
  // gRPC paths are always /<package.Service>/<Method>
  const GRPC_PATH = /\/[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*\/[A-Za-z_]\w*\/?$/;

  let seq = 0;
  const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const emit = (msg) => {
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(msg) }));
    } catch (_) {
      // never break the page because of the inspector
    }
  };

  const encoder = new TextEncoder();

  const toBase64 = (bytes) => {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(bin);
  };

  const clip = (bytes) =>
    bytes.length > MAX_BODY ? { data: toBase64(bytes.subarray(0, MAX_BODY)), truncated: true } : { data: toBase64(bytes), truncated: false };

  const bodyToBytes = async (body) => {
    if (body == null) return null;
    if (typeof body === 'string') return encoder.encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return encoder.encode(body.toString());
    return null; // FormData, ReadableStream: not copied to avoid consuming them
  };

  const headersToObject = (headers) => {
    const out = {};
    if (!headers) return out;
    try {
      new Headers(headers).forEach((v, k) => {
        out[k] = v;
      });
    } catch (_) {
      // invalid headers init, fetch itself will reject
    }
    return out;
  };

  const parseRawHeaders = (raw) => {
    const out = {};
    (raw || '').trim().split(/[\r\n]+/).forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  };

  const absoluteUrl = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return String(url);
    }
  };

  const looksLikeCandidate = (method, url, reqHeaders) => {
    const ct = reqHeaders['content-type'] || '';
    if (GRPC_CT.test(ct)) return true;
    if (reqHeaders['connect-protocol-version']) return true;
    if (String(method).toUpperCase() !== 'POST') return false;
    try {
      return GRPC_PATH.test(new URL(url).pathname) && (ct === '' || CONNECT_UNARY_CT.test(ct));
    } catch (_) {
      return false;
    }
  };

  const isConfirmed = (reqHeaders, resHeaders) => {
    const reqCt = reqHeaders['content-type'] || '';
    const resCt = resHeaders['content-type'] || '';
    return (
      GRPC_CT.test(reqCt) ||
      GRPC_CT.test(resCt) ||
      !!reqHeaders['connect-protocol-version'] ||
      'grpc-status' in resHeaders ||
      'grpc-message' in resHeaders
    );
  };

  // ---------------------------------------------------------------- fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url;
      let method;
      let reqHeaders;
      let bodyPromise = Promise.resolve(null);
      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        url = absoluteUrl(isRequest ? input.url : input);
        method = (init && init.method) || (isRequest ? input.method : 'GET');
        reqHeaders = headersToObject((init && init.headers) || (isRequest ? input.headers : undefined));
        if (!looksLikeCandidate(method, url, reqHeaders)) return origFetch.apply(this, arguments);
        if (init && init.body != null) bodyPromise = bodyToBytes(init.body);
        else if (isRequest) bodyPromise = input.clone().arrayBuffer().then((b) => new Uint8Array(b));
      } catch (_) {
        return origFetch.apply(this, arguments);
      }

      const id = newId();
      const startTime = Date.now();
      const startEvt = bodyPromise
        .catch(() => null)
        .then((bytes) => ({
          t: 'start',
          id,
          transport: 'fetch',
          url,
          method,
          reqHeaders,
          reqBody: bytes ? clip(bytes) : null,
          startTime,
        }));

      const p = origFetch.apply(this, arguments);
      p.then(
        async (res) => {
          const resHeaders = headersToObject(res.headers);
          if (!isConfirmed(reqHeaders, resHeaders)) return;
          // clone before any await: the page may consume the body right after this tick
          let copy = null;
          try {
            copy = res.body ? res.clone() : null;
          } catch (_) {
            copy = null;
          }
          emit(await startEvt);
          emit({ t: 'response', id, status: res.status, statusText: res.statusText, resHeaders, time: Date.now() });
          if (!copy) {
            emit({ t: 'end', id, time: Date.now(), error: res.body ? 'Response body could not be copied' : undefined });
            return;
          }
          let total = 0;
          try {
            const reader = copy.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (total >= MAX_BODY) continue;
              const slice = value.subarray(0, MAX_BODY - total);
              total += slice.length;
              emit({ t: 'chunk', id, data: toBase64(slice), truncated: slice.length < value.length, time: Date.now() });
            }
            emit({ t: 'end', id, time: Date.now() });
          } catch (err) {
            emit({ t: 'end', id, time: Date.now(), error: String((err && err.message) || err) });
          }
        },
        async (err) => {
          if (!GRPC_CT.test(reqHeaders['content-type'] || '') && !reqHeaders['connect-protocol-version']) return;
          emit(await startEvt);
          emit({ t: 'end', id, time: Date.now(), error: String((err && err.message) || err) });
        },
      );
      return p;
    };
  }

  // ---------------------------------------------------------------- XHR
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const state = new WeakMap();
    const proto = XHR.prototype;
    const origOpen = proto.open;
    const origSetHeader = proto.setRequestHeader;
    const origSend = proto.send;

    proto.open = function (method, url) {
      state.set(this, { method, url: absoluteUrl(url), reqHeaders: {} });
      return origOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (name, value) {
      const s = state.get(this);
      if (s) {
        const k = String(name).toLowerCase();
        s.reqHeaders[k] = s.reqHeaders[k] ? `${s.reqHeaders[k]}, ${value}` : String(value);
      }
      return origSetHeader.apply(this, arguments);
    };

    proto.send = function (body) {
      const s = state.get(this);
      if (s && looksLikeCandidate(s.method, s.url, s.reqHeaders)) {
        try {
          trackXhr(this, s, body);
        } catch (_) {
          // ignore, never break the request
        }
      }
      return origSend.apply(this, arguments);
    };

    const trackXhr = (xhr, s, body) => {
      const id = newId();
      const startTime = Date.now();
      const bodyPromise = bodyToBytes(body).catch(() => null);
      let confirmed = null; // null = unknown yet
      let textOffset = 0;
      let total = 0;
      let started = null;

      const ensureStarted = () => {
        if (!started) {
          started = bodyPromise.then((bytes) => {
            emit({
              t: 'start',
              id,
              transport: 'xhr',
              url: s.url,
              method: s.method,
              reqHeaders: s.reqHeaders,
              reqBody: bytes ? clip(bytes) : null,
              startTime,
            });
          });
        }
        return started;
      };

      const readTextDelta = () => {
        const rt = xhr.responseType;
        if (rt !== '' && rt !== 'text') return;
        let text;
        try {
          text = xhr.responseText;
        } catch (_) {
          return;
        }
        if (!text || text.length <= textOffset) return;
        const delta = text.slice(textOffset);
        textOffset = text.length;
        pushBytes(encoder.encode(delta));
      };

      const pushBytes = (bytes) => {
        if (total >= MAX_BODY) return;
        const slice = bytes.subarray(0, MAX_BODY - total);
        total += slice.length;
        emit({ t: 'chunk', id, data: toBase64(slice), truncated: slice.length < bytes.length, time: Date.now() });
      };

      // Events are queued behind the async start event so ordering is preserved.
      let chain = Promise.resolve();
      const queue = (fn) => {
        chain = chain.then(fn).catch(() => {});
      };

      const onHeaders = () => {
        const resHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
        confirmed = isConfirmed(s.reqHeaders, resHeaders);
        if (!confirmed) return;
        queue(ensureStarted);
        queue(() => emit({ t: 'response', id, status: xhr.status, statusText: xhr.statusText, resHeaders, time: Date.now() }));
      };

      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState === 2 && confirmed === null) onHeaders();
      });
      xhr.addEventListener('progress', () => {
        if (confirmed) queue(readTextDelta);
      });
      xhr.addEventListener('loadend', () => {
        if (confirmed === null && xhr.status !== 0) onHeaders();
        if (confirmed === false) return;
        if (confirmed === null) {
          // network error before headers: only report if the request itself was gRPC
          if (!GRPC_CT.test(s.reqHeaders['content-type'] || '')) return;
          queue(ensureStarted);
        }
        queue(async () => {
          const rt = xhr.responseType;
          if (rt === 'arraybuffer' && xhr.response) pushBytes(new Uint8Array(xhr.response));
          else if (rt === 'blob' && xhr.response) pushBytes(new Uint8Array(await xhr.response.arrayBuffer()));
          else readTextDelta();
        });
        queue(() => emit({ t: 'end', id, time: Date.now(), error: xhr.status === 0 ? 'Network error or aborted' : undefined }));
      });
    };
  }
})();
