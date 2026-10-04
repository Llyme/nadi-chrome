// Runs in every page (top frame only). Reads the page with extract.js and tells the background script. Every
// tab is read, so the cards of the pages you visited last are up to date, but a tab in the background is read
// rarely. Cost is kept low on purpose: one read after the page has settled, again when the title, the address
// or a good part of the page changes (never more often than every few seconds in front, every 20 s behind),
// and tiny video updates in between. How far down the page you are is not followed.
(() => {
  "use strict";
  if (window.top !== window || !globalThis.NADIExtract) return;
  // (the background script also injects this into tabs that were open before the extension: not twice)
  // (a copy left by an earlier version of the extension has lost its connection: the new one takes over)
  if (globalThis.__nadiContent && globalThis.__nadiContent()) return;
  globalThis.__nadiContent = () => !!chrome.runtime?.id;
  const X = globalThis.NADIExtract;

  const MIN_GAP_MS = 4000; // two full reads of the page are never closer than this
  const MIN_GAP_HIDDEN_MS = 20000; // ... and in a background tab, never closer than this
  let lastRead = 0;
  let lastHref = location.href;
  let lastTitle = document.title;
  let timer = 0;
  let lastPage = null;

  const send = (m) => {
    try {
      chrome.runtime.sendMessage(m).catch(() => {});
    } catch (_) {
      /* the extension was reloaded: this script is orphaned and goes quiet */
    }
  };

  const shown = () => document.visibilityState === "visible";

  function read(why) {
    lastRead = Date.now();
    lastHref = location.href;
    lastTitle = document.title;
    let page;
    try {
      page = X.extractPage(document, window);
    } catch (e) {
      return;
    }
    lastPage = { t: "page", why, ...page };
    send(lastPage);
  }

  // read soon, but not more often than MIN_GAP_MS
  function later(why, ms) {
    clearTimeout(timer);
    const gap = shown() ? MIN_GAP_MS : MIN_GAP_HIDDEN_MS;
    const wait = Math.max(ms, gap - (Date.now() - lastRead));
    timer = setTimeout(() => read(why), Math.max(0, wait));
  }

  // ---- when to read
  later("load", 800);
  setTimeout(() => later("late", 0), 5000); // what the page builds after it has loaded

  document.addEventListener("visibilitychange", () => {
    if (shown()) later("shown", 150);
  });

  // single page apps change the address and the title without loading a page
  setInterval(() => {
    if (location.href !== lastHref || document.title !== lastTitle) later("navigated", 900);
  }, 1000);

  // a good part of the page changed (a feed loaded more, an article finished rendering)
  let mutations = 0;
  const mo = new MutationObserver((list) => {
    mutations += list.length;
    if (mutations > 40) {
      mutations = 0;
      later("changed", 2500);
    }
  });
  const watch = () => document.body && mo.observe(document.body, { childList: true, subtree: true });
  if (document.body) watch();
  else addEventListener("DOMContentLoaded", watch, { once: true });

  // ---- the video
  let videoAt = 0;
  const video = (force) => {
    const now = Date.now();
    if (!force && now - videoAt < (shown() ? 1000 : 3000)) return;
    videoAt = now;
    send({ t: "video", video: X.videoState(document) });
  };
  for (const ev of ["play", "pause", "seeked", "ratechange", "loadedmetadata", "ended"]) document.addEventListener(ev, () => video(true), true);
  document.addEventListener("timeupdate", () => video(false), true);

  // ---- the background script asks for the page now (a tab came to the front)
  // pressing one of the page's own buttons for NADI: only those on the safe list NADI sent, found by their text
  function press(label, safe) {
    const want = X.clean(label).toLowerCase();
    if (!want || !(safe || []).includes(want)) return false;
    for (const el of document.querySelectorAll("button,[role=button],a[href],input[type=button],input[type=submit]")) {
      const t = X.clean(el.getAttribute("aria-label") || el.value || el.textContent).toLowerCase();
      if (t === want && X.visible(el)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // ---- a picture of the guide, for the card (NADI asks by the marker's number when the card shows it)
  // First the page's own copy is asked for: the browser has it already (it drew it), so this is usually served from
  // its cache and costs no new download. The site may not allow the page to read it that way; then the address goes
  // back and the background script fetches it (without cookies, and without telling the site which page asked).
  const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
  const pictures = new Map(); // address and size -> data: address (the last few)
  const PICTURES_KEPT = 60;

  async function shrink(blob, max) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / bmp.width, 1200 / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext("2d");
    // (an icon keeps what is transparent; a bigger picture is a JPEG on the card's colour)
    const small = max <= 160;
    if (!small) {
      g.fillStyle = "#1c1c1e";
      g.fillRect(0, 0, w, h);
    }
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob(small ? { type: "image/png" } : { type: "image/jpeg", quality: 0.8 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${small ? "image/png" : "image/jpeg"};base64,` + btoa(bin);
  }

  async function guidePicture(no, max) {
    const g = X.guideImageAt(no);
    if (!g) return { ok: false };
    max = Math.max(32, Math.min(480, Math.round(max) || 128));
    const key = g.src + "|" + max;
    if (pictures.has(key)) return { ok: true, data: pictures.get(key), cached: true };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(g.src, { credentials: "omit", referrerPolicy: "no-referrer", cache: "force-cache", signal: ctl.signal });
      if (r.ok && /^image\/(jpeg|png|webp|gif|avif|bmp)/.test(r.headers.get("content-type") || "")) {
        const blob = await r.blob();
        if (blob.size <= IMAGE_MAX_BYTES) {
          const data = await shrink(blob, max);
          if (pictures.size >= PICTURES_KEPT) pictures.delete(pictures.keys().next().value);
          pictures.set(key, data);
          return { ok: true, data };
        }
      }
    } catch (_) {
      /* the site does not let the page read it: the background script will */
    } finally {
      clearTimeout(timer);
    }
    return { ok: false, src: g.src };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg) return false;
    if (msg.t === "img") {
      guidePicture(Number(msg.n), Number(msg.max)).then(reply);
      return true; // (the answer comes later)
    }
    if (msg.t === "snapshot") {
      // asked again within moments of a read: say the same thing again instead of reading twice
      if (lastPage && Date.now() - lastRead < 3000) send({ ...lastPage, why: "asked" });
      else read("asked");
      reply({ ok: true }); // (so the background script knows this tab has its page script)
    } else if (msg.t === "press") {
      reply({ ok: press(msg.label, msg.safe) });
    }
    return false;
  });
})();
