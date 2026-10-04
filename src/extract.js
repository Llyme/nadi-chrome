// Reads what NADI needs to know about the page in front of you, from the page itself.
//
// It sends a *distilled* picture, not the page: the headings, short paragraphs, buttons and links with where
// they sit, the page's own metadata (JSON-LD, Open Graph), the state of its video, and how far down you are.
// NADI (the desktop app) decides what kind of page it is and what is worth saying; this file only reads.
// Nothing here talks to the network. It is a plain script (no modules) so the content script and the tests
// load it the same way, and everything it needs is passed in.
(function (root) {
  "use strict";

  const LIMITS = {
    nodes: 1400, // elements of the page that are described
    heading: 160,
    para: 260,
    item: 140,
    button: 60,
    link: 80,
    paras: 90, // paragraphs kept (the first ones, then the ones near you)
    ld: 8, // JSON-LD items
    names: 30, // step names and the like
    facts: 8,
    json: 200000, // the largest JSON-LD block that is parsed
    comments: 40, // comments of a post that are described (the ones the page has loaded)
    comment: 240, // characters of one comment
    post: 400, // characters of a post's own text
    guide: 60000, // characters of a guide that are passed on (a section of a long walkthrough is about this long)
    gblock: 2400, // one paragraph of a guide
    gitem: 500, // one list item of a guide
    grows: 40, // rows of a table in a guide
    gtoc: 80, // entries of a guide's contents list
  };

  const clean = (s, n) => {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return n && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  };

  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  // ---------------------------------------------------------------- the nodes
  const SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,button,[role=button],input[type=submit],input[type=button],a[href],time,figcaption,blockquote,summary";

  function visible(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  function nodeOf(el, win) {
    const tag = el.tagName.toLowerCase();
    let kind;
    let text;
    let level = 0;
    if (/^h[1-6]$/.test(tag)) {
      kind = "h";
      level = Number(tag[1]);
      text = clean(el.textContent, LIMITS.heading);
    } else if (tag === "p" || tag === "blockquote" || tag === "figcaption") {
      kind = "p";
      text = clean(el.textContent, LIMITS.para);
    } else if (tag === "li") {
      kind = "li";
      // a list item that only wraps a link or a nested list is described by what is inside it
      if (el.querySelector("ul,ol")) return null;
      text = clean(el.textContent, LIMITS.item);
    } else if (tag === "button" || tag === "input" || el.getAttribute("role") === "button" || tag === "summary") {
      kind = "b";
      text = clean(el.getAttribute("aria-label") || el.value || el.textContent, LIMITS.button);
    } else if (tag === "a") {
      // a link inside text is part of that text
      if (el.closest("p,li,h1,h2,h3,h4,h5,h6,button,[role=button],blockquote,figcaption")) return null;
      kind = "a";
      text = clean(el.getAttribute("aria-label") || el.textContent, LIMITS.link);
    } else if (tag === "time") {
      kind = "p";
      text = clean(el.textContent || el.getAttribute("datetime"), 60);
      if (el.closest("p")) return null;
    } else {
      return null;
    }
    if (!text) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { k: kind, l: level || undefined, t: text, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function collectNodes(doc, win) {
    const out = [];
    let paras = 0;
    const vh = win.innerHeight || 800;
    const els = doc.querySelectorAll(SELECTOR);
    for (let i = 0; i < els.length && out.length < LIMITS.nodes; i++) {
      const el = els[i];
      if (!visible(el)) continue;
      const n = nodeOf(el, win);
      if (!n) continue;
      if (n.k === "p") {
        // the opening paragraphs and the ones around you; the middle of a long page is not needed
        const near = n.y > -vh && n.y < vh * 2;
        if (paras >= LIMITS.paras && !near) continue;
        paras++;
      }
      out.push(n);
    }
    return out;
  }

  // ---------------------------------------------------------------- metadata
  function metaContent(doc, selectors) {
    for (const s of selectors) {
      const el = doc.querySelector(s);
      const v = el && (el.getAttribute("content") || el.getAttribute("value"));
      if (v && v.trim()) return clean(v, 200);
    }
    return null;
  }

  function personName(v) {
    const first = arr(v)[0];
    if (!first) return null;
    if (typeof first === "string") return clean(first, 80);
    return clean(first.name || "", 80) || null;
  }

  function duration(v) {
    // ISO 8601 "PT1H20M" -> minutes
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(String(v || ""));
    if (!m) return null;
    const mins = (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 60;
    return mins > 0 ? Math.round(mins) : null;
  }

  function offerOf(o) {
    const first = arr(o)[0];
    if (!first) return null;
    const price = first.price != null ? first.price : first.lowPrice;
    return {
      price: price != null ? String(price) : null,
      currency: first.priceCurrency || null,
      availability: clean(String(first.availability || "").replace(/^https?:\/\/schema\.org\//, ""), 40) || null,
    };
  }

  function ratingOf(r) {
    if (!r) return null;
    return { value: r.ratingValue != null ? Number(r.ratingValue) : null, count: Number(r.ratingCount || r.reviewCount || 0) || null };
  }

  function stepNames(v) {
    // recipeInstructions / HowTo.step: strings, HowToStep, HowToSection
    const out = [];
    const walk = (x) => {
      for (const s of arr(x)) {
        if (out.length >= LIMITS.names) return;
        if (typeof s === "string") out.push(clean(s, 90));
        else if (s && (s["@type"] === "HowToSection" || s.itemListElement) && s.itemListElement) walk(s.itemListElement);
        else if (s) out.push(clean(s.name || s.text || "", 90));
      }
    };
    walk(v);
    return out.filter(Boolean);
  }

  function ldItem(o) {
    const types = arr(o["@type"]).map(String);
    const t = (name) => types.includes(name);
    const item = { type: types.slice(0, 4), name: clean(o.headline || o.name || "", 160) || null };
    const author = personName(o.author) || personName(o.creator);
    if (author) item.author = author;
    if (o.datePublished) item.published = String(o.datePublished);
    if (o.dateModified) item.modified = String(o.dateModified);
    if (o.articleSection) item.section = clean(arr(o.articleSection)[0], 60);
    if (o.wordCount) item.words = Number(o.wordCount) || undefined;
    if (o.publisher && o.publisher.name) item.publisher = clean(o.publisher.name, 60);
    if (t("Recipe")) {
      item.total = duration(o.totalTime) || duration(o.cookTime) || null;
      item.prep = duration(o.prepTime);
      item.cook = duration(o.cookTime);
      item.yield = clean(arr(o.recipeYield)[0], 30) || null;
      item.ingredients = arr(o.recipeIngredient).length || null;
      item.steps = stepNames(o.recipeInstructions);
      item.rating = ratingOf(o.aggregateRating);
    }
    if (t("HowTo")) {
      item.total = duration(o.totalTime);
      item.steps = stepNames(o.step);
    }
    if (t("Product")) {
      item.offer = offerOf(o.offers);
      item.rating = ratingOf(o.aggregateRating);
      item.brand = clean((o.brand && o.brand.name) || o.brand || "", 40) || null;
    }
    if (t("VideoObject")) {
      item.length = duration(o.duration);
      item.uploaded = o.uploadDate ? String(o.uploadDate) : null;
    }
    if (t("QAPage") || t("Question")) {
      const q = t("Question") ? o : o.mainEntity || {};
      item.answers = Number(q.answerCount) || null;
      item.votes = q.upvoteCount != null ? Number(q.upvoteCount) : null;
      item.accepted = q.acceptedAnswer ? clean(q.acceptedAnswer.text || "", 140) : null;
    }
    if (t("FAQPage")) item.questions = arr(o.mainEntity).length || null;
    if (t("BreadcrumbList")) item.crumbs = arr(o.itemListElement).map((c) => clean((c.item && c.item.name) || c.name || "", 40)).filter(Boolean).slice(0, 8);
    return item;
  }

  function jsonLd(doc) {
    const out = [];
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      if (out.length >= LIMITS.ld) break;
      const txt = s.textContent || "";
      if (!txt || txt.length > LIMITS.json) continue;
      let data;
      try {
        data = JSON.parse(txt);
      } catch (_) {
        continue;
      }
      const stack = arr(data);
      while (stack.length && out.length < LIMITS.ld) {
        const o = stack.shift();
        if (!o || typeof o !== "object") continue;
        if (o["@graph"]) stack.unshift(...arr(o["@graph"]));
        if (o["@type"]) out.push(ldItem(o));
      }
    }
    return out;
  }

  function wikiFacts(doc) {
    const rows = doc.querySelectorAll("table.infobox tr");
    const out = [];
    for (const tr of rows) {
      if (out.length >= LIMITS.facts) break;
      const th = tr.querySelector("th");
      const td = tr.querySelector("td");
      if (th && td) {
        const k = clean(th.textContent, 40);
        const v = clean(td.textContent, 80);
        if (k && v) out.push([k, v]);
      }
    }
    return out;
  }

  function metadata(doc) {
    const m = {
      lang: (doc.documentElement.getAttribute("lang") || "").slice(0, 12) || null,
      site: metaContent(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']),
      ogType: metaContent(doc, ['meta[property="og:type"]']),
      author: metaContent(doc, ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="twitter:creator"]']),
      published: metaContent(doc, ['meta[property="article:published_time"]', 'meta[itemprop="datePublished"]', 'meta[name="date"]', 'meta[name="pubdate"]']),
      modified: metaContent(doc, ['meta[property="article:modified_time"]', 'meta[itemprop="dateModified"]']),
      section: metaContent(doc, ['meta[property="article:section"]']),
      generator: metaContent(doc, ['meta[name="generator"]']),
      description: metaContent(doc, ['meta[property="og:description"]', 'meta[name="description"]']),
      price: metaContent(doc, ['meta[property="product:price:amount"]', 'meta[property="og:price:amount"]']),
      currency: metaContent(doc, ['meta[property="product:price:currency"]', 'meta[property="og:price:currency"]']),
      canonical: (doc.querySelector('link[rel="canonical"]') || {}).href || null,
    };
    const timeEl = doc.querySelector("time[datetime]");
    if (!m.published && timeEl) m.published = timeEl.getAttribute("datetime");
    if (!m.author) {
      const a = doc.querySelector('[rel="author"], [itemprop="author"], .byline, .author');
      if (a) m.author = clean(a.textContent, 60).replace(/^by\s+/i, "") || null;
    }
    const facts = wikiFacts(doc);
    if (facts.length) m.facts = facts;
    return m;
  }

  // ---------------------------------------------------------------- a post and its comments
  // Reddit, X and Hacker News: the post's numbers and the comments the page has loaded, with their depth.
  // Anything else is not described (the card then shows the post only).
  const count = (v) => {
    if (v == null) return null;
    const m = String(v).replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
    if (!m) return null;
    const n = parseFloat(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
    return Math.round(n);
  };

  const timeOf = (el) => {
    const t = el && (el.matches("time[datetime]") ? el : el.querySelector("time[datetime]"));
    return t ? t.getAttribute("datetime") : null;
  };

  function redditThread(doc) {
    const post = doc.querySelector("shreddit-post");
    if (!post) return null;
    const out = {
      site: "reddit",
      author: post.getAttribute("author") || null,
      community: post.getAttribute("subreddit-prefixed-name") || null,
      posted: post.getAttribute("created-timestamp") || timeOf(post),
      up: count(post.getAttribute("score")),
      comments: count(post.getAttribute("comment-count")),
      list: [],
    };
    const body = post.querySelector('[slot="text-body"]');
    if (body) out.text = clean(body.textContent, LIMITS.post) || null;
    const sort = doc.querySelector("shreddit-sort-dropdown");
    if (sort) out.sort = clean(sort.getAttribute("selected-sort") || sort.textContent, 30) || null;
    for (const c of doc.querySelectorAll("shreddit-comment")) {
      if (out.list.length >= LIMITS.comments) break;
      const text = clean((c.querySelector('[slot="comment"]') || {}).textContent, LIMITS.comment);
      if (!text) continue;
      const a = c.getAttribute("author") || "";
      out.list.push({ a, t: text, s: count(c.getAttribute("score")), d: Number(c.getAttribute("depth")) || 0, op: !!a && a === out.author, at: timeOf(c) });
    }
    return out;
  }

  function xThread(doc, win) {
    if (!/\/status\/\d+/.test(win.location.pathname)) return null;
    const arts = [...doc.querySelectorAll('article[data-testid="tweet"]')];
    if (!arts.length) return null;
    const who = (a) => {
      const un = a.querySelector('[data-testid="User-Name"]');
      const t = un ? clean(un.textContent, 120) : "";
      return { name: t.split("@")[0].trim() || null, handle: (t.match(/@\w{1,15}/) || [null])[0] };
    };
    const stats = (a) => {
      const g = a.querySelector('[role="group"][aria-label]');
      const l = g ? g.getAttribute("aria-label") : "";
      const get = (w) => {
        const m = l.match(new RegExp("([\\d.,]+\\s*[KkMm]?)\\s+" + w, "i"));
        return m ? count(m[1]) : null;
      };
      return { replies: get("repl"), reposts: get("repost"), likes: get("like"), views: get("view") };
    };
    const main = arts[0];
    const w = who(main);
    const st = stats(main);
    const text = main.querySelector('[data-testid="tweetText"]');
    const out = { site: "x", author: w.name, handle: w.handle, posted: timeOf(main), text: text ? clean(text.textContent, LIMITS.post) : null, comments: st.replies, reposts: st.reposts, likes: st.likes, views: st.views, list: [] };
    for (const a of arts.slice(1)) {
      if (out.list.length >= LIMITS.comments) break;
      const t = a.querySelector('[data-testid="tweetText"]');
      const body = t ? clean(t.textContent, LIMITS.comment) : "";
      if (!body) continue;
      const u = who(a);
      out.list.push({ a: u.handle || u.name || "", t: body, s: stats(a).likes, d: 0, op: !!u.handle && u.handle === w.handle, at: timeOf(a) });
    }
    return out;
  }

  function hnThread(doc, win) {
    if (!/^\/item/.test(win.location.pathname)) return null;
    const head = doc.querySelector("tr.athing:not(.comtr)");
    if (!head) return null;
    const sub = head.nextElementSibling;
    const age = sub && sub.querySelector(".age");
    const subText = sub ? clean(sub.textContent, 300) : "";
    const out = {
      site: "hn",
      author: (sub && (sub.querySelector(".hnuser") || {}).textContent) || null,
      community: ((head.querySelector(".sitestr") || {}).textContent || "").trim() || null,
      posted: age ? (age.getAttribute("title") || "").split(" ")[0] || null : null,
      up: count((sub && sub.querySelector(".score") || {}).textContent),
      comments: count((subText.match(/(\d+)\s+comments?/) || [])[1]),
      sort: "Page order",
      list: [],
    };
    const top = doc.querySelector(".toptext");
    if (top) out.text = clean(top.textContent, LIMITS.post) || null;
    for (const row of doc.querySelectorAll("tr.athing.comtr")) {
      if (out.list.length >= LIMITS.comments) break;
      const text = clean((row.querySelector(".commtext") || {}).textContent, LIMITS.comment);
      if (!text) continue;
      const ind = row.querySelector("td.ind");
      const depth = ind ? Number(ind.getAttribute("indent")) || Math.round(((ind.querySelector("img") || {}).width || 0) / 40) : 0;
      const a = ((row.querySelector(".hnuser") || {}).textContent || "").trim();
      const at = row.querySelector(".age");
      out.list.push({ a, t: text, s: null, d: depth, op: !!a && a === out.author, at: at ? (at.getAttribute("title") || "").split(" ")[0] || null : null });
    }
    return out;
  }

  function socialThread(doc, win) {
    const host = win.location.hostname.replace(/^www\./, "");
    try {
      if (/(^|\.)reddit\.com$/.test(host)) return redditThread(doc);
      if (host === "x.com" || host === "twitter.com") return xThread(doc, win);
      if (host === "news.ycombinator.com") return hnThread(doc, win);
    } catch (_) {}
    return null;
  }

  // ---------------------------------------------------------------- the page's main picture
  // Only the address of the picture is found here; the background script fetches and shrinks it.
  const IMG_MIN = { w: 160, h: 90 };

  function httpUrl(u, base) {
    if (!u) return null;
    try {
      const x = new URL(u, base);
      return /^https?:$/.test(x.protocol) ? x.href : null;
    } catch (_) {
      return null;
    }
  }

  /** The biggest picture inside the post / article / main part of the page, else the page's own preview picture. */
  function pickImage(doc, win) {
    const base = win.location.href;
    const root = doc.querySelector('shreddit-post, article[data-testid="tweet"], article, [role="article"], main') || doc.body;
    let best = null;
    let bestArea = 0;
    if (root) {
      for (const img of root.querySelectorAll("img")) {
        if (img.closest("header, nav, footer, aside, [role=navigation], [role=banner]")) continue;
        const r = img.getBoundingClientRect();
        if (r.width < IMG_MIN.w || r.height < IMG_MIN.h) continue;
        // avatars and badges are round or tiny; ads and trackers are not what the post shows
        const radius = parseFloat(win.getComputedStyle(img).borderTopLeftRadius) || 0;
        if (radius >= Math.min(r.width, r.height) / 2 - 1) continue;
        if (!visible(img)) continue;
        const src = httpUrl(img.currentSrc || img.getAttribute("src") || "", base);
        if (!src) continue;
        const area = r.width * r.height;
        if (area > bestArea) {
          best = src;
          bestArea = area;
        }
      }
      if (!best) {
        const v = [...root.querySelectorAll("video[poster]")].find((x) => visible(x) && x.getBoundingClientRect().width >= IMG_MIN.w);
        if (v) best = httpUrl(v.poster, base);
      }
    }
    if (!best) best = httpUrl(metaContent(doc, ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]']) || "", base);
    return best;
  }


  // ---------------------------------------------------------------- a guide, laid out to be read
  // A walkthrough or a FAQ: its body as headings, paragraphs, lists and tables (bold text kept as **bold**), and
  // the neighbouring sections the page names. It works on any document, not only the one on screen, because the
  // extension reads the next section of a guide the same way when asked. It does not need the page to be laid out.
  const GUIDE_SKIP = new Set(["script", "style", "noscript", "svg", "nav", "aside", "footer", "form", "button", "select", "iframe", "canvas", "video", "audio", "input", "textarea", "label", "template"]);
  const GUIDE_BLOCK = new Set(["p", "ul", "ol", "pre", "table", "h1", "h2", "h3", "h4", "h5", "h6", "div", "section", "article", "main", "blockquote", "dl", "figure", "details", "summary", "header", "hr", "li", "dd", "dt", "center", "tr", "tbody", "thead", "td", "th"]);
  const GUIDE_ROOTS = ["#faqtxt", "#faqwrap", "[itemprop=articleBody]", "#mw-content-text .mw-parser-output", ".mw-parser-output", "article", "main", "[role=main]", "#content", ".content", "body"];
  // parts of a page that are not the guide or the article (a wiki's contents list, its pictures, its navigation boxes)
  const GUIDE_NOISE = /(^|[\s_-])(ftoc|toc|breadcrumbs?|share|sharing|social|comments?|related|advert\w*|ads?|promo|newsletter|cookie\w*|sidebar|pagination|gallery|thumb|thumbinner|navbox|catlinks|reflist|references|noprint|editsection|empty-elt|printfooter)([\s_-]|$)/i;
  // inside a line of text: the "[edit]" of a wiki's headings, footnote marks
  const INLINE_NOISE = /(^|[\s_-])(editsection|noprint|reference|mw-ref)([\s_-]|$)/i;

  // ---- the pictures inside a guide (a table's icons, a figure): each is named in the text by a marker,  id.WxH
  // , and its address stays here. NADI asks for one by its number when the card shows it (see content.js).
  // The numbers only grow (the same address keeps its number), so a card that is a little out of date still gets
  // the right picture.
  const GUIDE_IMGS = []; // number -> { src, w, h }
  const GUIDE_IMG_NO = new Map(); // address -> number
  const GUIDE_IMG_MAX = 400; // numbers given out before it starts over
  const IMG_NOT = /pixel|track|beacon|analytics|spacer|blank|1x1|emoji/i;
  // a marker, whole or cut short by a limit
  const noMark = (t) => String(t).replace(/[^]*(|$)/g, "");

  // The same file under different addresses is one picture: wikis ask for it at a size (".../revision/latest/
  // scale-to-width-down/64?cb=123", ".../thumb/a/ab/File.png/64px-File.png") and a query that changes with the visit.
  function pictureKey(src) {
    try {
      const u = new URL(src);
      const p = u.pathname.replace(/(\/revision\/latest)\/.*$/, "$1").replace(/\/thumb\/((?:[^/]+\/){2}[^/]+)\/[^/]+$/, "/$1");
      return u.origin + p;
    } catch (_) {
      return src;
    }
  }

  function guideImage(img, seen) {
    if (img.closest && img.closest("nav, header, footer, aside, [role=navigation], [role=banner], button")) return "";
    const attr = (n) => img.getAttribute(n) || "";
    // (a lazy page keeps the real address apart until the picture is near the screen)
    const src = httpUrl(attr("data-src") || attr("data-lazy-src") || attr("data-original") || img.currentSrc || attr("src"), img.baseURI);
    if (!src || IMG_NOT.test(src)) return "";
    let w = 0;
    let h = 0;
    try {
      const r = img.getBoundingClientRect();
      w = Math.round(r.width);
      h = Math.round(r.height);
    } catch (_) {}
    if (!w || !h) {
      w = parseInt(attr("width"), 10) || (img.naturalWidth > 1 ? img.naturalWidth : 0);
      h = parseInt(attr("height"), 10) || (img.naturalHeight > 1 ? img.naturalHeight : 0);
    }
    if ((w && w < 14) || (h && h < 14)) return ""; // bullets, spacers
    if (w > 480) {
      h = Math.round((h * 480) / w);
      w = 480;
    }
    const same = pictureKey(src);
    let no = GUIDE_IMG_NO.get(same);
    if (no === undefined) {
      if (seen.size >= 150) return "";
      if (GUIDE_IMGS.length >= GUIDE_IMG_MAX) {
        GUIDE_IMGS.length = 0;
        GUIDE_IMG_NO.clear();
      }
      no = GUIDE_IMGS.push({ src, w, h }) - 1;
      GUIDE_IMG_NO.set(same, no);
    }
    seen.add(no);
    return ` ${no}.${w || 0}x${h || 0} `;
  }
  let guideSeen = new Set(); // the numbers this reading of the guide has used

  function guideHidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const st = (el.getAttribute("style") || "").replace(/\s+/g, "");
    return /display:none|visibility:hidden/.test(st);
  }

  function guideNoise(el) {
    const cls = el.className && el.className.baseVal != null ? el.className.baseVal : el.className || "";
    return GUIDE_NOISE.test(String(cls)) || GUIDE_NOISE.test(el.id || "");
  }

  // the text of some nodes, with line breaks and **bold** kept
  function inlineOf(nodes) {
    let out = "";
    const add = (n) => {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/\s+/g, " ");
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === "br") {
        out += "\n";
        return;
      }
      if (tag === "img") {
        if (!guideHidden(n)) out += guideImage(n, guideSeen);
        return;
      }
      if (GUIDE_SKIP.has(tag) || tag === "sup" || guideHidden(n)) return;
      if (n.className && INLINE_NOISE.test(String(n.className.baseVal != null ? n.className.baseVal : n.className))) return;
      if (tag === "b" || tag === "strong") {
        const before = out.length;
        for (const c of n.childNodes) add(c);
        const inner = out.slice(before);
        out = out.slice(0, before) + (inner.trim() ? "**" + inner.trim() + "** " : inner);
        return;
      }
      for (const c of n.childNodes) add(c);
    };
    for (const n of nodes) add(n);
    return out;
  }

  function tidy(t, n) {
    t = String(t).replace(/\*\*\s*\*\*/g, "").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").replace(/ ([,.;:!?])/g, "$1").trim();
    return n && t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  }

  // ---- a plain-text FAQ: cut at its rules and section marks into headings and paragraphs
  const RULE = /^\s*([=\-_*#~+])\1{7,}\s*$/;
  const ART = /(\+[-=]{2,}\+|^\s*\|.*\|\s*$|[-=_*#~]{6,}|\S {3,}\S.*\S {3,}\S)/;
  const COLS = /\S {3,}\S/;
  const MARK = /^\s*[\[(]?\s*\d+(?:\.\d+)*\s*[\])]?[.:)]?\s+\S/;
  const BULLET = /^\s*(?:[-*•>]|\d{1,2}[.)])\s+\S/;

  function textBlocks(text, out) {
    const lines = String(text).replace(/\r/g, "").replace(/\t/g, "    ").split("\n");
    let para = [];
    let mono = [];
    let items = null;
    const size = () => out.reduce((a, b) => a + JSON.stringify(b).length, 0);
    const flushPara = () => {
      if (para.length) out.push(["p", tidy(para.join(" "), LIMITS.gblock)]);
      para = [];
    };
    const flushItems = () => {
      if (items && items.length) out.push(["ul", items.map((i) => tidy(i, LIMITS.gitem))]);
      items = null;
    };
    const flushMono = () => {
      if (mono.length) {
        const ind = Math.min(...mono.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
        out.push(["pre", mono.map((l) => l.slice(ind).trimEnd()).join("\n").trim()]);
      }
      mono = [];
    };
    const flushAll = () => {
      flushPara();
      flushItems();
      flushMono();
    };
    const isHeadingLine = (l) => {
      const t = l.trim();
      if (!t || t.length > 90 || ART.test(l)) return false;
      // (a note in brackets may be in lower case: "PHASE 2 (below 50% HP)")
      const core = t.replace(/\([^)]*\)/g, "").trim();
      const letters = core.replace(/[^A-Za-z]/g, "");
      return letters.length >= 4 && core === core.toUpperCase() && !/[.!?]$/.test(core);
    };
    for (let i = 0; i < lines.length; i++) {
      if (i % 200 === 0 && size() > LIMITS.guide) break;
      const l = lines[i];
      if (!l.trim()) {
        flushPara();
        flushItems();
        if (mono.length) mono.push("");
        continue;
      }
      if (RULE.test(l)) {
        flushAll();
        // a title between two rules
        const t = lines[i + 1];
        if (t && t.trim() && lines[i + 2] !== undefined && RULE.test(lines[i + 2]) && t.trim().length <= 120) {
          out.push(["h", 4, tidy(t, LIMITS.heading)]);
          i += 2;
        }
        continue;
      }
      if ((ART.test(l) || (mono.length && COLS.test(l))) && !BULLET.test(l)) {
        flushPara();
        flushItems();
        mono.push(l);
        continue;
      }
      if (mono.length) flushMono();
      const after = i === 0 || !lines[i - 1].trim() || RULE.test(lines[i - 1]);
      if (after && isHeadingLine(l)) {
        flushAll();
        out.push(["h", MARK.test(l) ? 4 : 5, tidy(l, LIMITS.heading)]);
        continue;
      }
      if (BULLET.test(l)) {
        flushPara();
        if (!items) items = [];
        items.push(l.replace(/^\s*(?:[-*•>]|\d{1,2}[.)])\s+/, ""));
        continue;
      }
      if (items && /^\s{2,}\S/.test(l)) {
        items[items.length - 1] += " " + l.trim();
        continue;
      }
      flushItems();
      para.push(l.trim());
    }
    flushAll();
  }

  function guideRoot(doc) {
    for (const sel of GUIDE_ROOTS) {
      const el = doc.querySelector(sel);
      if (el && (el.textContent || "").length >= 600) return el;
    }
    return null;
  }

  // a wiki's infobox as label and value pairs (Fandom's portable infobox, or a table with the class "infobox")
  function infoboxFacts(box) {
    const out = [];
    const add = (k, v) => {
      k = tidy(noMark(inlineOf(k.childNodes)).replace(/\*\*/g, ""), 40);
      v = tidy(noMark(inlineOf(v.childNodes)).replace(/\*\*/g, ""), 200);
      if (k && v && out.length < 24) out.push([k, v]);
    };
    if (box.tagName.toLowerCase() === "aside") {
      for (const d of box.querySelectorAll(".pi-data")) {
        const k = d.querySelector(".pi-data-label");
        const v = d.querySelector(".pi-data-value");
        if (k && v) add(k, v);
      }
    } else {
      for (const tr of box.querySelectorAll("tr")) {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        if (th && td) add(th, td);
      }
    }
    return out;
  }

  function walkGuide(parent, out, budget) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const t = tidy(inlineOf(run), LIMITS.gblock);
      if (t) push(["p", t]);
      run = [];
    };
    const push = (b) => {
      out.push(b);
      budget.used += JSON.stringify(b).length;
    };
    for (const n of parent.childNodes) {
      if (budget.used > LIMITS.guide) break;
      if (n.nodeType === 3) {
        run.push(n);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === "aside" && /portable-infobox/.test(String(n.className))) {
        flush();
        const facts = infoboxFacts(n);
        if (facts.length) push(["facts", facts]);
        continue;
      }
      if (GUIDE_SKIP.has(tag) || guideHidden(n)) continue;
      if (!GUIDE_BLOCK.has(tag)) {
        run.push(n);
        continue;
      }
      flush();
      if (guideNoise(n) && tag !== "pre" && tag !== "p") continue;
      if (/^h[1-6]$/.test(tag)) {
        const lvl = Number(tag[1]);
        const t = tidy(noMark(inlineOf(n.childNodes)).replace(/\*\*/g, ""), LIMITS.heading);
        if (t && lvl >= 2) push(["h", lvl, t]);
      } else if (tag === "p" || tag === "dd" || tag === "dt") {
        const t = tidy(inlineOf(n.childNodes), LIMITS.gblock);
        if (t) push(["p", t]);
      } else if (tag === "blockquote" || tag === "center") {
        if ([...n.children].some((c) => GUIDE_BLOCK.has(c.tagName.toLowerCase()))) walkGuide(n, out, budget);
        else {
          const t = tidy(inlineOf(n.childNodes), LIMITS.gblock);
          if (t) push(["p", t]);
        }
      } else if (tag === "ul" || tag === "ol") {
        const items = [];
        const addList = (list, depth) => {
          for (const li of list.children) {
            if (li.tagName.toLowerCase() !== "li" || guideHidden(li)) continue;
            const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)));
            const t = tidy(inlineOf(own), LIMITS.gitem);
            if (t) items.push(depth ? "– " + t : t);
            for (const sub of li.children) if (/^(ul|ol)$/i.test(sub.tagName)) addList(sub, depth + 1);
          }
        };
        addList(n, 0);
        if (items.length) push([tag, items.slice(0, 120)]);
      } else if (tag === "pre") {
        const txt = n.textContent || "";
        if (txt.trim().length > 40) {
          const before = out.length;
          textBlocks(txt, out);
          for (let i = before; i < out.length; i++) budget.used += JSON.stringify(out[i]).length;
        }
      } else if (tag === "table" && /(^|\s)infobox(\s|$)/.test(String(n.className))) {
        const facts = infoboxFacts(n);
        if (facts.length) push(["facts", facts]);
      } else if (tag === "table") {
        const rows = [];
        for (const tr of n.querySelectorAll("tr")) {
          if (rows.length >= LIMITS.grows) break;
          const cells = [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName)).map((c) => tidy(inlineOf(c.childNodes).replace(/\*\*/g, ""), 120));
          if (cells.some(Boolean)) rows.push(cells.slice(0, 8));
        }
        if (rows.length && rows.some((r) => r.length > 1)) push(["tbl", rows]);
        else for (const r of rows) push(["p", r.join(" ")]);
      } else if (tag !== "hr") {
        walkGuide(n, out, budget);
      }
    }
    flush();
  }

  function absUrl(u, base) {
    try {
      return new URL(u, base).href;
    } catch (_) {
      return null;
    }
  }

  const sameSite = (u, base) => {
    try {
      return new URL(u).origin === new URL(base).origin;
    } catch (_) {
      return false;
    }
  };

  const NAV_WORD = /^(next|prev|previous|back|»|«|›|‹)?\s*$/i;

  function nameOfLink(a, u) {
    let t = a ? clean(a.getAttribute("title") || a.textContent, 90) : "";
    t = t.replace(/^(next|previous|prev|back)\s*(section|page|part)?\s*[:\-–]?\s*/i, "").trim();
    if (!t || NAV_WORD.test(t)) {
      try {
        const seg = decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() || "");
        t = seg.replace(/[-_]+/g, " ").trim();
      } catch (_) {}
    }
    return clean(t, 90);
  }

  function neighbour(doc, base, rel) {
    const link = doc.querySelector(`link[rel~="${rel}"][href], a[rel~="${rel}"][href]`);
    let href = link && link.getAttribute("href");
    let anchor = null;
    if (!href) {
      anchor = doc.querySelector(`a.${rel}[href], a.toc_${rel}[href], a#${rel}[href]`);
      href = anchor && anchor.getAttribute("href");
    }
    const u = href ? absUrl(href, base) : null;
    if (!u || !sameSite(u, base) || u === base) return null;
    if (!anchor) {
      // the page's own link to it names it best ("Next: 8/17 - 8/18")
      for (const a of doc.querySelectorAll("a[href]")) {
        if (absUrl(a.getAttribute("href"), base) !== u) continue;
        const t = clean(a.textContent).replace(/^(next|previous|prev|back)\s*[:\-–]?\s*/i, "");
        if (t && !NAV_WORD.test(t)) {
          anchor = a;
          break;
        }
      }
    }
    return { t: nameOfLink(anchor, u) || "Section", u };
  }

  function guideToc(doc, base) {
    const root = doc.querySelector(".ftoc, #faqtoc, #toc, .toc, nav.toc, #table-of-contents");
    if (!root) return [];
    const out = [];
    for (const a of root.querySelectorAll("a[href]")) {
      if (out.length >= LIMITS.gtoc) break;
      const u = absUrl(a.getAttribute("href"), base);
      const t = clean(a.textContent, 90);
      if (!u || !t || !sameSite(u, base)) continue;
      let depth = 0;
      for (let p = a.parentElement; p && p !== root; p = p.parentElement) if (/^(ol|ul)$/i.test(p.tagName)) depth++;
      out.push({ t, u, d: Math.max(0, Math.min(3, depth - 1)) });
    }
    return out;
  }

  /** The guide the document holds, or null when there is not enough of one to read. */
  function guideOf(doc, base) {
    const root = guideRoot(doc);
    if (!root) return null;
    guideSeen = new Set();
    const out = [];
    const budget = { used: 0 };
    // a plain-text FAQ is one big block of preformatted text
    const bigPre = root.querySelector("pre");
    const pre = doc.querySelector("#faqtxt") || (bigPre && (bigPre.textContent || "").length > 3000 ? bigPre : null);
    let raw = null;
    let text = false;
    if (pre && (pre.textContent || "").length > 800) {
      text = true;
      raw = String(pre.textContent).replace(/\r/g, "").slice(0, 40000);
      textBlocks(pre.textContent, out);
    } else {
      walkGuide(root, out, budget);
    }
    const chars = out.reduce((a, b) => a + JSON.stringify(b).length, 0);
    if (out.length < 3 || chars < 400) return null;
    const g = { text, blocks: out, cut: chars > LIMITS.guide, prev: neighbour(doc, base, "prev"), next: neighbour(doc, base, "next"), toc: guideToc(doc, base), url: base };
    if (raw) g.raw = raw;
    return g;
  }

  const GUIDE_WORDS = /walkthrough|guide|faq|tutorial|how[\s-]?to|strategy|manual|playbook|cheat\s?sheet/i;
  function guideWanted(doc, win) {
    // (a wiki article is read the same way)
    return GUIDE_WORDS.test(doc.title || "") || GUIDE_WORDS.test(win.location.pathname || "") || !!doc.querySelector("#mw-content-text .mw-parser-output, .mw-parser-output");
  }

  // ---------------------------------------------------------------- the video, the scroll, the page's own text
  function videoState(doc) {
    let best = null;
    for (const v of doc.querySelectorAll("video")) {
      if (!(v.duration > 0) || !isFinite(v.duration)) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 120 * 80) continue;
      if (!best || area > best.area) best = { area, v };
    }
    if (!best) return null;
    const v = best.v;
    return { cur: Math.round(v.currentTime), dur: Math.round(v.duration), paused: v.paused, ended: v.ended, rate: v.playbackRate };
  }

  function wordCount(doc) {
    const root = doc.querySelector("article, main, [role=main]") || doc.body;
    if (!root) return 0;
    const text = root.textContent || "";
    return (text.match(/\S+/g) || []).length;
  }

  // a page with a password or a card field is never described: it is a login or a checkout
  function sensitive(doc) {
    for (const el of doc.querySelectorAll('input[type="password"], input[autocomplete*="cc-"], input[autocomplete="one-time-code"]')) {
      if (visible(el)) return true;
    }
    return false;
  }

  /** The whole picture of the page, or `{ blocked: true }` for one that must not be described. */
  function extractPage(doc, win) {
    const loc = win.location;
    if (sensitive(doc)) return { blocked: true, reason: "sensitive", url: loc.href, title: doc.title };
    return {
      url: loc.href,
      title: clean(doc.title, 200),
      vh: Math.round(win.innerHeight || 800),
      words: wordCount(doc),
      meta: metadata(doc),
      ld: jsonLd(doc),
      video: videoState(doc),
      nodes: collectNodes(doc, win),
      img: pickImage(doc, win),
      social: socialThread(doc, win),
      guide: guideWanted(doc, win) ? guideOf(doc, win.location.href) : null,
    };
  }

  /** The picture a guide's marker names: { src, w, h }, or null. */
  const guideImageAt = (no) => GUIDE_IMGS[no] || null;

  const api = { extractPage, videoState, visible, clean, socialThread, guideOf, guideImageAt, LIMITS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NADIExtract = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
