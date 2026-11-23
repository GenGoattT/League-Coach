// AI engines for the coach.
//   claudecode - runs the Claude Code CLI headless on the user's Claude subscription (no API billing)
//   ollama     - fully local, free and offline (needs Ollama + a vision model)
//   anthropic  - pay-per-use Claude API (optional)
import Anthropic from "@anthropic-ai/sdk";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SYSTEM_PROMPT,
  OBSERVE_PROMPT,
  localSystemPrompt,
  buildMomentContent,
  buildGameContent,
  buildLocalCoachPrompt,
  parseImage,
} from "./prompts.js";

export const BACKENDS = ["claudecode", "ollama", "anthropic"];

// ===================================================================== Claude Code
function findClaudeExe() {
  if (process.env.CLAUDE_CODE_PATH && fs.existsSync(process.env.CLAUDE_CODE_PATH)) return process.env.CLAUDE_CODE_PATH;
  // 1) on PATH
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, `claude${ext}`);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  // 2) copy bundled with the Claude desktop app (Windows)
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Claude-Data");
  const found = [];
  try {
    for (const a of fs.readdirSync(base)) {
      const cc = path.join(base, a, "claude-code");
      if (!fs.existsSync(cc)) continue;
      for (const ver of fs.readdirSync(cc)) {
        const vdir = path.join(cc, ver);
        for (const h of fs.readdirSync(vdir)) {
          const exe = path.join(vdir, h, "claude.exe");
          try {
            found.push({ exe, mtime: fs.statSync(exe).mtimeMs });
          } catch {}
        }
      }
    }
  } catch {}
  found.sort((x, y) => y.mtime - x.mtime);
  return found[0]?.exe || null;
}

// Child env WITHOUT API keys so the CLI uses the subscription login, never API billing.
function ccEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;
  return env;
}

export async function claudeCodeStatus() {
  const exe = findClaudeExe();
  if (!exe) return { found: false, loggedIn: false, path: null };
  const out = await new Promise((resolve) =>
    execFile(exe, ["auth", "status"], { env: ccEnv(), timeout: 20000, windowsHide: true }, (_e, stdout) => resolve(stdout || ""))
  );
  let s = {};
  try {
    s = JSON.parse(out);
  } catch {}
  return { found: true, loggedIn: Boolean(s.loggedIn), authMethod: s.authMethod || null, path: exe };
}

export function claudeCodeLogin() {
  const exe = findClaudeExe();
  if (!exe) throw new Error("Claude Code CLI not found");
  // Opens the browser for the user's own Claude login. Detached so it survives the request.
  const child = spawn(exe, ["auth", "login"], { env: ccEnv(), detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { path: exe };
}

class ClaudeCodeBackend {
  constructor(dataDir) {
    this.cwd = path.join(dataDir, "claude-code-sessions"); // keeps these sessions out of your normal Claude Code history
    fs.mkdirSync(this.cwd, { recursive: true });
    this.sysFile = path.join(this.cwd, "system-prompt.md");
    fs.writeFileSync(this.sysFile, SYSTEM_PROMPT);
  }

  // content: Anthropic-style content blocks (text + base64 images), or a string
  run({ content, resumeId, onEvent, signal }) {
    const exe = findClaudeExe();
    if (!exe) return Promise.reject(new Error("Claude Code CLI not found. Install Claude Code or pick another engine."));
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--system-prompt-file", this.sysFile,
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--model", process.env.CC_MODEL || "opus",
      "--effort", process.env.COACH_EFFORT || "high",
    ];
    if (resumeId) args.push("--resume", resumeId);

    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: this.cwd, env: ccEnv(), windowsHide: true });
      let buf = "", text = "", sessionId = resumeId || null, errText = "", settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      signal?.addEventListener("abort", () => child.kill());

      child.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.session_id) sessionId = m.session_id;
          if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
            const d2 = m.event.delta;
            if (d2.type === "text_delta") { text += d2.text; onEvent({ type: "text", text: d2.text }); }
            else if (d2.type === "thinking_delta") onEvent({ type: "thinking", text: d2.thinking });
          } else if (m.type === "result") {
            if (m.is_error) {
              const msg = String(m.result || "Claude Code error");
              finish(reject, new Error(/login|logged in/i.test(msg)
                ? "Claude Code is not logged in. Open ⚙ Engine and click 'Log in to Claude'."
                : /limit|usage/i.test(msg) ? `Claude subscription usage limit reached: ${msg}` : msg));
            } else {
              if (!text && m.result) { text = m.result; onEvent({ type: "text", text }); }
              finish(resolve, { text, sessionId });
            }
          }
        }
      });
      child.stderr.on("data", (d) => (errText += d.toString("utf8")));
      child.on("error", (e) => finish(reject, e));
      child.on("close", (code) => finish(code === 0 ? resolve : reject, code === 0 ? { text, sessionId } : new Error(errText.trim() || `Claude Code exited with code ${code}`)));

      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
      child.stdin.end();
    });
  }

  async review({ kind, args, onEvent, signal }) {
    const content = kind === "game" ? buildGameContent(args) : buildMomentContent(args);
    const r = await this.run({ content, onEvent, signal });
    return { text: r.text, state: { sessionId: r.sessionId } };
  }

  async chat({ state, text, fallbackHistory, onEvent, signal }) {
    if (state?.sessionId) {
      try {
        const r = await this.run({ content: `FOLLOW-UP: ${text}`, resumeId: state.sessionId, onEvent, signal });
        return { text: r.text, state: { sessionId: r.sessionId } };
      } catch (e) {
        if (signal?.aborted) throw e; // otherwise fall through to a fresh session
      }
    }
    const prompt = `${fallbackHistory || ""}\n\nFOLLOW-UP: ${text}`.trim();
    const r = await this.run({ content: prompt, onEvent, signal });
    return { text: r.text, state: { sessionId: r.sessionId } };
  }
}

