// JungleCoach front end (vanilla JS, no build step)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const vid = $("#vid");
const cap = document.createElement("video"); // hidden twin used for frame capture
cap.muted = true;
cap.preload = "auto";
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

const DEFAULT_MINIMAP = { x: 0.78, y: 0.6, w: 0.22, h: 0.4 };
const SETUP_FIELDS = ["champion", "enemyJungler", "allies", "enemies", "side", "rank", "patch", "goals"];

const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
  },
};

let coaches = [];
let prefs = store.get("jc:prefs", { setup: {}, panel: ["xun", "inspired", "canyon", "oner"], lead: "", minimap: DEFAULT_MINIMAP, riotId: "", region: "americas" });
let vodKey = null;
let vod = { moments: [], offset: null, riot: null };
let currentReviewId = null;
let busy = false;

const savePrefs = () => store.set("jc:prefs", prefs);
const saveVod = () => vodKey && store.set(vodKey, vod);

// ---------------------------------------------------------------- utils
const fmt = (sec) => {
  if (sec == null || isNaN(sec)) return "--:--";
  const neg = sec < 0;
  sec = Math.abs(Math.floor(sec));
  return `${neg ? "-" : ""}${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};
const gameTime = (vodSec) => (vod.offset == null ? null : fmt(vodSec - vod.offset));
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uid = () => Math.random().toString(36).slice(2, 10);

function renderMd(el, text) {
  const visible = text.replace(/```coach-data[\s\S]*?(```|$)/g, "").trim();
  el.innerHTML = window.marked ? marked.parse(escapeHtml(visible)) : `<pre>${escapeHtml(visible)}</pre>`;
  for (const h of $$("h3", el)) {
    const c = coaches.find((c) => h.textContent.toLowerCase().includes(c.name.toLowerCase()));
    if (c) h.classList.add(`c-${c.id}`);
  }
}

function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== name));
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------------------------------------------------------------- status & settings
const ENGINE_NAMES = { claudecode: "Claude Code (subscription)", ollama: "Local AI (Ollama)", anthropic: "Claude API" };
let status = null;

async function loadStatus() {
  status = await fetch("/api/status").then((r) => r.json());
  const s = status;
  const pc = $("#pillClaude"), pr = $("#pillRiot");
  const ok = s.ready[s.selected];
  pc.textContent = `Engine: ${ENGINE_NAMES[s.selected]}${ok ? "" : " (needs setup)"}`;
  pc.className = `pill ${ok ? "ok" : "bad"}`;
  pc.onclick = () => openEngineDialog();
  pr.textContent = s.riot ? "Riot data: ready" : "Riot data: off";
  pr.className = `pill ${s.riot ? "ok" : ""}`;
  return s;
}

function renderEngineDialog() {
  const s = status;
  $$('input[name="engine"]').forEach((r) => (r.checked = r.value === s.selected));
  // Claude Code
  const cc = s.claudecode;
  $("#stCC").innerHTML = !cc.found
    ? `<span class="no">✗ Claude Code not found.</span> Install it from claude.com/claude-code, then reopen this dialog.`
    : cc.loggedIn
      ? `<span class="ok">✓ Ready: logged in with your Claude account.</span>`
      : `<span class="no">✗ Not logged in yet.</span> Click <b>Log in to Claude</b> and sign in with the same account you use for Claude. Then reopen this dialog.`;
  $("#btnCCLogin").hidden = !cc.found || cc.loggedIn;
  $("#sCCModel").value = cc.model || "opus";
  // Ollama
  const ol = s.ollama;
  const vision = ol.models.filter((m) => m.vision);
  $("#stOllama").innerHTML = !ol.running
    ? `<span class="no">✗ Ollama isn't running.</span> One-time setup: install it from <b>ollama.com</b> (or run <code>winget install Ollama.Ollama</code>), then run <code>ollama pull qwen2.5vl:7b</code>.`
    : !vision.length
      ? `<span class="no">✗ No vision model installed.</span> Run <code>ollama pull qwen2.5vl:7b</code> (best for a 6-8 GB GPU) or <code>ollama pull gemma3:4b</code> (faster, lighter).`
      : `<span class="ok">✓ Ready: ${vision.length} vision model(s) installed.</span>`;
  $("#ollamaModels").hidden = !vision.length;
  const opt = (m, sel) => `<option value="${escapeHtml(m.name)}" ${m.name === sel ? "selected" : ""}>${escapeHtml(m.name)} (${m.sizeGB} GB)</option>`;
  $("#sOVision").innerHTML = vision.map((m) => opt(m, ol.visionModel)).join("");
  $("#sOCoach").innerHTML = `<option value="">same as vision model</option>` + ol.models.map((m) => opt(m, ol.coachModel)).join("");
}

async function openEngineDialog() {
  await loadStatus();
  renderEngineDialog();
  if (!$("#settingsDlg").open) $("#settingsDlg").showModal();
}
$("#btnSettings").onclick = openEngineDialog;
$("#btnCCLogin").onclick = async () => {
  const r = await fetch("/api/claudecode/login", { method: "POST" });
  $("#stCC").innerHTML = r.ok
    ? `A sign-in window/browser tab should open. Finish signing in there, then <a href="#" id="ccRecheck">check again</a>.`
    : `<span class="no">Couldn't start the login.</span>`;
  $("#ccRecheck")?.addEventListener("click", (e) => { e.preventDefault(); openEngineDialog(); });
};
$("#settingsDlg").addEventListener("close", async () => {
  if ($("#settingsDlg").returnValue !== "save") return;
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      backend: $('input[name="engine"]:checked')?.value,
      anthropicKey: $("#sAnthropic").value,
      riotKey: $("#sRiot").value,
      ccModel: $("#sCCModel").value,
      ollamaVisionModel: $("#sOVision").value || undefined,
      ollamaCoachModel: $("#ollamaModels").hidden ? undefined : $("#sOCoach").value,
    }),
  });
  $("#sAnthropic").value = "";
  $("#sRiot").value = "";
  loadStatus();
});

