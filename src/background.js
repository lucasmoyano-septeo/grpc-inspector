// Relays captured events from content scripts to the DevTools panel of the same tab.
// Keeps a small per-tab buffer so calls made before the panel was opened still show up.
const MAX_BUFFERED = 3000;
const buffers = new Map(); // tabId -> events[]
const panels = new Map(); // tabId -> Set<Port>

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.kind !== 'grpc-evt' || !sender.tab) return;
  const tabId = sender.tab.id;
  const evt = { ...msg.evt, frameId: sender.frameId, frameUrl: sender.url };

  let buf = buffers.get(tabId);
  if (!buf) buffers.set(tabId, (buf = []));
  buf.push(evt);
  if (buf.length > MAX_BUFFERED) buf.splice(0, buf.length - MAX_BUFFERED);

  const ports = panels.get(tabId);
  if (ports) ports.forEach((p) => p.postMessage({ kind: 'evt', evt }));
});

chrome.runtime.onConnect.addListener((port) => {
  const m = /^panel:(\d+)$/.exec(port.name);
  if (!m) return;
  const tabId = Number(m[1]);
  let ports = panels.get(tabId);
  if (!ports) panels.set(tabId, (ports = new Set()));
  ports.add(port);

  port.postMessage({ kind: 'replay', events: buffers.get(tabId) || [] });

  port.onMessage.addListener((msg) => {
    if (msg && msg.kind === 'clear') buffers.delete(tabId);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (!ports.size) panels.delete(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));