// ===================================================================== Ollama (local)
const OLLAMA = () => (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const VISION_HINT = /(vl|vision|llava|gemma3|minicpm-v|moondream|mistral-small3|llama4|granite3\.2-vision)/i;

export async function ollamaStatus() {
  try {
    const r = await fetch(`${OLLAMA()}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const { models = [] } = await r.json();
    const list = [];
    for (const m of models) {
      let vision = VISION_HINT.test(m.name);
      try {
        const s = await fetch(`${OLLAMA()}/api/show`, { method: "POST", body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(4000) }).then((x) => x.json());
        if (Array.isArray(s.capabilities)) vision = s.capabilities.includes("vision");
      } catch {}
      list.push({ name: m.name, sizeGB: Math.round((m.size / 1e9) * 10) / 10, vision });
    }
    return { running: true, models: list };
  } catch {
    return { running: false, models: [] };
  }
}

async function pickOllamaModels() {
  const s = await ollamaStatus();
  if (!s.running) throw new Error("Ollama isn't running. Install it from ollama.com (or `winget install Ollama.Ollama`), then start it.");
  const vision = s.models.filter((m) => m.vision);
  const visionModel = process.env.OLLAMA_VISION_MODEL && s.models.some((m) => m.name === process.env.OLLAMA_VISION_MODEL)
    ? process.env.OLLAMA_VISION_MODEL
    : vision[0]?.name;
  if (!visionModel) throw new Error("No vision model in Ollama. Run:  ollama pull qwen2.5vl:7b   (or gemma3:4b for a lighter one)");
  const coachModel = process.env.OLLAMA_COACH_MODEL && s.models.some((m) => m.name === process.env.OLLAMA_COACH_MODEL)
    ? process.env.OLLAMA_COACH_MODEL
    : visionModel;
  return { visionModel, coachModel };
}

async function ollamaChat({ model, messages, stream, numCtx, temperature, onEvent, signal }) {
  const r = await fetch(`${OLLAMA()}/api/chat`, {
    method: "POST",
    signal,
    body: JSON.stringify({ model, messages, stream, keep_alive: "15m", options: { num_ctx: numCtx, temperature } }),
  });
  if (!r.ok) throw new Error(`Ollama error ${r.status}: ${await r.text()}`);
  if (!stream) {
    const j = await r.json();
    return j.message?.content || "";
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      if (j.message?.thinking) onEvent?.({ type: "thinking", text: j.message.thinking });
      if (j.message?.content) { text += j.message.content; onEvent?.({ type: "text", text: j.message.content }); }
    }
  }
  return text;
}

function subsample(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (max - 1))]);
  return out;
}

class OllamaBackend {
  // Stage 1: a vision model turns frames into factual notes, in small batches (small models can't handle 90 images).
  async observe(frames, kind, visionModel, onEvent, signal) {
    let usable = frames.filter((f) => parseImage(f.dataUrl));
    if (kind === "game") {
      const full = subsample(usable.filter((f) => f.label.includes("full screen")), 6);
      const mini = subsample(usable.filter((f) => !f.label.includes("full screen")), 36);
      usable = [...full, ...mini].sort((a, b) => frames.indexOf(a) - frames.indexOf(b));
    }
    const batchSize = kind === "game" ? 6 : 4;
    const batches = [];
    for (let i = 0; i < usable.length; i += batchSize) batches.push(usable.slice(i, i + batchSize));
    const notes = [];
    for (let b = 0; b < batches.length; b++) {
      onEvent({ type: "status", message: `Local model reading frames… batch ${b + 1}/${batches.length}` });
      const batch = batches[b];
      const content = `Images in order:\n${batch.map((f, i) => `${i + 1}) ${f.label}`).join("\n")}\n\nDescribe each image (refer to them by number).`;
      const out = await ollamaChat({
        model: visionModel,
        messages: [
          { role: "system", content: OBSERVE_PROMPT },
          { role: "user", content, images: batch.map((f) => parseImage(f.dataUrl).data) },
        ],
        stream: false,
        numCtx: 8192,
        temperature: 0.1,
        signal,
      });
      notes.push(`### ${batch[0].label} → ${batch[batch.length - 1].label}\n${batch.map((f, i) => `(${i + 1}) = ${f.label}`).join("; ")}\n${out.trim()}`);
      onEvent({ type: "thinking", text: `${notes[notes.length - 1]}\n\n` });
    }
    return notes.join("\n\n");
  }

  async review({ kind, args, onEvent, signal }) {
    const { visionModel, coachModel } = await pickOllamaModels();
    const observations = await this.observe(args.frames || [], kind, visionModel, onEvent, signal);
    onEvent({ type: "status", message: `Coach is writing your review (${coachModel})…` });
    const system = localSystemPrompt(args.panel);
    const user = buildLocalCoachPrompt(kind, args, observations);
    const text = await ollamaChat({
      model: coachModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      stream: true,
      numCtx: 16384,
      temperature: 0.4,
      onEvent,
      signal,
    });
    return { text, state: { history: [{ role: "system", content: system }, { role: "user", content: user }, { role: "assistant", content: text }] } };
  }

  async chat({ state, text, fallbackHistory, panel, onEvent, signal }) {
    const { coachModel } = await pickOllamaModels();
    const history = state?.history || [
      { role: "system", content: localSystemPrompt(panel) },
      { role: "user", content: fallbackHistory || "General coaching question." },
      { role: "assistant", content: "Got it." },
    ];
    const messages = [...history, { role: "user", content: `FOLLOW-UP: ${text}` }];
    const out = await ollamaChat({ model: coachModel, messages, stream: true, numCtx: 16384, temperature: 0.5, onEvent, signal });
    return { text: out, state: { history: [...messages, { role: "assistant", content: out }] } };
  }
}

// ===================================================================== Anthropic API (paid)
class AnthropicBackend {
  client = null;
  getClient() {
    return (this.client ??= new Anthropic());
  }
  reset() {
    this.client = null;
  }

  async run(messages, onEvent, signal) {
    const params = {
      model: process.env.COACH_MODEL || "claude-opus-5-5",
      max_tokens: 32000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: process.env.COACH_EFFORT || "high" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      messages,
    };
    const stream = process.env.COACH_FALLBACKS !== "off"
      ? this.getClient().beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : this.getClient().messages.stream(params);
    signal?.addEventListener("abort", () => stream.abort());
    for await (const ev of stream) {
      if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") onEvent({ type: "text", text: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") onEvent({ type: "thinking", text: ev.delta.thinking });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new Error("The model declined this request. Try rephrasing your note or question.");
    if (final.stop_reason === "max_tokens") onEvent({ type: "notice", message: "Answer was cut off (length limit)." });
    console.log(`[coach/api] in=${final.usage.input_tokens} cached=${final.usage.cache_read_input_tokens ?? 0} out=${final.usage.output_tokens}`);
    return { text: final.content.filter((b) => b.type === "text").map((b) => b.text).join(""), content: final.content };
  }

  async review({ kind, args, onEvent, signal }) {
    const messages = [{ role: "user", content: kind === "game" ? buildGameContent(args) : buildMomentContent(args) }];
    const r = await this.run(messages, onEvent, signal);
    return { text: r.text, state: { messages: [...messages, { role: "assistant", content: r.content }] } };
  }

  async chat({ state, text, fallbackHistory, onEvent, signal }) {
    const history = state?.messages || [
      { role: "user", content: fallbackHistory || "General coaching question." },
      { role: "assistant", content: "Got it." },
    ];
    const messages = [...history, { role: "user", content: `FOLLOW-UP: ${String(text).slice(0, 4000)}` }];
    const r = await this.run(messages, onEvent, signal);
    return { text: r.text, state: { messages: [...messages, { role: "assistant", content: r.content }] } };
  }
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Claude API key is missing or invalid (⚙ Engine).";
  if (err instanceof Anthropic.PermissionDeniedError) return "Your Anthropic API key does not have access to this model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a moment and retry.";
  if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  if (/Could not resolve authentication/i.test(String(err?.message))) return "No Claude API key configured. Pick a free engine in ⚙ Engine, or add a key.";
  return String(err?.message || err);
}

export function createBackends(dataDir) {
  return { claudecode: new ClaudeCodeBackend(dataDir), ollama: new OllamaBackend(), anthropic: new AnthropicBackend() };
}