// ---------------------------------------------------------------- setup panel
function bindSetup() {
  for (const f of SETUP_FIELDS) {
    const el = $(`#f${f[0].toUpperCase()}${f.slice(1)}`);
    el.value = prefs.setup[f] || "";
    el.addEventListener("input", () => { prefs.setup[f] = el.value; savePrefs(); });
  }
  $("#fRiotId").value = prefs.riotId || "";
  $("#fRegion").value = prefs.region || "americas";
  $("#fRiotId").addEventListener("input", (e) => { prefs.riotId = e.target.value; savePrefs(); });
  $("#fRegion").addEventListener("change", (e) => { prefs.region = e.target.value; savePrefs(); });
}
const getSetup = () => Object.fromEntries(SETUP_FIELDS.map((f) => [f, prefs.setup[f] || ""]));

async function loadCoaches() {
  coaches = await fetch("/api/coaches").then((r) => r.json());
  const wrap = $("#coachCards");
  wrap.innerHTML = "";
  for (const c of coaches) {
    const on = prefs.panel.includes(c.id);
    const card = document.createElement("label");
    card.className = `coach-card${on ? "" : " off"}`;
    card.style.setProperty("--c", c.color);
    card.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}/><div><span class="nm">${c.name}</span><span class="tt">${c.title}</span> <span class="muted small">${c.region}</span></div><div class="tg">${c.tagline}</div>`;
    card.querySelector("input").addEventListener("change", (e) => {
      prefs.panel = e.target.checked ? [...new Set([...prefs.panel, c.id])] : prefs.panel.filter((x) => x !== c.id);
      if (!prefs.panel.length) { prefs.panel = [c.id]; e.target.checked = true; }
      card.classList.toggle("off", !e.target.checked);
      savePrefs();
    });
    wrap.appendChild(card);
    $("#fLead").insertAdjacentHTML("beforeend", `<option value="${c.id}">${c.name}-style (${c.title})</option>`);
  }
  $("#fLead").value = prefs.lead || "";
  $("#fLead").addEventListener("change", (e) => { prefs.lead = e.target.value; savePrefs(); });
}

// ---------------------------------------------------------------- Riot import
$("#btnFindMatches").onclick = async () => {
  const list = $("#matchList");
  list.innerHTML = `<div class="muted">Looking up games…</div>`;
  const q = new URLSearchParams({ riotId: $("#fRiotId").value.trim(), region: $("#fRegion").value });
  const r = await fetch(`/api/riot/matches?${q}`);
  const data = await r.json();
  if (!r.ok) { list.innerHTML = `<div class="err">${escapeHtml(data.error || "Failed")}</div>`; return; }
  list.innerHTML = "";
  if (!data.matches.length) list.innerHTML = `<div class="muted">No recent games found.</div>`;
  for (const m of data.matches) {
    const el = document.createElement("div");
    el.className = "match";
    el.innerHTML = `<span><b>${escapeHtml(m.champion)}</b> <span class="muted small">${escapeHtml(m.position || "")}</span></span><span class="${m.win ? "w" : "l"}">${m.win ? "Win" : "Loss"}</span><span>${m.kda}</span><span class="muted">${m.duration}m · ${new Date(m.when).toLocaleDateString()}</span>`;
    el.onclick = () => loadDigest(m.id, data.puuid);
    list.appendChild(el);
  }
};

async function loadDigest(matchId, puuid) {
  const info = $("#digestInfo");
  info.hidden = false;
  info.textContent = "Loading match timeline…";
  const q = new URLSearchParams({ matchId, puuid, region: $("#fRegion").value });
  const r = await fetch(`/api/riot/digest?${q}`);
  const data = await r.json();
  if (!r.ok) { info.innerHTML = `<span class="err">${escapeHtml(data.error || "Failed")}</span>`; return; }
  const riot = { matchId, digest: data.digest, meta: data.meta };
  if (vodKey) { vod.riot = riot; saveVod(); } else prefs.pendingRiot = riot;
  const m = data.meta;
  Object.assign(prefs.setup, { champion: m.champion, enemyJungler: m.enemyJungler, allies: m.allies, enemies: m.enemies, side: m.side });
  savePrefs();
  for (const f of ["champion", "enemyJungler", "allies", "enemies", "side"]) $(`#f${f[0].toUpperCase()}${f.slice(1)}`).value = prefs.setup[f];
  showDigestInfo();
}
function currentRiot() { return vod.riot || prefs.pendingRiot || null; }
function showDigestInfo() {
  const r = currentRiot();
  const info = $("#digestInfo");
  if (!r) { info.hidden = true; return; }
  info.hidden = false;
  info.innerHTML = `✓ Match data attached: <b>${escapeHtml(r.meta.champion)}</b> vs ${escapeHtml(r.meta.enemyJungler)} (${r.meta.result}, ${r.meta.side} side). The coach will use the real timeline. <a href="#" id="dropDigest">remove</a>`;
  $("#dropDigest").onclick = (e) => { e.preventDefault(); vod.riot = null; prefs.pendingRiot = null; saveVod(); savePrefs(); showDigestInfo(); };
}

