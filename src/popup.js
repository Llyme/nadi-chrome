"use strict";
const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ t: "status" });
  const st = $("state");
  st.textContent = s.connected ? "Connected to NADI" : "NADI is not running";
  st.className = "state " + (s.connected ? "ok" : "off");
  $("hint").textContent = s.connected ? (s.paused ? "Reading is paused." : s.hostBlocked ? `${s.host} is never read.` : "Reading the page in front.") : "Start NADI on this PC and this connects by itself.";
  $("pause").setAttribute("aria-pressed", String(s.paused));
  $("pause").textContent = s.paused ? "Resume reading" : "Pause reading";
  $("site").hidden = !s.host;
  $("site").setAttribute("aria-pressed", String(s.hostBlocked));
  $("site").textContent = s.hostBlocked ? `Read ${s.host} again` : `Never read ${s.host || "this site"}`;
  return s;
}

$("pause").addEventListener("click", async () => {
  const s = await refresh();
  await chrome.runtime.sendMessage({ t: "set", values: { paused: !s.paused } });
  refresh();
});

$("site").addEventListener("click", async () => {
  const s = await refresh();
  const cur = (await chrome.storage.local.get({ blockedHosts: [] })).blockedHosts;
  const next = s.hostBlocked ? cur.filter((h) => h !== s.host) : [...new Set([...cur, s.host])];
  await chrome.runtime.sendMessage({ t: "set", values: { blockedHosts: next } });
  refresh();
});

refresh();
