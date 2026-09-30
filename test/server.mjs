// Demo backend speaking gRPC-Web (binary + text) and Connect, for manual and e2e testing.
// Run: node test/server.mjs  → http://localhost:8787
import http from 'node:http';
import { message, frame, trailerFrame, concat } from './proto.mjs';

const user = (id) => message([[1, id], [2, `user-${id}@example.com`], [3, [[1, 'Ada'], [2, 'Lovelace']]], [4, 'admin'], [4, 'dev'], [5, 1727700000]]);

const page = `<!doctype html><meta charset="utf-8"><title>gRPC demo</title>
<h1>gRPC Inspector demo</h1>
<button id="unary">fetch grpc-web unary</button>
<button id="text">XHR grpc-web-text</button>
<button id="stream">fetch server stream</button>
<button id="error">grpc error</button>
<button id="connect">connect json</button>
<button id="json">json inside string</button>
<button id="plain">plain fetch (ignored)</button>
<pre id="log"></pre>
<script type="module">
const log = (m) => (document.getElementById('log').textContent += m + '\\n');
const frame = (p) => { const o = new Uint8Array(5 + p.length); new DataView(o.buffer).setUint32(1, p.length); o.set(p, 5); return o; };
const req = (id) => Uint8Array.from([0x08, id]);
const h = { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' };
document.getElementById('unary').onclick = async () => {
  const r = await fetch('/demo.v1.UserService/GetUser', { method: 'POST', headers: h, body: frame(req(7)) });
  log('unary ' + (await r.arrayBuffer()).byteLength);
};
document.getElementById('text').onclick = () => {
  const x = new XMLHttpRequest();
  x.open('POST', '/demo.v1.UserService/GetUserText');
  x.setRequestHeader('content-type', 'application/grpc-web-text');
  x.onload = () => log('text ' + x.responseText.length);
  let bin = ''; frame(req(9)).forEach((b) => (bin += String.fromCharCode(b)));
  x.send(btoa(bin));
};
document.getElementById('stream').onclick = async () => {
  const r = await fetch('/demo.v1.UserService/WatchUsers', { method: 'POST', headers: h, body: frame(req(1)) });
  const rd = r.body.getReader(); let n = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; }
  log('stream ' + n);
};
document.getElementById('error').onclick = async () => {
  await fetch('/demo.v1.UserService/DeleteUser', { method: 'POST', headers: h, body: frame(req(3)) });
  log('error done');
};
document.getElementById('connect').onclick = async () => {
  await fetch('/demo.v1.UserService/ListUsers', { method: 'POST', headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' }, body: JSON.stringify({ pageSize: 2 }) });
  log('connect done');
};
document.getElementById('json').onclick = async () => {
  await fetch('/demo.v1.PropertyService/GetPropertyData', { method: 'POST', headers: h, body: frame(req(5)) });
  log('json done');
};
document.getElementById('plain').onclick = async () => { await fetch('/api/plain'); log('plain done'); };
</script>`;

const b64 = (u8) => Buffer.from(u8).toString('base64');

export function start(port = 8787) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url;
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(page);
      }
      if (url === '/api/plain') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      const grpcHeaders = { 'content-type': 'application/grpc-web+proto', 'access-control-expose-headers': '*' };
      if (url.endsWith('/GetUser')) {
        res.writeHead(200, grpcHeaders);
        return res.end(concat(frame(user(7)), trailerFrame({ 'grpc-status': 0 })));
      }
      if (url.endsWith('/GetUserText')) {
        res.writeHead(200, { 'content-type': 'application/grpc-web-text+proto' });
        // two separately padded base64 chunks, like real grpc-web proxies send
        res.write(b64(frame(user(9))));
        return res.end(b64(trailerFrame({ 'grpc-status': 0 })));
      }
      if (url.endsWith('/WatchUsers')) {
        res.writeHead(200, grpcHeaders);
        let i = 0;
        const t = setInterval(() => {
          if (i < 3) res.write(frame(user(100 + i++)));
          else {
            clearInterval(t);
            res.end(trailerFrame({ 'grpc-status': 0 }));
          }
        }, 150);
        return;
      }
      if (url.endsWith('/GetPropertyData')) {
        const data = { demo_sorolla: { ticker: 'demo_sorolla', type: 'HOTEL', inventories: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`ROOM_${i}`, { ticker: `ROOM_${i}`, name: '1 adulto, Sólo alojamiento', active: true, order: i, discountTickers: ['A_agr', 'B_agr'] }])) } };
        res.writeHead(200, grpcHeaders);
        return res.end(concat(frame(message([[1, JSON.stringify(data, null, 2)], [2, 'es']])), trailerFrame({ 'grpc-status': 0 })));
      }
      if (url.endsWith('/DeleteUser')) {
        res.writeHead(200, { ...grpcHeaders, 'grpc-status': '7', 'grpc-message': 'caller%20cannot%20delete%20users' });
        return res.end();
      }
      if (url.endsWith('/ListUsers')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ users: [{ id: 1, email: 'a@example.com' }, { id: 2, email: 'b@example.com' }] }));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log('demo on http://localhost:8787'));
}