// ---------------------------------------------------------------- video loading
const drop = $("#drop");
$("#fileInput").addEventListener("change", (e) => e.target.files[0] && loadVideo(e.target.files[0]));
["dragenter", "dragover"].forEach((t) => $("#videoWrap").addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => $("#videoWrap").addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
$("#videoWrap").addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f && f.type.startsWith("video")) loadVideo(f); });

function loadVideo(file) {
  const url = URL.createObjectURL(file);
  vid.src = url;
  cap.src = url;
  drop.hidden = true;
  vodKey = `jc:vod:${file.name}:${file.size}`;
  vod = store.get(vodKey, { moments: [], offset: null, riot: null });
  if (!vod.riot && prefs.pendingRiot) { vod.riot = prefs.pendingRiot; prefs.pendingRiot = null; savePrefs(); saveVod(); }
  vid.addEventListener("loadedmetadata", () => { renderMoments(); updateClock(); }, { once: true });
  showDigestInfo();
}

$$("[data-skip]").forEach((b) => (b.onclick = () => (vid.currentTime = Math.max(0, vid.currentTime + Number(b.dataset.skip)))));
$("#speed").onchange = (e) => (vid.playbackRate = Number(e.target.value));

function updateClock() {
  $("#clockVod").textContent = `VOD ${fmt(vid.currentTime)}`;
  const g = gameTime(vid.currentTime);
  $("#clockGame").textContent = g ? `Game ${g}` : "Game --:-- (sync clock)";
}
vid.addEventListener("timeupdate", updateClock);
vid.addEventListener("seeked", () => { updateClock(); drawMinimapPreview(); });
vid.addEventListener("pause", drawMinimapPreview);
vid.addEventListener("loadeddata", drawMinimapPreview);

