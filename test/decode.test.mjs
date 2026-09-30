import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBody, decodeProto, toPlain, decodeGrpcWebText, bytesToBase64 } from '../src/lib/decode.js';
import { message, frame, trailerFrame, concat } from './proto.mjs';
import { gzipSync } from 'node:zlib';

const sample = message([
  [1, 'hello'],
  [2, 150],
  [3, [[1, 'nested'], [2, -1]]],
  [4, 'a'],
  [4, 'b'],
  [5, { double: 3.25 }],
  [6, Uint8Array.from([0xff, 0x00, 0xfe])],
]);

test('decodes scalar, nested, repeated and double fields', () => {
  const plain = toPlain(decodeProto(sample));
  assert.equal(plain['1'], 'hello');
  assert.equal(plain['2'], 150);
  assert.deepEqual(plain['3'], { 1: 'nested', 2: '18446744073709551615' });
  assert.deepEqual([...plain['4']], ['a', 'b']);
  assert.equal(plain['5'], 3.25);
  assert.equal(plain['6'], '/wD+');
});

test('negative int64 exposes signed view', () => {
  const [f] = decodeProto(message([[1, -5]]));
  assert.equal(f.int64, '-5');
});

test('grpc-web binary: messages + trailers', async () => {
  const body = concat(frame(sample), frame(message([[1, 'second']])), trailerFrame({ 'grpc-status': 3, 'grpc-message': 'bad%20arg' }));
  const r = await decodeBody(body, 'application/grpc-web+proto');
  assert.equal(r.messages.length, 2);
  assert.equal(r.trailers['grpc-status'], '3');
  assert.equal(r.trailers['grpc-message'], 'bad arg');
});

test('grpc-web-text with separately padded chunks', async () => {
  const a = bytesToBase64(frame(message([[1, 'x']])));
  const b = bytesToBase64(trailerFrame({ 'grpc-status': 0 }));
  const bytes = new TextEncoder().encode(a + b);
  assert.ok(decodeGrpcWebText(bytes).length > 0);
  const r = await decodeBody(bytes, 'application/grpc-web-text');
  assert.equal(r.messages.length, 1);
  assert.equal(r.trailers['grpc-status'], '0');
});

test('gzip-compressed frame', async () => {
  const body = frame(new Uint8Array(gzipSync(sample)), 0x01);
  const r = await decodeBody(body, 'application/grpc-web+proto', 'gzip');
  assert.equal(toPlain(r.messages[0].fields)['1'], 'hello');
});

test('connect unary proto and json', async () => {
  const p = await decodeBody(sample, 'application/proto');
  assert.equal(toPlain(p.messages[0].fields)['1'], 'hello');
  const j = await decodeBody(new TextEncoder().encode('{"a":1}'), 'application/json');
  assert.deepEqual(j.messages[0].json, { a: 1 });
});

test('connect streaming end-stream frame', async () => {
  const end = new TextEncoder().encode('{"error":{"code":"not_found","message":"nope"}}');
  const r = await decodeBody(concat(frame(sample), frame(end, 0x02)), 'application/connect+proto');
  assert.equal(r.messages.length, 1);
  assert.equal(r.endStream.error.code, 'not_found');
});

test('partial stream reports leftover bytes', async () => {
  const full = concat(frame(sample), frame(sample));
  const r = await decodeBody(full.subarray(0, full.length - 3), 'application/grpc-web');
  assert.equal(r.messages.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('invalid protobuf does not throw', async () => {
  const r = await decodeBody(frame(Uint8Array.from([0xff, 0xff, 0xff])), 'application/grpc-web');
  assert.ok(r.messages[0].error);
});
