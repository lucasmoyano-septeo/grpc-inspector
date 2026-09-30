// Schemaless decoding of gRPC-Web / Connect bodies. Pure functions, no DOM: also used by the tests.

export const GRPC_STATUS = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
];

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');

export function base64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function bytesToHex(bytes, max = Infinity) {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + bytes[i].toString(16).padStart(2, '0');
  return n < bytes.length ? `${s} …` : s;
}

export function concatBytes(chunks) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// grpc-web-text streams are base64 chunks that may each carry their own padding.
export function decodeGrpcWebText(bytes) {
  const text = utf8Loose.decode(bytes).replace(/\s+/g, '');
  const segments = text.match(/[A-Za-z0-9+/_-]+={0,2}/g) || [];
  return concatBytes(segments.map((s) => base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'))));
}

export function detectFormat(contentType = '') {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  const json = /\+json$|\/json$/.test(ct);
  if (ct.startsWith('application/grpc-web-text')) return { kind: 'grpc-web-text', framed: true, text: true, json: false };
  if (ct.startsWith('application/grpc-web')) return { kind: 'grpc-web', framed: true, json };
  if (ct.startsWith('application/grpc')) return { kind: 'grpc', framed: true, json };
  if (ct.startsWith('application/connect+')) return { kind: 'connect-stream', framed: true, connect: true, json };
  if (ct === 'application/proto' || ct === 'application/x-protobuf' || ct === 'application/protobuf')
    return { kind: 'connect-unary', framed: false, json: false };
  if (ct === 'application/json') return { kind: 'connect-unary', framed: false, json: true };
  return { kind: 'unknown', framed: false, json: false };
}

// Length-prefixed messages: 1 flag byte + 4 bytes big-endian length + payload.
export function parseFrames(bytes) {
  const frames = [];
  let o = 0;
  while (o + 5 <= bytes.length) {
    const flag = bytes[o];
    const len = ((bytes[o + 1] << 24) | (bytes[o + 2] << 16) | (bytes[o + 3] << 8) | bytes[o + 4]) >>> 0;
    if (o + 5 + len > bytes.length) break;
    frames.push({ flag, payload: bytes.subarray(o + 5, o + 5 + len) });
    o += 5 + len;
  }
  return { frames, leftover: bytes.length - o };
}

export function parseTrailers(text) {
  const out = {};
  text.split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  if (out['grpc-message']) {
    try {
      out['grpc-message'] = decodeURIComponent(out['grpc-message']);
    } catch (_) {
      // keep raw
    }
  }
  return out;
}

async function decompress(bytes, encoding) {
  const fmt = encoding === 'gzip' ? 'gzip' : encoding === 'deflate' ? 'deflate' : null;
  if (!fmt || typeof DecompressionStream === 'undefined') throw new Error(`Unsupported compression: ${encoding}`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ------------------------------------------------------------------ protobuf wire format

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result, pos };
    shift += 7n;
  }
  return null;
}

function isPrintable(str) {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/.test(str);
}

function varintInfo(v) {
  const u64 = BigInt.asUintN(64, v);
  const i64 = BigInt.asIntN(64, v);
  const zz = (u64 >> 1n) ^ -(u64 & 1n);
  const info = { value: u64.toString() };
  if (i64 < 0n) info.int64 = i64.toString();
  if (zz !== u64 && u64 !== 0n) info.sint = zz.toString();
  if (u64 === 0n || u64 === 1n) info.bool = u64 === 1n;
  return info;
}

function tryPacked(bytes) {
  const values = [];
  let pos = 0;
  while (pos < bytes.length) {
    const r = readVarint(bytes, pos);
    if (!r) return null;
    values.push(BigInt.asUintN(64, r.value).toString());
    pos = r.pos;
  }
  return values.length > 1 ? values : null;
}

const MAX_DEPTH = 32;

// Returns an array of fields, or null when the bytes are not a well-formed message.
export function decodeProto(bytes, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  const fields = [];
  let pos = 0;
  while (pos < bytes.length) {
    const key = readVarint(bytes, pos);
    if (!key) return null;
    pos = key.pos;
    const no = Number(key.value >> 3n);
    const wt = Number(key.value & 7n);
    if (no < 1 || no > 536870911) return null;
    if (wt === 0) {
      const v = readVarint(bytes, pos);
      if (!v) return null;
      pos = v.pos;
      fields.push({ no, wt, type: 'varint', ...varintInfo(v.value) });
    } else if (wt === 1) {
      if (pos + 8 > bytes.length) return null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
      fields.push({
        no, wt, type: 'fixed64',
        value: dv.getBigUint64(0, true).toString(),
        int64: dv.getBigInt64(0, true).toString(),
        double: dv.getFloat64(0, true),
      });
      pos += 8;
    } else if (wt === 5) {
      if (pos + 4 > bytes.length) return null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
      fields.push({
        no, wt, type: 'fixed32',
        value: String(dv.getUint32(0, true)),
        int32: String(dv.getInt32(0, true)),
        float: dv.getFloat32(0, true),
      });
      pos += 4;
    } else if (wt === 2) {
      const l = readVarint(bytes, pos);
      if (!l) return null;
      const len = Number(l.value);
      pos = l.pos;
      if (pos + len > bytes.length) return null;
      fields.push({ no, wt, ...decodeLengthDelimited(bytes.subarray(pos, pos + len), depth) });
      pos += len;
    } else {
      return null; // groups (3/4) are deprecated; 6/7 are invalid
    }
  }
  return fields;
}

function decodeLengthDelimited(sub, depth) {
  if (sub.length === 0) return { type: 'string', value: '', length: 0 };
  let str = null;
  try {
    str = utf8.decode(sub);
    if (!isPrintable(str)) str = null;
  } catch (_) {
    str = null;
  }
  const msg = decodeProto(sub, depth + 1);
  const asMessage = msg && msg.length ? msg : null;
  if (str !== null) return { type: 'string', value: str, length: sub.length, asMessage };
  if (asMessage) return { type: 'message', fields: asMessage, length: sub.length };
  return { type: 'bytes', base64: bytesToBase64(sub), hex: bytesToHex(sub, 64), length: sub.length, asPacked: tryPacked(sub) };
}

// Plain JSON view: { "<fieldNo>": value }, repeated fields become arrays.
export function toPlain(fields) {
  const out = {};
  for (const f of fields) {
    const v = plainValue(f);
    const k = String(f.no);
    if (k in out) {
      if (!Array.isArray(out[k]) || !out[k].__repeated) {
        const arr = [out[k]];
        Object.defineProperty(arr, '__repeated', { value: true });
        out[k] = arr;
      }
      out[k].push(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function plainValue(f) {
  switch (f.type) {
    case 'message':
      return toPlain(f.fields);
    case 'string':
      return f.value;
    case 'bytes':
      return f.asPacked ? f.asPacked.map(numOrString) : f.base64;
    case 'fixed32':
      return f.float !== 0 && Math.abs(f.float) > 1e-6 && Math.abs(f.float) < 1e9 && !Number.isInteger(f.float) ? f.float : numOrString(f.value);
    case 'fixed64':
      return Number.isFinite(f.double) && !Number.isInteger(f.double) && Math.abs(f.double) > 1e-9 && Math.abs(f.double) < 1e15
        ? f.double
        : numOrString(f.value);
    default:
      return numOrString(f.value);
  }
}

function numOrString(s) {
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
}

// ------------------------------------------------------------------ body decoding

function decodeMessage(payload, json) {
  if (json) {
    const text = utf8Loose.decode(payload);
    try {
      return { json: JSON.parse(text), size: payload.length };
    } catch (_) {
      return { text, size: payload.length, error: 'Invalid JSON' };
    }
  }
  const fields = decodeProto(payload);
  if (fields) return { fields, size: payload.length };
  return { size: payload.length, error: 'Not a valid protobuf message', hex: bytesToHex(payload, 256) };
}

/**
 * @param {Uint8Array} bytes raw body as captured
 * @param {string} contentType content-type of this side of the exchange
 * @param {string} [encoding] grpc-encoding / connect-content-encoding value
 */
export async function decodeBody(bytes, contentType, encoding) {
  const format = detectFormat(contentType);
  const result = { format: format.kind, messages: [], trailers: null, endStream: null, warnings: [] };
  if (!bytes || !bytes.length) return result;

  let data = bytes;
  if (format.text) {
    try {
      data = decodeGrpcWebText(bytes);
    } catch (e) {
      result.warnings.push(`base64 decode failed: ${e.message}`);
      return result;
    }
  }

  if (!format.framed) {
    if (format.kind === 'unknown') {
      // Unknown content-type: try framed first, then a bare message.
      const { frames, leftover } = parseFrames(data);
      if (frames.length && !leftover) return decodeFramed(frames, format, encoding, result);
    }
    result.messages.push(decodeMessage(data, format.json));
    return result;
  }

  const { frames, leftover } = parseFrames(data);
  if (leftover) result.warnings.push(`${leftover} trailing bytes not forming a complete frame (stream still open or truncated)`);
  return decodeFramed(frames, format, encoding, result);
}

async function decodeFramed(frames, format, encoding, result) {
  for (const { flag, payload } of frames) {
    let p = payload;
    if (flag & 0x01) {
      try {
        p = await decompress(payload, encoding || 'gzip');
      } catch (e) {
        result.messages.push({ size: payload.length, error: `Compressed frame: ${e.message}`, hex: bytesToHex(payload, 256) });
        continue;
      }
    }
    if (!format.connect && flag & 0x80) {
      result.trailers = { ...(result.trailers || {}), ...parseTrailers(utf8Loose.decode(p)) };
    } else if (format.connect && flag & 0x02) {
      try {
        result.endStream = JSON.parse(utf8Loose.decode(p) || '{}');
      } catch (_) {
        result.endStream = { raw: utf8Loose.decode(p) };
      }
    } else {
      result.messages.push(decodeMessage(p, format.json));
    }
  }
  return result;
}

// Service and method from a /pkg.Service/Method path.
export function splitGrpcPath(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return { service: parts[parts.length - 2], method: parts[parts.length - 1] };
  } catch (_) {
    // not a URL
  }
  return { service: '', method: url };
}