$("#btnSync").onclick = () => {
  if (!vid.src) return alert("Load a VOD first.");
  vid.pause();
  const v = prompt("Pause on a frame where the in-game clock is visible.\nWhat does the in-game clock show right now? (mm:ss)", gameTime(vid.currentTime) || "");
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v || "");
  if (!m) return;
  vod.offset = vid.currentTime - (Number(m[1]) * 60 + Number(m[2]));
  saveVod();
  updateClock();
  renderMoments();
};

// ---------------------------------------------------------------- minimap calibration
const calib = $("#calib");
function contentRect() {
  const r = vid.getBoundingClientRect();
  const s = Math.min(r.width / vid.videoWidth, r.height / vid.videoHeight);
  const w = vid.videoWidth * s, h = vid.videoHeight * s;
  return { left: (r.width - w) / 2, top: (r.height - h) / 2, w, h };
}
$("#btnMinimap").onclick = () => {
  if (!vid.videoWidth) return alert("Load a VOD first.");
  vid.pause();
  const wrap = $("#videoWrap").getBoundingClientRect();
  calib.width = wrap.width;
  calib.height = wrap.height;
  calib.hidden = false;
  const c = calib.getContext("2d");
  const banner = document.createElement("div");
  banner.className = "calib-banner";
  banner.textContent = "Drag a box around the minimap · Esc to cancel";
  $("#videoWrap").appendChild(banner);
  const cr = contentRect();
  const mm = prefs.minimap;
  let start = null, rect = { x: cr.left + mm.x * cr.w, y: cr.top + mm.y * cr.h, w: mm.w * cr.w, h: mm.h * cr.h };
  const draw = () => {
    c.clearRect(0, 0, calib.width, calib.height);
    c.fillStyle = "#0008";
    c.fillRect(0, 0, calib.width, calib.height);
    c.clearRect(rect.x, rect.y, rect.w, rect.h);
    c.strokeStyle = "#f0d58a";
    c.lineWidth = 2;
    c.strokeRect(rect.x, rect.y, rect.w, rect.h);
  };
  draw();
  const pos = (e) => { const b = calib.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const done = (save) => {
    calib.hidden = true;
    banner.remove();
    calib.onmousedown = calib.onmousemove = calib.onmouseup = null;
    document.removeEventListener("keydown", esc);
    if (save && rect.w > 20 && rect.h > 20) {
      const r = { x: (rect.x - cr.left) / cr.w, y: (rect.y - cr.top) / cr.h, w: rect.w / cr.w, h: rect.h / cr.h };
      r.x = Math.max(0, r.x); r.y = Math.max(0, r.y); r.w = Math.min(1 - r.x, r.w); r.h = Math.min(1 - r.y, r.h);
      prefs.minimap = r;
      savePrefs();
      drawMinimapPreview();
    }
  };
  const esc = (e) => e.key === "Escape" && done(false);
  document.addEventListener("keydown", esc);
  calib.onmousedown = (e) => { start = pos(e); rect = { ...start, w: 0, h: 0 }; draw(); };
  calib.onmousemove = (e) => {
    if (!start) return;
    const p = pos(e);
    rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    draw();
  };
  calib.onmouseup = () => { start = null; done(true); };
};

function drawMinimapPreview() {
  if (!vid.videoWidth) return;
  const pc = $("#minimapPreview");
  const c = pc.getContext("2d");
  const mm = prefs.minimap;
  try {
    c.drawImage(vid, mm.x * vid.videoWidth, mm.y * vid.videoHeight, mm.w * vid.videoWidth, mm.h * vid.videoHeight, 0, 0, pc.width, pc.height);
  } catch { /* frame not ready */ }
}

// ---------------------------------------------------------------- frame capture
async function seekCap(t) {
  if (cap.readyState < 1) await new Promise((r) => cap.addEventListener("loadedmetadata", r, { once: true }));
  const dur = isFinite(cap.duration) && cap.duration > 1 ? cap.duration : vid.duration;
  const target = Math.max(0, Math.min(t, dur - 0.05));
  if (Math.abs(cap.currentTime - target) < 0.01 && cap.readyState >= 2) return target;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000);
    cap.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
    cap.currentTime = target;
  });
  await new Promise((r) => setTimeout(r, 40)); // let the decoded frame settle (rAF would stall in background tabs)
  return target;
}
function grabFull(src, width = 1280, quality = 0.82) {
  const s = width / src.videoWidth;
  canvas.width = width;
  canvas.height = Math.round(src.videoHeight * s);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}
