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
  for (const b of ['unary', 'text', 'stream', 'error', 'connect', 'json', 'plain']) await page.click(`#${b}`);
  await page.waitForFunction(() => document.getElementById('log').textContent.split('\n').length >= 8, null, { timeout: 10000 });

  const [tabId] = await sw.evaluate(() => [...buffers.keys()]); // tabs with captured calls
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html?tabId=${tabId}`);
  await panel.waitForFunction(() => document.querySelectorAll('#list tbody tr').length >= 6 && !document.querySelector('#list tr.pending'), null, { timeout: 10000 });

  const rows = await panel.$$eval('#list tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  console.table(rows);
  const byMethod = Object.fromEntries(rows.map((r) => [r[0].split('/').pop(), r]));
  assert.equal(rows.length, 6, 'plain fetch must be ignored');
  assert.equal(byMethod.GetUser[1], 'OK');
  assert.equal(byMethod.GetUser[3], '1 / 1');
  assert.equal(byMethod.GetUserText[1], 'OK');
  assert.equal(byMethod.GetUserText[3], '1 / 1');
  assert.equal(byMethod.WatchUsers[3], '1 / 3');
  assert.equal(byMethod.DeleteUser[1], '7 PERMISSION_DENIED');
  assert.equal(byMethod.ListUsers[1], 'OK');

  const tab = async (name) => {
    await panel.click(`.tabs button[data-tab=${name}]`);
    return panel.textContent('#detail');
  };
  await panel.setViewportSize({ width: 1400, height: 800 });
  await panel.click(`#list tbody tr:has-text("WatchUsers")`);
  assert.match(await tab('preview'), /3 messages/);
  assert.match(await tab('protobuf'), /Message #3[\s\S]*user-102@example.com/);
  assert.match(await tab('headers'), /Trailers[\s\S]*grpc-status/);
  assert.match(await tab('timing'), /Messages \(3\)/);
  assert.match(await tab('response'), /"user-100@example.com"/);

  await panel.click(`#list tbody tr:has-text("GetPropertyData")`);
  const preview = await tab('preview');
  assert.match(preview, /JSON string/);
  assert.match(preview, /demo_sorolla/);
  await panel.click('.subbar button:has-text("Expand all")');
  assert.match(await panel.textContent('#detail'), /ROOM_0[\s\S]*Show 50 more/);
  await panel.click('.subbar input[type=search]');
  await panel.keyboard.type('ROOM_42');
  await panel.waitForFunction(() => /match/.test(document.querySelector('.subbar').textContent));
  assert.match(await panel.textContent('#detail'), /ROOM_42/);
  await panel.screenshot({ path: 'docs/screenshot.png' });
  await panel.fill('.subbar input[type=search]', '');
  await panel.waitForTimeout(300);
  await panel.screenshot({ path: 'docs/screenshot-preview.png' });
  await tab('response');
  await panel.screenshot({ path: 'docs/screenshot-response.png' });
  console.log('e2e OK');
} finally {
  await ctx.close();
  server.close();
}
