// Minimal protobuf / gRPC-Web encoder used only to build test fixtures.
const enc = new TextEncoder();

export function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

const key = (no, wt) => varint((no << 3) | wt);

// fields: [[no, value]] where value is number/bigint (varint), string, Uint8Array, or nested array (message)
export function message(fields) {
  const out = [];
  for (const [no, v] of fields) {
    if (typeof v === 'number' || typeof v === 'bigint') out.push(...key(no, 0), ...varint(v));
    else if (typeof v === 'string') {
      const b = enc.encode(v);
      out.push(...key(no, 2), ...varint(b.length), ...b);
    } else if (v instanceof Uint8Array) out.push(...key(no, 2), ...varint(v.length), ...v);
    else if (Array.isArray(v)) {
      const b = message(v);
      out.push(...key(no, 2), ...varint(b.length), ...b);
    } else if (v && v.double !== undefined) {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v.double, true);
      out.push(...key(no, 1), ...b);
    } else if (v && v.float !== undefined) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, v.float, true);
      out.push(...key(no, 5), ...b);
    }
  }
  return Uint8Array.from(out);
}

export function frame(payload, flag = 0) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

export const trailerFrame = (obj) =>
  frame(enc.encode(Object.entries(obj).map(([k, v]) => `${k}:${v}\r\n`).join('')), 0x80);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