function grabMini(src, size = 448, quality = 0.85) {
  const mm = prefs.minimap;
  const sw = mm.w * src.videoWidth, sh = mm.h * src.videoHeight;
  const s = size / Math.max(sw, sh);
  canvas.width = Math.round(sw * s);
  canvas.height = Math.round(sh * s);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, mm.x * src.videoWidth, mm.y * src.videoHeight, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}
const label = (t, rel, kind) => {
  const g = gameTime(t);
  return `VOD ${fmt(t)}${rel != null ? ` (${rel >= 0 ? "+" : ""}${Math.round(rel)}s)` : ""}${g ? ` | game ${g}` : ""} | ${kind}`;
};

async function momentFrames(m, lookback, onProgress) {
  const L = Number(lookback);
  const offsets = [];
  for (let i = 0; i <= 6; i++) offsets.push(-L + (i * L) / 6);
  offsets.push(4);
  const fullAt = new Set([0, 3, 6, 7]); // -L, -L/2, 0, +4
  const frames = [];
  for (let i = 0; i < offsets.length; i++) {
    const t = await seekCap(m.vod + offsets[i]);
    if (fullAt.has(i)) frames.push({ label: label(t, offsets[i], "full screen"), dataUrl: grabFull(cap) });
    frames.push({ label: label(t, offsets[i], "minimap zoom"), dataUrl: grabMini(cap) });
    onProgress?.((i + 1) / offsets.length);
  }
  return frames;
}

// ---------------------------------------------------------------- moments
function markMoment() {
  if (!vid.src) return alert("Load a VOD first.");
  vid.pause();
  const t = vid.currentTime;
  canvas.width = 240;
  canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * 240);
  ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
  vod.moments.push({ id: uid(), vod: t, note: "", question: "", thumb: canvas.toDataURL("image/jpeg", 0.6), reviewId: null });
  vod.moments.sort((a, b) => a.vod - b.vod);
  saveVod();
  renderMoments();
  showTab("moments");
  const card = $(`.moment[data-id="${vod.moments.find((m) => m.vod === t).id}"] textarea`);
  card?.focus();
}
$("#btnMark").onclick = markMoment;

