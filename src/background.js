// The extension's background script. It keeps one WebSocket open to the NADI desktop app on this PC
// (ws://127.0.0.1, nothing else is ever contacted), and relays what the content scripts read from the page in
// front. Until NADI has said hello and sent its block list, nothing is sent at all.
"use strict";

const PORTS = [47653, 47654, 47655, 47656, 47657];
const PROTOCOL = 1;
const KEEPALIVE_MS = 20000;

let ws = null;
let config = null; // what NADI sent: block list, safe buttons
let port = 0;
let connecting = false;
let retryMs = 1000;
let focusedWindow = -1;
let listTimer = 0;

const manifest = chrome.runtime.getManifest();

// ---------------------------------------------------------------- settings of this extension (in this browser)
async function local() {
  const v = await chrome.storage.local.get({ paused: false, blockedHosts: [] });
  return v;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

// ---------------------------------------------------------------- the block list (NADI's, plus this browser's own)
function isBlocked(url, title, own) {
  const host = hostOf(url);
  if (!host) return true;
  if (own.blockedHosts.some((h) => host === h || host.endsWith("." + h))) return true;
  if (!config) return true;
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (_) {}
  if (config.hosts.some((h) => host === h || host.endsWith("." + h))) return true;
  if (config.hostWords.some((w) => host.includes(w))) return true;
  const t = String(title || "").toLowerCase();
  if (config.titleWords.some((w) => t.includes(w))) return true;
  return config.custom.some((c) => host.includes(c) || path.includes(c) || (c.length >= 3 && t.includes(c)));
}

// ---------------------------------------------------------------- the connection
function browserId() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const names = brands.map((b) => b.brand);
  if (navigator.brave) return "brave";
  if (names.some((n) => /edge/i.test(n))) return "msedge";
  if (names.some((n) => /opera/i.test(n))) return "opera";
  if (names.some((n) => /vivaldi/i.test(n))) return "vivaldi";
  return "chrome";
}

