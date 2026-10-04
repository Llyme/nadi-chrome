// Runs src/extract.js against the fixture pages in a real (headless) Chromium browser and checks what it reads.
//   node test/run.mjs            (needs Edge or Chrome; set BROWSER=path to choose)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const exe = candidates.find((c) => existsSync(c));
if (!exe) throw new Error("no Edge or Chrome found: set BROWSER");

const extractSrc = readFileSync(path.join(root, "src/extract.js"), "utf8");
const server = createServer((req, res) => {
  // any /img/... is a picture
  if (req.url.startsWith("/img/")) return res.writeHead(200, { "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="#468"/></svg>');
  const file = path.join(root, "test/fixtures", req.url.replace(/^\//, "").split("?")[0]);
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9444;
const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1200,800", `--user-data-dir=${path.join(os.tmpdir(), "nadi-ext-test-" + Date.now())}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
  } catch (_) {}
  await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) waiting.get(d.id)(d.result || d.error), waiting.delete(d.id);
};
const call = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Page.enable");

async function read(name, scrollY = 0) {
  await call("Page.navigate", { url: `${base}/${name}` });
  await sleep(700);
  if (scrollY) await call("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrollY})` });
  await sleep(150);
  const r = await call("Runtime.evaluate", { expression: `(${"function(){"}${extractSrc}; return JSON.stringify(NADIExtract.extractPage(document, window)); })()`, returnByValue: true });
  if (r.exceptionDetails || !r.result) throw new Error(JSON.stringify(r));
  return JSON.parse(r.result.value);
}

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("ok   ", name);
  } catch (e) {
    failed++;
    console.log("FAIL ", name, "\n     ", e.message.split("\n")[0]);
  }
}

await test("recipe: JSON-LD is read in full", async () => {
  const p = await read("recipe.html");
  const r = p.ld.find((x) => x.type.includes("Recipe"));
  assert.ok(r, "no Recipe item");
  assert.equal(r.name, "Lemon garlic chicken");
  assert.equal(r.author, "Dana Lee");
  assert.equal(r.total, 45);
  assert.equal(r.ingredients, 5);
  assert.deepEqual(r.steps, ["Season the chicken.", "Sear skin-side down.", "Add lemon and bake."]);
  assert.equal(r.rating.value, 4.7);
  assert.ok(p.ld.some((x) => x.type.includes("BreadcrumbList") && x.crumbs[0] === "Dinner"));
  assert.equal(p.meta.site, "Tablemint");
});

await test("recipe: the nodes carry headings, paragraphs, items and buttons", async () => {
  const p = await read("recipe.html");
  assert.ok(p.nodes.some((n) => n.k === "h" && n.l === 1 && n.t === "Lemon garlic chicken"));
  assert.ok(p.nodes.some((n) => n.k === "h" && n.l === 2 && n.t === "Ingredients"));
  assert.equal(p.nodes.filter((n) => n.k === "li").length, 8);
  assert.ok(p.nodes.some((n) => n.k === "b" && n.t === "Print recipe"));
  assert.ok(p.nodes.some((n) => n.k === "p" && n.t.startsWith("A weeknight roast chicken")));
});

await test("news: author, time and section from the page's own metadata", async () => {
  const p = await read("news.html");
  assert.equal(p.meta.author, "Maria Okafor");
  assert.equal(p.meta.published, "2026-10-02T06:00:00Z");
  assert.equal(p.meta.section, "World");
  const a = p.ld.find((x) => x.type.includes("NewsArticle"));
  assert.equal(a.modified, "2026-10-02T07:22:00Z");
  assert.equal(a.publisher, "The Daily Ledger");
  // links in the nav are described, a link inside a paragraph is not a node of its own
  assert.ok(p.nodes.some((n) => n.k === "a" && n.t === "World"));
});

await test("how-to: every step heading is there, with where it sits", async () => {
  const p = await read("howto.html");
  const steps = p.nodes.filter((n) => n.k === "h" && /^Step \d/.test(n.t));
  assert.equal(steps.length, 4);
  assert.ok(steps[1].y > steps[0].y && steps[3].y > steps[2].y);
});

await test("product: offer and rating", async () => {
  const p = await read("product.html");
  const x = p.ld.find((i) => i.type.includes("Product"));
  assert.equal(x.offer.price, "129.00");
  assert.equal(x.offer.currency, "USD");
  assert.equal(x.offer.availability, "InStock");
  assert.equal(x.rating.count, 2310);
  assert.equal(p.meta.price, "129.00");
  assert.equal(p.meta.ogType, "product");
});

await test("wiki: infobox facts and the generator", async () => {
  const p = await read("wiki.html");
  assert.match(p.meta.generator, /MediaWiki/);
  assert.deepEqual(p.meta.facts[1], ["First flight", "2 July 1900"]);
});

await test("video: the player's own time and speed", async () => {
  const p = await read("video.html");
  assert.deepEqual({ cur: p.video.cur, dur: p.video.dur, paused: p.video.paused, rate: p.video.rate }, { cur: 936, dur: 1690, paused: false, rate: 1.25 });
  assert.equal(p.ld[0].length, 28);
});

await test("post: the picture of the post, not the avatar, the banner or the strip", async () => {
  const p = await read("post.html");
  assert.equal(p.img, `${base}/img/photo.jpg`);
});

await test("a page with no picture of its own gives its preview picture", async () => {
  const p = await read("og.html");
  assert.equal(p.img, `${base}/previews/hero.jpg`);
  assert.equal((await read("recipe.html")).img ?? null, null);
});

async function social(name, host, pathname) {
  await call("Page.navigate", { url: `${base}/${name}` });
  await sleep(500);
  const r = await call("Runtime.evaluate", { expression: `(${"function(){"}${extractSrc}; return JSON.stringify(NADIExtract.socialThread(document, { location: { hostname: ${JSON.stringify(host)}, pathname: ${JSON.stringify(pathname)} } })); })()`, returnByValue: true });
  if (r.exceptionDetails || !r.result) throw new Error(JSON.stringify(r));
  return JSON.parse(r.result.value);
}

await test("reddit: the post's numbers, and comments with their depth and who wrote them", async () => {
  const t = await social("reddit.html", "www.reddit.com", "/r/pcmasterrace/comments/1/a/");
  assert.equal(t.site, "reddit");
  assert.equal(t.author, "glasscannon");
  assert.equal(t.community, "r/pcmasterrace");
  assert.equal(t.up, 4213);
  assert.equal(t.comments, 312);
  assert.equal(t.text, "Translation layer, no emulation.");
  assert.deepEqual(t.list.map((c) => [c.a, c.d, c.s, c.op]), [["ferrule_", 0, 1800, false], ["glasscannon", 1, 640, true], ["lowtide77", 0, 950, false]]);
  assert.equal(t.list[0].t, "Frame times look better than I expected.");
});

await test("x: the first post, then the replies with their likes", async () => {
  const t = await social("x.html", "x.com", "/lanternworks/status/123");
  assert.equal(t.handle, "@lanternworks");
  assert.equal(t.text, "Patch 1.4 is out. Load times are halved.");
  assert.deepEqual([t.comments, t.reposts, t.likes, t.views], [84, 1203, 9800, 412000]);
  assert.deepEqual(t.list.map((c) => [c.a, c.s, c.op]), [["@marrowmoss", 312, false], ["@lanternworks", 204, true]]);
});

await test("hacker news: indent is the depth, scores are not shown", async () => {
  const t = await social("hn.html", "news.ycombinator.com", "/item");
  assert.equal(t.author, "kestrelwing");
  assert.equal(t.up, 512);
  assert.equal(t.comments, 203);
  assert.equal(t.community, "example.org");
  assert.deepEqual(t.list.map((c) => [c.a, c.d, c.s, c.op]), [["pondweed", 0, null, false], ["kestrelwing", 1, null, true]]);
});

await test("any other site has no thread", async () => {
  assert.equal(await social("news.html", "www.example.com", "/"), null);
});

await test("a guide: headings, paragraphs, lists, tables, bold and the neighbouring sections", async () => {
  const p = await read("guide.html");
  const g = p.guide;
  assert.ok(g, "a guide is read");
  assert.equal(g.text, false);
  const heads = g.blocks.filter((b) => b[0] === "h").map((b) => [b[1], b[2]]);
  assert.deepEqual(heads, [[2, "Walkthrough"], [3, "3/4 - 3/9"], [4, "3/4"], [4, "3/5"], [4, "3/6"], [5, "The cave"], [4, "3/7"]]);
  assert.ok(g.blocks.some((b) => b[0] === "p" && b[1].includes("**Harbor**")), "bold is kept");
  assert.ok(g.blocks.some((b) => b[0] === "p" && b[1].includes("Some of them repeat.\nThe first needs junk")), "a line break is kept");
  const ul = g.blocks.find((b) => b[0] === "ul");
  assert.deepEqual(ul[1], ["The crowd by the notice board.", "The man outside the chandler.", "The sailor near the pier"]);
  const tbl = g.blocks.find((b) => b[0] === "tbl");
  assert.deepEqual(tbl[1], [["Enemy", "Weak to"], ["Slime", "Fire"], ["Bat", "Wind"]]);
  assert.ok(!JSON.stringify(g.blocks).includes("Great guide"), "comments are not part of it");
  assert.ok(!JSON.stringify(g.blocks).includes("Table of Contents"), "the contents list is not part of it");
  assert.deepEqual([g.prev.t, g.next.t], ["2/1 - 2/28", "3/10 - 3/15"]);
  assert.ok(g.prev.u.endsWith("/games/harbor-quest/faqs/12/2-1-2-28") && g.next.u.endsWith("/3-10-3-15"));
  assert.deepEqual(g.toc.map((t) => [t.t, t.d]), [["Introduction", 0], ["Walkthrough", 0], ["2/1 - 2/28", 1], ["3/4 - 3/9", 1], ["3/10 - 3/15", 1]]);
});

await test("a plain-text FAQ is cut into headings, paragraphs, lists and a block of its own for the art", async () => {
  const p = await read("faq.html");
  const g = p.guide;
  assert.ok(g, "a guide is read");
  assert.equal(g.text, true);
  const heads = g.blocks.filter((b) => b[0] === "h").map((b) => [b[1], b[2]]);
  assert.deepEqual(heads, [[4, "[3.2] BOSS: THE GATEKEEPER"], [5, "PHASE 1"], [5, "PHASE 2 (below 50% HP)"], [5, "TURN ORDER"], [5, "TIPS"], [4, "[3.3] BOSS: THE SENTINEL"]]);
  const para = g.blocks.find((b) => b[0] === "p" && b[1].startsWith("The Gatekeeper opens"));
  assert.ok(para && !para[1].includes("\n"), "wrapped lines are joined");
  const pre = g.blocks.find((b) => b[0] === "pre" && b[1].includes("+--------+"));
  assert.ok(pre && pre[1].split("\n").length >= 7, "the table stays as it was");
  const tips = g.blocks.find((b) => b[0] === "ul");
  assert.deepEqual(tips[1], ["Bring a healer.", "Save before the door at the end of the hall. The boss follows you in.", "Fire is useless here."]);
  assert.ok(g.raw.startsWith("====="), "the original text is kept");
});

await test("a wiki article: the infobox as facts, sections, no edit marks, pictures or navigation", async () => {
  const p = await read("fandom.html");
  const g = p.guide;
  assert.ok(g, "an article is read");
  const facts = g.blocks.find((b) => b[0] === "facts");
  assert.deepEqual(facts[1], [["Name", "Lantern Keeper"], ["Other Names", "The Warden\nLight Bearer"], ["First Appears in", "Level 0"]]);
  const heads = g.blocks.filter((b) => b[0] === "h").map((b) => [b[1], b[2]]);
  assert.deepEqual(heads, [[2, "Appearance"], [2, "Location"], [2, "Trivia"], [3, "Quotes"], [2, "Gallery"]]);
  const all = JSON.stringify(g.blocks);
  for (const gone of ["edit", "Contents", "keeper at rest", "Keeper in the hall", "Entities:", "[1]", "Home"]) assert.ok(!all.includes(gone), gone + " is not part of it");
  assert.ok(g.blocks.some((b) => b[0] === "p" && b[1].startsWith("**Lantern Keepers** are an entity")));
  assert.ok(g.blocks.some((b) => b[0] === "p" && b[1].startsWith("**Danger Level: Friendly**")));
  assert.deepEqual(g.blocks.find((b) => b[0] === "tbl")[1], [["Level", "Chance"], ["0", "High"], ["1", "Low"]]);
  assert.deepEqual(g.blocks.find((b) => b[0] === "ul")[1], ["Added in the first update.", "Its lamp is a real prop."]);
});

await test("a guide's pictures: named in the text by a marker, the address kept apart, repeats and specks left out", async () => {
  const p = await read("rewards.html");
  const g = p.guide;
  assert.ok(g, "an article is read");
  const tbl = g.blocks.find((b) => b[0] === "tbl")[1];
  // the lazy picture is found by its real address, and every row's copy of it has one number
  const orb = /(\d+)\.64x64/.exec(tbl[1][2]);
  assert.ok(orb, "the icon of a cell is named: " + JSON.stringify(tbl[1]));
  assert.equal(/(\d+)\./.exec(tbl[2][2])[1], orb[1], "the same icon has the same number");
  assert.ok(tbl[1][2].includes("x80"), "its caption stays with it");
  assert.notEqual(/(\d+)\./.exec(tbl[1][3])[1], orb[1], "another icon has another number");
  const all = JSON.stringify(g.blocks);
  assert.ok(all.includes("200x120"), "a picture of its own is a block");
  const nums = [...JSON.stringify(g.blocks.filter((b) => b[0] === "p")).matchAll(/\uE000(\d+)\.64x64/g)].map((m) => m[1]);
  assert.equal(nums.length, 4);
  assert.equal(nums[0], nums[1], "one file asked for at two sizes is one picture");
  assert.equal(nums[2], nums[3], "a wiki's thumbnail and its original are one picture");
  assert.notEqual(nums[0], nums[2]);
  assert.ok(!all.includes("6x6") && !all.includes("pixel"), "a speck and a tracker are left out");
  assert.ok(!/http|png/.test(all), "no address leaves the page: " + all.slice(0, 200));
  const at = await call("Runtime.evaluate", { expression: `JSON.stringify(NADIExtract.guideImageAt(${orb[1]}))`, returnByValue: true });
  assert.ok(JSON.parse(at.result.value).src.endsWith("/img/orb.png"), "the number leads back to the address, here in the page");
});

await test("a page that is not a guide sends none", async () => {
  assert.equal((await read("news.html")).guide, null);
});

await test("a sign-in page is never described", async () => {
  const p = await read("login.html");
  assert.equal(p.blocked, true);
  assert.equal(p.nodes, undefined);
});

ws.close();
proc.kill();
server.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