function renderMoments() {
  const list = $("#momentList");
  list.innerHTML = "";
  $("#momentCount").textContent = vod.moments.length;
  $("#noMoments").hidden = vod.moments.length > 0;
  for (const m of vod.moments) {
    const el = document.createElement("div");
    el.className = "moment";
    el.dataset.id = m.id;
    const g = gameTime(m.vod);
    el.innerHTML = `
      <div class="head"><span class="t">${g ? `Game ${g}` : `VOD ${fmt(m.vod)}`} <span class="muted small">${g ? `(VOD ${fmt(m.vod)})` : ""}</span></span>
        ${m.reviewId ? `<span class="tag" style="color:var(--teal)">✓ reviewed</span>` : ""}</div>
      <div class="body"><img class="thumb" src="${m.thumb}" alt="" />
        <div class="fields">
          <textarea rows="2" placeholder="What were you thinking / trying to do? (e.g. 'went to gank bot, thought their jungler was top')">${escapeHtml(m.note)}</textarea>
          <input placeholder="Specific question? (optional)" value="${escapeHtml(m.question)}" />
        </div></div>
      <div class="actions">
        <button class="ghost del">Delete</button>
        ${m.reviewId ? `<button class="ghost open">Open review</button>` : ""}
        <button class="primary go">Review with coach</button>
      </div>`;
    const [ta, inp] = [el.querySelector("textarea"), el.querySelector("input")];
    ta.oninput = () => { m.note = ta.value; saveVod(); };
    inp.oninput = () => { m.question = inp.value; saveVod(); };
    const jump = () => { vid.currentTime = m.vod; };
    el.querySelector(".t").onclick = jump;
    el.querySelector(".thumb").onclick = jump;
    el.querySelector(".del").onclick = () => { if (confirm("Delete this moment?")) { vod.moments = vod.moments.filter((x) => x !== m); saveVod(); renderMoments(); } };
    el.querySelector(".open")?.addEventListener("click", () => openReview(m.reviewId));
    el.querySelector(".go").onclick = () => reviewMoment(m);
    list.appendChild(el);
  }
  // timeline pins
  const bar = $("#markerBar");
  bar.innerHTML = "";
  if (vid.duration) {
    for (const m of vod.moments) {
      const p = document.createElement("div");
      p.className = `pin${m.reviewId ? " done" : ""}`;
      p.style.left = `${(m.vod / vid.duration) * 100}%`;
      p.title = `${gameTime(m.vod) || fmt(m.vod)} ${m.note}`;
      p.onclick = () => { vid.currentTime = m.vod; };
      bar.appendChild(p);
    }
  }
}

async function reviewMoment(m) {
  if (busy) return alert("The coach is still working on the last request.");
  busy = true;
  const g = gameTime(m.vod);
  startCoachView(`Moment review · ${g ? `game ${g}` : `VOD ${fmt(m.vod)}`}`, "Capturing frames…");
  try {
    const frames = await momentFrames(m, $("#lookback").value, (p) => setThinkingSummary(`Capturing frames… ${Math.round(p * 100)}%`));
    setThinkingSummary("Coach is analyzing your play…");
    await runReview({
      kind: "moment",
      moment: { vodTime: fmt(m.vod), gameTime: g, note: m.note, question: m.question },
      frames,
    }, (id) => { m.reviewId = id; saveVod(); renderMoments(); });
  } finally { busy = false; }
}