function open(p) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${p}`);
    const timeout = setTimeout(() => {
      try {
        s.close();
      } catch (_) {}
      reject(new Error("timeout"));
    }, 1500);
    s.onopen = () => {
      clearTimeout(timeout);
      resolve(s);
    };
    s.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("refused"));
    };
  });
}

async function connect() {
  if (ws || connecting) return;
  connecting = true;
  let s = null;
  for (const p of PORTS) {
    try {
      s = await open(p);
      port = p;
      break;
    } catch (_) {}
  }
  connecting = false;
  if (!s) {
    retryMs = Math.min(retryMs * 2, 5000); // loopback: trying again is cheap, and NADI may be just starting
    setTimeout(connect, retryMs);
    return;
  }
  retryMs = 1000;
  ws = s;
  s.onmessage = (e) => onApp(e.data);
  s.onclose = () => {
    ws = null;
    config = null;
    port = 0;
    setTimeout(connect, 1000);
  };
  s.onerror = () => {};
  s.send(JSON.stringify({ t: "hello", v: PROTOCOL, browser: browserId(), ext: manifest.version, id: chrome.runtime.id }));
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

setInterval(() => send({ t: "ping" }), KEEPALIVE_MS);
chrome.alarms.create("nadi-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "nadi-reconnect" && !ws) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------------------------------------------------------------- what NADI says
async function onApp(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch (_) {
    return;
  }
  if (m.t === "config") {
    config = {
      enabled: m.enabled !== false,
      hosts: (m.hosts || []).map(String),
      hostWords: (m.hostWords || []).map(String),
      titleWords: (m.titleWords || []).map(String),
      custom: (m.custom || []).map((s) => String(s).toLowerCase()).filter(Boolean),
      safe: (m.safe || []).map((s) => String(s).toLowerCase()),
      images: m.images !== false,
    };
    if (!config.images) images.clear();
    // now that the block list is known: ask the tabs for their picture, and list them
    askAll();
    sendTabs();
  } else if (m.t === "press") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    let ok = false;
    if (tab) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { t: "press", label: String(m.label || ""), safe: config ? config.safe : [] });
        ok = !!(r && r.ok);
      } catch (_) {}
    }
    send({ t: "pressed", id: m.id, ok });
  } else if (m.t === "img") {
    if (config && config.enabled && config.images) {
      pictureQueue.push(m);
      runPictures();
    } else {
      send({ t: "imgd", id: m.id, ok: false });
    }
  } else if (m.t === "go") {
    // another section of a guide: the tab itself goes there (the page stays the source of truth: it is read again
    // when it has loaded). Only within the site the tab is on, and only to a web address.
    let ok = false;
    try {
      const tab = await chrome.tabs.get(Number(m.tab));
      const to = new URL(String(m.url || ""), tab.url);
      if (!tab.incognito && /^https?:$/.test(to.protocol) && to.origin === new URL(tab.url).origin) {
        await chrome.tabs.update(tab.id, { url: to.href });
        ok = true;
      }
    } catch (_) {}
    send({ t: "went", id: m.id, tab: Number(m.tab), ok });
  }
}

// A tab that was open before this extension was installed (or reloaded) has no page script yet: it is put in
// now, and reads the page by itself, so nothing has to be clicked, reloaded or switched to for NADI to see it.
async function askSnapshot(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { t: "snapshot" });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/extract.js", "src/content.js"] });
    } catch (_) {
      /* a page the browser does not let extensions into (its own store, an error page) */
    }
  }
}

// Every open tab is asked once, the ones in front first and one every 250 ms, so there is no burst of work.
// (A tab that was discarded, or loaded before the extension was, has no page script to answer: it is skipped,
// and answers by itself when it loads.)
let asking = false;
async function askAll() {
  if (asking) return;
  asking = true;
  try {
    const own = await local();
    const tabs = (await chrome.tabs.query({})).filter((t) => !t.incognito && !t.discarded && /^https?:/.test(t.url || "") && !isBlocked(t.url, t.title, own));
    tabs.sort((a, b) => Number(b.active) - Number(a.active));
    for (const t of tabs) {
      askSnapshot(t.id);
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    asking = false;
  }
}

// ---------------------------------------------------------------- the page's picture
// The content script finds the address of the page's main picture; it is fetched here (without cookies and
// without telling the site which page asked), shrunk to a small JPEG and sent to NADI as bytes, so the app never
// contacts the site itself. Only the tab in front is fetched; a tab keeps the picture of the address it had.
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const images = new Map(); // tab id -> { url, data }

async function thumbnail(url, max = 480) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal });
    if (!r.ok || !/^image\/(jpeg|png|webp|gif|avif|bmp)/.test(r.headers.get("content-type") || "")) return null;
    if (Number(r.headers.get("content-length") || 0) > IMAGE_MAX_BYTES) return null;
    const blob = await r.blob();
    if (blob.size > IMAGE_MAX_BYTES) return null;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / bmp.width, 1200 / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext("2d");
    // (a small one is an icon: it keeps what is transparent; the main picture is a JPEG on the card's colour)
    const small = max <= 160;
    if (!small) {
      g.fillStyle = "#1c1c1e"; // what shows through a transparent picture
      g.fillRect(0, 0, w, h);
    }
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob(small ? { type: "image/png" } : { type: "image/jpeg", quality: 0.74 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${small ? "image/png" : "image/jpeg"};base64,` + btoa(bin);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImage(tab, url) {
  images.set(tab.id, { url, data: null }); // a picture that fails is not tried again for this address
  const data = await thumbnail(url);
  const cur = images.get(tab.id);
  if (!data || !cur || cur.url !== url || !config || !config.images) return;
  cur.data = data;
  send({ t: "image", tab: tab.id, win: tab.windowId, image: data });
}

// ---------------------------------------------------------------- the pictures inside a guide
// NADI asks for them one at a time, as the card shows them. They are done in a line, a short pause after each one that
// needed the network, so a page with many icons does not make a burst of requests to its site.
const PICTURE_GAP_MS = 120;
const fetched = new Map(); // address and size -> data: address (the last few that came from here)
const pictureQueue = [];
let picturing = false;

