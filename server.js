import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractCoachData, fmtProfile } from "./coach/prompts.js";
import { publicPersonas, PERSONA_ORDER } from "./coach/personas.js";
import { findMatches, buildDigest } from "./coach/riot.js";
import { BACKENDS, createBackends, claudeCodeStatus, claudeCodeLogin, ollamaStatus, describeError } from "./coach/backends.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "data");
const REVIEW_DIR = path.join(DATA_DIR, "reviews");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");
const ENV_FILE = path.join(here, ".env");
fs.mkdirSync(REVIEW_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 5178);
const backends = createBackends(DATA_DIR);

// Per-review conversation state for follow-ups: id -> { backend, state }
const conversations = new Map();

// ---------------------------------------------------------------- profile
function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
  } catch {
    return { mistakes: [], strengths: [], reviews: [] };
  }
}
const saveProfile = (p) => fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2));
function mergeHabits(list, items) {
  for (const raw of items || []) {
    const text = String(raw).trim();
    if (!text) continue;
    const found = list.find((h) => h.text.toLowerCase() === text.toLowerCase());
    if (found) {
      found.count += 1;
      found.lastSeen = Date.now();
    } else list.push({ text, count: 1, firstSeen: Date.now(), lastSeen: Date.now() });
  }
}

// ---------------------------------------------------------------- env/settings
function writeEnv(updates) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  } catch {}
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  fs.writeFileSync(ENV_FILE, lines.filter((l) => l.trim()).join("\n") + "\n");
}

async function engineStatus() {
  const [cc, ol] = await Promise.all([claudeCodeStatus(), ollamaStatus()]);
  const api = { ready: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: process.env.COACH_MODEL || "claude-opus-5-5" };
  const ready = {
    claudecode: cc.found && cc.loggedIn,
    ollama: ol.running && ol.models.some((m) => m.vision),
    anthropic: api.ready,
  };
  let selected = process.env.COACH_BACKEND;
  if (!BACKENDS.includes(selected)) selected = ready.claudecode ? "claudecode" : ready.ollama ? "ollama" : ready.anthropic ? "anthropic" : "claudecode";
  return {
    selected,
    ready,
    claudecode: { ...cc, model: process.env.CC_MODEL || "opus" },
    ollama: { ...ol, visionModel: process.env.OLLAMA_VISION_MODEL || "", coachModel: process.env.OLLAMA_COACH_MODEL || "" },
    anthropic: api,
    riot: Boolean(process.env.RIOT_API_KEY),
  };
}

// ---------------------------------------------------------------- SSE helper
function openStream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const send = (o) => !res.writableEnded && res.write(`data: ${JSON.stringify(o)}\n\n`);
  return { send, signal: ac.signal };
}

async function pickBackend(requested) {
  if (BACKENDS.includes(requested)) return requested;
  return (await engineStatus()).selected;
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(here, "public")));
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(here, "node_modules/marked/lib/marked.umd.js")));

app.get("/api/status", async (_req, res) => res.json(await engineStatus()));

app.post("/api/settings", (req, res) => {
  const b = req.body || {};
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/[\r\n]/g, "") : undefined);
  writeEnv({
    ANTHROPIC_API_KEY: clean(b.anthropicKey),
    RIOT_API_KEY: clean(b.riotKey),
    COACH_BACKEND: BACKENDS.includes(b.backend) ? b.backend : undefined,
    OLLAMA_VISION_MODEL: typeof b.ollamaVisionModel === "string" ? b.ollamaVisionModel.trim() : undefined,
    OLLAMA_COACH_MODEL: typeof b.ollamaCoachModel === "string" ? b.ollamaCoachModel.trim() : undefined,
    CC_MODEL: ["opus", "sonnet", "haiku"].includes(b.ccModel) ? b.ccModel : undefined,
  });
  backends.anthropic.reset();
  res.json({ ok: true });
});