// ---------------------------------------------------------------- full game review
$("#btnGameReview").onclick = async () => {
  if (!vid.src || !vid.duration) return alert("Load a VOD first.");
  if (busy) return alert("The coach is still working on the last request.");
  busy = true;
  const bar = $("#gProgress");
  bar.hidden = false;
  try {
    const start = Math.max(0, vod.offset ?? 0);
    const span = vid.duration - start;
    const fullN = Number($("#gFull").value);
    let interval = Number($("#gInterval").value);
    const maxMini = 95 - fullN;
    if (span / interval > maxMini) interval = span / maxMini;
    const times = [];
    for (let t = start + 5; t < vid.duration - 1; t += interval) times.push({ t, kind: "mini" });
    for (let i = 1; i <= fullN; i++) times.push({ t: start + (span * i) / (fullN + 1), kind: "full" });
    times.sort((a, b) => a.t - b.t);
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      const t = await seekCap(times[i].t);
      frames.push(times[i].kind === "full"
        ? { label: label(t, null, "full screen"), dataUrl: grabFull(cap, 1280, 0.78) }
        : { label: label(t, null, "minimap"), dataUrl: grabMini(cap, 384, 0.8) });
      bar.firstElementChild.style.width = `${((i + 1) / times.length) * 100}%`;
    }
    startCoachView("Full game review", "Coach is watching your whole game…");
    await runReview({
      kind: "game",
      frames,
      notes: $("#gNotes").value,
      moments: vod.moments.map((m) => ({ vodTime: fmt(m.vod), gameTime: gameTime(m.vod), note: m.note, question: m.question })),
    });
  } finally {
    busy = false;
    bar.hidden = true;
    bar.firstElementChild.style.width = "0";
  }
};

// ---------------------------------------------------------------- coach view & streaming
function startCoachView(title, status) {
  showTab("coach");
  currentReviewId = null;
  $("#coachEmpty").hidden = true;
  $("#coachTitle").hidden = false;
  $("#coachTitle").textContent = title;
  $("#coachOut").innerHTML = "";
  $("#chatLog").innerHTML = "";
  $("#thinkingText").textContent = "";
  $("#thinkingBox").hidden = false;
  $("#thinkingBox").open = false;
  setThinkingSummary(status);
}
const setThinkingSummary = (s) => ($("#thinkingBox summary").textContent = s);