async function guidePicture(m) {
  let data = null;
  let waited = false;
  try {
    const r = await chrome.tabs.sendMessage(Number(m.tab), { t: "img", n: Number(m.n), max: Number(m.max) });
    if (r && r.data) {
      data = r.data;
      waited = !r.cached;
    } else if (r && r.src) {
      const max = Math.max(32, Math.min(480, Math.round(Number(m.max)) || 128));
      const key = r.src + "|" + max;
      if (fetched.has(key)) data = fetched.get(key);
      else {
        waited = true;
        data = await thumbnail(r.src, max);
        if (data) {
          if (fetched.size >= 60) fetched.delete(fetched.keys().next().value);
          fetched.set(key, data);
        }
      }
    }
  } catch (_) {}
  send({ t: "imgd", id: m.id, ok: !!data, data });
  return waited;
}

async function runPictures() {
  if (picturing) return;
  picturing = true;
  try {
    while (pictureQueue.length) {
      const waited = await guidePicture(pictureQueue.shift());
      if (waited) await new Promise((r) => setTimeout(r, PICTURE_GAP_MS));
    }
  } finally {
    picturing = false;
  }
}

// ---------------------------------------------------------------- what the pages say
async function fromPage(msg, tab) {
  if (!ws || !config || !config.enabled || !tab) return;
  const own = await local();
  if (own.paused) return;
  if (tab.incognito) return;
  const base = { tab: tab.id, win: tab.windowId, active: !!tab.active, focused: tab.windowId === focusedWindow };
  if (msg.t === "page") {
    if (msg.blocked || isBlocked(msg.url, msg.title, own)) {
      // not even the address leaves the browser: NADI is only told that this tab is not to be shown
      send({ t: "page", ...base, blocked: true });
      images.delete(tab.id);
      return;
    }
    const img = msg.img;
    delete msg.img; // the address of the picture stays in the browser
    const out = { ...msg, ...base };
    if (config.images && img) {
      const have = images.get(tab.id);
      if (have && have.url === img) out.image = have.data;
      else if (tab.active) fetchImage(tab, img);
    } else {
      images.delete(tab.id);
    }
    send(out);
  } else if (msg.t === "video") {
    send({ ...msg, ...base });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.t === "status") {
    local().then(async (own) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      reply({ connected: !!ws && !!config, port, paused: own.paused, host: tab ? hostOf(tab.url) : "", hostBlocked: tab ? own.blockedHosts.includes(hostOf(tab.url)) : false, version: manifest.version });
    });
    return true;
  }
  if (msg && msg.t === "set") {
    chrome.storage.local.set(msg.values).then(() => {
      reply({ ok: true });
      sendTabs();
      send({ t: "refresh" });
    });
    return true;
  }
  if (sender.tab) fromPage(msg, sender.tab);
  return false;
});

// ---------------------------------------------------------------- tabs and windows
async function sendTabs() {
  if (!ws || !config) return;
  const own = await local();
  if (own.paused || !config.enabled) {
    send({ t: "tabs", list: [] });
    return;
  }
  const tabs = await chrome.tabs.query({});
  const list = tabs
    .filter((t) => !t.incognito && /^https?:/.test(t.url || "") && !isBlocked(t.url, t.title, own))
    .map((t) => ({ tab: t.id, win: t.windowId, title: t.title || "", active: !!t.active }));
  send({ t: "tabs", list });
}

function tabsSoon() {
  clearTimeout(listTimer);
  listTimer = setTimeout(sendTabs, 800);
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  send({ t: "active", tab: tabId, win: windowId });
  askSnapshot(tabId);
  tabsSoon();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  images.delete(tabId);
  send({ t: "gone", tab: tabId });
  tabsSoon();
});
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.title || change.url) tabsSoon();
});
chrome.windows.onFocusChanged.addListener((id) => {
  focusedWindow = id;
  send({ t: "window", focused: id });
});
chrome.windows.getLastFocused().then((w) => {
  if (w && w.focused) focusedWindow = w.id;
}).catch(() => {});
