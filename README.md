# NADI Page Reader

A small Chromium extension (Chrome, Edge, Brave, Opera, Vivaldi) for [NADI](https://github.com/Llyme/not-another-dynamic-island),
the dynamic island for Windows. It tells NADI what kind of page you are on and where you are in it, so the
island can say "Step 3 of 7 · Add the site block", "12:34 left", "$129.00 · In stock" instead of just
"Browsing".

NADI reads a browser only through this extension: it is the page describing itself, exact, and it costs the
browser next to nothing. Without it, NADI's Page Reader switch stays locked.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`) and switch on **Developer mode**.
2. **Load unpacked** and pick this folder.
3. Start NADI. The popup of the extension says **Connected to NADI**, and the **Page Reader** switch in NADI's
   Settings > General unlocks.

The extension has a fixed ID (`ohnkmdlcpaeohlpncdmeoecpdffhcnjk`, from the `key` in `manifest.json`).

## What it sends, and what it does not

It talks **only to NADI on this PC**, over a WebSocket on `127.0.0.1` (ports 47653 to 47657). It makes no other
network request, loads no remote code and stores nothing but two switches (below). NADI only accepts a
connection that carries the `Origin` of a browser extension, which a web page cannot forge.

For the page in front of you it sends:

* the address and the title, the window's height, and the page's word count,
* the page's headings, short paragraphs (the first 260 characters), list items, buttons and links, with where
  they sit,
* its metadata: JSON-LD (`Recipe`, `Product`, `NewsArticle`, `HowTo`, `VideoObject`, `QAPage`...), Open Graph,
  author, dates, a wiki infobox,
* the state of its video (time, length, paused, speed).

It does **not** send:

* anything before NADI has said hello and sent its block list,
* anything from a private or incognito window (the extension is not allowed there),
* pages with a password or card field (sign-in and checkout pages), banking, mail, health and password-manager
  sites. For those it only tells NADI "this tab is not to be shown",
  without even the address,
* anything while it is paused (see the popup).

The popup also has **Never read this site** for the site in front of you.

## How it works

```
page ── content.js ──► background.js ──► ws://127.0.0.1:47653 ──► NADI (src-tauri/src/ext.rs)
         extract.js        block list          one JSON message per change
```

* `src/extract.js` reads the DOM into the picture above (no network, no storage; it is a plain script so the tests
  load it the same way).
* `src/content.js` runs it once the page has settled and again when the title, the address or a good part of the page
  changes (never more often than every 4 s), and sends tiny video updates in between. How far down the page you are is not followed. Every tab is read,
  so the cards of the pages you visited last are current, but a tab in the background at most every 20 s. When
  NADI connects, the open tabs are asked once, one every 250 ms. A tab that was open before the extension was installed or reloaded has no page script
  yet: it is put in then (the `scripting` permission), so every open tab is read at once without being clicked.
* `src/background.js` keeps the WebSocket open (a ping every 20 s keeps the service worker alive), applies the
  block list, and relays. NADI can ask it to press one of the page's own buttons ("Next", "Subscribe"...), but only
  those on a safe list that NADI sends, or to take the tab to another section of its guide (Previous, Next, the
  contents): only within the site the tab is on. The page is read again once it has loaded, so what the card
  shows is always what the page has.
* NADI decides what kind of page it is and what is worth saying. The classifier lives in the app (`pagekind.rs`),
  so it improves without updating the extension.

## Develop

```
npm test        # runs src/extract.js against test/fixtures in a headless Edge/Chrome
```

`tools/` has the script that made the key and the icons. `tools/extension-key.pem` is the private key; it is
ignored by git. If you publish to the Chrome Web Store the store assigns its own ID: NADI accepts any
`chrome-extension://` origin, so nothing needs to change.

## Protocol (version 1)

JSON text messages. Extension to NADI: `hello`, `page`, `video`, `active`, `gone`, `tabs`, `ping`,
`pressed`, `went`, `imgd`. NADI to extension: `config` (block list, safe buttons, on/off), `pong`, `press`, `go` (the tab goes to a page of the same site), `img` (a picture of the guide in a tab, by its number, shrunk to `max` px). In a guide's text a picture is a marker, ` number.WxH `; its address never leaves the browser. The page script first asks for its own copy (usually served from the browser's cache), else the background script fetches it (no cookies, no referrer), one at a time with a 120 ms pause after each download. It follows the "page images" setting. A `page` message
carries `nodes` (`h` heading with level `l`, `p` paragraph, `li`, `b` button, `a` link; each with `t` text and a
box `x y w h` relative to the window), `meta`, `ld`, `video`, `vh` (the window's height) and `words`. On a
guide (a walkthrough, a FAQ) it also carries `guide`: `blocks` (`["h", level, text]`, `["p", text]` with `**bold**`,
`["ul"|"ol", [items]]`, `["pre", text]`, `["tbl", [[cells]]]`, `["facts", [[label, value]]]` for a wiki's infobox), `prev` and `next` (`{t, u}`), `toc`, and for a
plain-text FAQ `raw`, about 60 KB at most.
