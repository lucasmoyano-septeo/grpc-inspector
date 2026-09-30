// Loads the unpacked extension in Chromium, drives the demo page and checks the panel.
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { start } from './server.mjs';

const ext = path.resolve('src');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grpc-insp-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto(base);
  for (const b of ['unary', 'text', 'stream', 'error', 'connect', 'plain']) await page.click(`#${b}`);
  await page.waitForFunction(() => document.getElementById('log').textContent.split('\n').length >= 7, null, { timeout: 10000 });

  const [tabId] = await sw.evaluate(() => [...buffers.keys()]); // tabs with captured calls
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html?tabId=${tabId}`);
  await panel.waitForFunction(() => document.querySelectorAll('#list tbody tr').length >= 5 && !document.querySelector('#list tr.pending'), null, { timeout: 10000 });

  const rows = await panel.$$eval('#list tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  console.table(rows);
  const byMethod = Object.fromEntries(rows.map((r) => [r[0].split('/').pop(), r]));
  assert.equal(rows.length, 5, 'plain fetch must be ignored');
  assert.equal(byMethod.GetUser[1], 'OK');
  assert.equal(byMethod.GetUser[2], '1 / 1');
  assert.equal(byMethod.GetUserText[1], 'OK');
  assert.equal(byMethod.GetUserText[2], '1 / 1');
  assert.equal(byMethod.WatchUsers[2], '1 / 3');
  assert.equal(byMethod.DeleteUser[1], '7 PERMISSION_DENIED');
  assert.equal(byMethod.ListUsers[1], 'OK');

  await panel.click(`#list tbody tr:has-text("WatchUsers")`);
  const detail = await panel.textContent('#detail');
  assert.match(detail, /Message #3/);
  assert.match(detail, /user-102@example.com/);
  assert.match(detail, /Trailers/);
  await panel.setViewportSize({ width: 1200, height: 700 });
  await panel.screenshot({ path: 'docs/screenshot.png' });
  console.log('e2e OK');
} finally {
  await ctx.close();
  server.close();
}