async function streamPost(url, body, onEvent) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) throw new Error((await r.text()) || `HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}

function makeRenderer(el) {
  let text = "", queued = false;
  return {
    add(t) {
      text += t;
      if (!queued) { queued = true; setTimeout(() => { queued = false; renderMd(el, text); }, 50); }
    },
    get text() { return text; },
  };
}

async function runReview(payload, onSaved) {
  const out = makeRenderer($("#coachOut"));
  let gotText = false;
  try {
    await streamPost("/api/review", {
      ...payload,
      setup: getSetup(),
      panel: prefs.panel,
      lead: prefs.lead,
      riotDigest: currentRiot()?.digest || null,
    }, (ev) => {
      if (ev.type === "status") { if (!gotText) setThinkingSummary(ev.message); }
      else if (ev.type === "thinking") { $("#thinkingText").textContent += ev.text; if (!gotText && !/batch|writing/.test($("#thinkingBox summary").textContent)) setThinkingSummary("Coach is analyzing your play… (click to peek)"); }
      else if (ev.type === "text") {
        if (!gotText) { gotText = true; setThinkingSummary("Coach's analysis notes"); }
        out.add(ev.text);
      } else if (ev.type === "error") showError($("#coachOut"), ev.message);
      else if (ev.type === "notice") showError($("#coachOut"), ev.message);
      else if (ev.type === "done") {
        currentReviewId = ev.id;
        if (ev.title) $("#coachTitle").textContent = ev.title;
        onSaved?.(ev.id);
        renderProfile(ev.profile);
      }
    });
  } catch (e) {
    showError($("#coachOut"), e.message);
  }
  if (!gotText) $("#thinkingBox").hidden = $("#thinkingText").textContent === "";
}

function showError(el, msg) {
  el.insertAdjacentHTML("beforeend", `<div class="err">${escapeHtml(msg)}</div>`);
}

$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#chatInput").value.trim();
  if (!text) return;
  if (busy) return alert("The coach is still answering.");
  busy = true;
  $("#coachEmpty").hidden = true;
  $("#chatInput").value = "";
  const log = $("#chatLog");
  log.insertAdjacentHTML("beforeend", `<div class="u">${escapeHtml(text)}</div>`);
  const a = document.createElement("div");
  a.className = "a md";
  a.innerHTML = `<span class="muted">Coach is thinking…</span>`;
  log.appendChild(a);
  a.scrollIntoView({ behavior: "smooth", block: "end" });
  const out = makeRenderer(a);
  try {
    await streamPost("/api/chat", { reviewId: currentReviewId, text, setup: getSetup(), panel: prefs.panel }, (ev) => {
      if (ev.type === "text") out.add(ev.text);
      else if (ev.type === "error") showError(a, ev.message);
    });
  } catch (err) {
    showError(a, err.message);
  } finally { busy = false; }
});
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); }
});

async function openReview(id) {
  const r = await fetch(`/api/reviews/${id}`);
  if (!r.ok) return alert("Review not found.");
  const rec = await r.json();
  showTab("coach");
  currentReviewId = rec.id;
  $("#coachEmpty").hidden = true;
  $("#thinkingBox").hidden = true;
  $("#coachTitle").hidden = false;
  $("#coachTitle").textContent = `${rec.title} · ${new Date(rec.createdAt).toLocaleString()}`;
  renderMd($("#coachOut"), rec.text);
  const log = $("#chatLog");
  log.innerHTML = "";
  for (const c of rec.chat || []) {
    if (c.role === "user") log.insertAdjacentHTML("beforeend", `<div class="u">${escapeHtml(c.text)}</div>`);
    else { const a = document.createElement("div"); a.className = "a md"; renderMd(a, c.text); log.appendChild(a); }
  }
}

// ---------------------------------------------------------------- profile
async function renderProfile(p) {
  p ||= await fetch("/api/profile").then((r) => r.json());
  const habits = (arr, el) => {
    el.innerHTML = "";
    const sorted = (arr || []).slice().sort((a, b) => b.count - a.count);
    if (!sorted.length) el.innerHTML = `<li class="muted">Nothing tracked yet.</li>`;
    for (const h of sorted) el.insertAdjacentHTML("beforeend", `<li><span>${escapeHtml(h.text)}</span><span class="n">${h.count}×</span></li>`);
  };
  habits(p.mistakes, $("#habitList"));
  habits(p.strengths, $("#strengthList"));
  const hl = $("#historyList");
  hl.innerHTML = "";
  if (!p.reviews?.length) hl.innerHTML = `<li class="muted">No reviews yet.</li>`;
  for (const r of p.reviews || []) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(r.verdict || (r.kind === "game" ? "📋" : "•"))} ${escapeHtml(r.title)} <span class="muted small">${escapeHtml(r.champion || "")}</span></span><span class="muted small">${new Date(r.createdAt).toLocaleDateString()}</span>`;
    li.onclick = () => openReview(r.id);
    hl.appendChild(li);
  }
}
$("#btnResetProfile").onclick = async () => {
  if (!confirm("Reset tracked habits and strengths? (Review history is kept.)")) return;
  await fetch("/api/profile", { method: "DELETE" });
  renderProfile();
};

// ---------------------------------------------------------------- hotkeys
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!vid.src) return;
  if (e.key === "m" || e.key === "M") { e.preventDefault(); markMoment(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); vid.currentTime = Math.max(0, vid.currentTime - 3); }
  else if (e.key === "ArrowRight") { e.preventDefault(); vid.currentTime += 3; }
  else if (e.key === " " && e.target !== vid) { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
});

// ---------------------------------------------------------------- init
bindSetup();
loadStatus();
loadCoaches();
renderProfile();
showDigestInfo();