app.post("/api/claudecode/login", (_req, res) => {
  try {
    res.json({ ok: true, ...claudeCodeLogin() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/coaches", (_req, res) => res.json(publicPersonas()));
app.get("/api/profile", (_req, res) => res.json(loadProfile()));
app.delete("/api/profile", (_req, res) => {
  saveProfile({ mistakes: [], strengths: [], reviews: loadProfile().reviews });
  res.json({ ok: true });
});

const reviewPath = (id) => (/^[a-f0-9-]{36}$/.test(id || "") ? path.join(REVIEW_DIR, `${id}.json`) : null);
function readReview(id) {
  const p = reviewPath(id);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

app.get("/api/reviews/:id", (req, res) => {
  const r = readReview(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: "not found" });
});

app.post("/api/review", async (req, res) => {
  const { kind: k, setup, moment, moments, frames, panel, lead, riotDigest, notes, backend: requested } = req.body || {};
  const kind = k === "game" ? "game" : "moment";
  const safePanel = (Array.isArray(panel) ? panel : PERSONA_ORDER).filter((p) => PERSONA_ORDER.includes(p));
  const args = {
    setup,
    moment: moment || {},
    moments,
    frames: (Array.isArray(frames) ? frames : []).slice(0, 95),
    panel: safePanel.length ? safePanel : PERSONA_ORDER,
    lead,
    riotDigest,
    notes,
    profile: loadProfile(),
  };
  const backendName = await pickBackend(requested);
  const { send, signal } = openStream(res);
  send({ type: "status", message: `Engine: ${backendName}` });
  try {
    const result = await backends[backendName].review({ kind, args, onEvent: send, signal });
    const { clean, data } = extractCoachData(result.text);
    const profile = loadProfile();
    if (data) {
      mergeHabits(profile.mistakes, data.mistakes);
      mergeHabits(profile.strengths, data.strengths);
    }
    const id = crypto.randomUUID();
    const title = data?.title || (kind === "game" ? "Full game review" : `Moment at ${moment?.gameTime || moment?.vodTime}`);
    const verdict = (/##\s*Verdict\s*\n+\s*([✅⚠️❌🚨]+)/u.exec(clean) || [])[1] || "";
    const record = { id, kind, title, verdict, backend: backendName, createdAt: Date.now(), setup, moment: moment || null, text: clean, chat: [] };
    fs.writeFileSync(reviewPath(id), JSON.stringify(record, null, 2));
    profile.reviews.unshift({ id, kind, title, verdict, createdAt: record.createdAt, champion: setup?.champion || "" });
    profile.reviews = profile.reviews.slice(0, 200);
    saveProfile(profile);
    conversations.set(id, { backend: backendName, state: result.state });
    send({ type: "done", id, title, profile });
  } catch (err) {
    if (!signal.aborted) send({ type: "error", message: describeError(err) });
  }
  res.end();
});

app.post("/api/chat", async (req, res) => {
  const { reviewId, text, setup, panel, backend: requested } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "empty" });
  const record = readReview(reviewId);
  const conv = reviewId ? conversations.get(reviewId) : conversations.get("general");
  const backendName = conv?.backend || (await pickBackend(requested));
  // Text-only context used when the live conversation isn't available (e.g. after a restart).
  let fallbackHistory = "";
  if (record) {
    fallbackHistory = `FOLLOW-UP context: this is a review you gave earlier.\nSetup: ${JSON.stringify(record.setup || {})}\n\nYOUR REVIEW:\n${record.text}\n\n${(record.chat || []).map((c) => `${c.role.toUpperCase()}: ${c.text}`).join("\n\n")}`;
  } else {
    fallbackHistory = `General coaching question (no specific review). Player setup: ${JSON.stringify(setup || {})}\n${fmtProfile(loadProfile())}`;
  }
  const { send, signal } = openStream(res);
  try {
    const out = await backends[backendName].chat({
      state: conv?.state,
      text: String(text).slice(0, 4000),
      fallbackHistory,
      panel: Array.isArray(panel) ? panel : PERSONA_ORDER,
      onEvent: send,
      signal,
    });
    conversations.set(reviewId || "general", { backend: backendName, state: out.state });
    if (record) {
      record.chat.push({ role: "user", text: String(text) }, { role: "assistant", text: out.text });
      fs.writeFileSync(reviewPath(record.id), JSON.stringify(record, null, 2));
    }
    send({ type: "done", id: reviewId || null });
  } catch (err) {
    if (!signal.aborted) send({ type: "error", message: describeError(err) });
  }
  res.end();
});

// Riot API
app.get("/api/riot/matches", async (req, res) => {
  try {
    res.json(await findMatches(req.query.riotId, req.query.region));
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message });
  }
});
app.get("/api/riot/digest", async (req, res) => {
  try {
    res.json(await buildDigest(String(req.query.matchId), String(req.query.puuid), String(req.query.region)));
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message });
  }
});

app.listen(PORT, "127.0.0.1", async () => {
  console.log(`\n  JungleCoach is running:  http://localhost:${PORT}\n`);
  const s = await engineStatus();
  console.log(`  Engine: ${s.selected}  (Claude Code ${s.ready.claudecode ? "ready" : "not logged in"} · Ollama ${s.ready.ollama ? "ready" : "not available"} · API ${s.ready.anthropic ? "key set" : "no key"})\n`);
});
