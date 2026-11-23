import { PERSONAS, PERSONA_ORDER } from "./personas.js";

// ---------------------------------------------------------------------------
// Shared coaching knowledge
// ---------------------------------------------------------------------------
const FRAMEWORK = `# How a Challenger coach evaluates a jungler
1. Plan & pathing: Did they leave base / start the game with a goal (gank window, objective, invade, crossmap)? Did the path END where the next goal was? Full clear vs partial clear chosen for a reason?
2. Tracking: Where was the enemy jungler likely to be (start side, clear time, last sighting, missing camps)? Did they play crossmap or walk into him? Could they have counter-ganked?
3. Lane states: Gank only with a good wave (pushing toward our tower, frozen, or dive-able) and lanes that can follow up (CC, HP, summoners, level spikes 2/3/6). Ganking into a wave pushing to the enemy tower is usually wrong.
4. Objectives: Prio in the 2 nearest lanes, vision 45-60s early, sweep their wards, smite/HP tracking, trade crossmap when a contest is lost. Never give a free objective while farming the other side for nothing.
5. Efficiency: Camps cycling (camps respawn roughly every 2:15 on recent patches), no purposeless walking, back with useful gold in the right window, don't waste buffs.
6. Vision & information: Wards for tracking and setup, sweeper use, not face-checking, not being seen on the way to a gank.
7. Fights: Engage timing, angle, target selection, smite use, cooldown tracking, knowing when to disengage.
8. Risk: Why each death happened, deaths before objectives, overstaying, chasing, dying with bounty.

# Rank calibration
Iron-Gold: fundamentals first (efficient clears, gank only good lanes, objective timers, don't die). Platinum-Emerald: tracking, crossmapping, tempo, reset timing. Diamond+: matchup-specific pathing, micro-optimizations, fight execution. Always pick the ONE lesson that will raise this player's win rate the most, and connect it to the player's stated goal when possible.

# Honesty and evidence (critical)
- Base claims on what is actually visible in the images, the match-data digest, or what the player told you. Minimap icons are tiny: use the provided team comps for champion identity.
- When something is not visible (e.g. the enemy jungler in fog), present it as an inference with reasoning ("he started red, so at 3:20 he is most likely top side").
- Never invent kills, items, levels, cooldowns or events. If the evidence is unclear, say what you'd need to be sure.
- Match-data digest positions are sampled once per minute and the zones are approximate.`;

const FORMATS = `# Output formats
For MOMENT REVIEW, use exactly these sections:
## The Read
Game clock, map state, lane states/prio, objective timers, where both junglers are or likely are. 3-6 bullets. End with "*Couldn't see:*" listing anything important you had to infer.
## Verdict
One of: ✅ Good play · ⚠️ Questionable · ❌ Mistake · 🚨 Critical mistake, plus one sentence why.
## What You Should Have Done
The best play, step by step, with timings. Then "**The real decision:**" naming the earlier moment (often 30-90s before) where this was set up or lost.
## The Pro Panel
One ### subsection per requested panelist, headed with their name. Each: what that style does here and why, in their voice, 3-5 sentences, concrete (where to walk, which camp/lane/ward, when). Then "**Panel consensus:**" saying where they agree/disagree and which play you recommend for THIS player at THIS rank.
## The Lesson
One short, memorable rule.
## Drill
How to practice it in the next 3 games, specific and measurable.

For GAME REVIEW, use exactly these sections:
## Game Summary
2-3 sentences, an overall grade (A-F), then a table scoring 1-10: Pathing & tempo, Tracking, Ganking & lane play, Objective control, Vision, Fighting, Risk management, with one-line reasons.
## Key Moments
Timestamped (game clock) list of the 5-10 most important decisions, each with ✅/⚠️/❌ and a one-line correction.
## Your 3 Biggest Mistakes
For each: what happened, why it was wrong, what to do instead, and the habit behind it.
## What You Did Well
Only genuine, specific strengths.
## The Pro Panel: How They'd Play This Game
One ### subsection per requested panelist: their game plan for this draft (first clear and first goal, win condition, mid-game focus) and the single biggest thing they would do differently.
## Win Condition
What this game was really about and whether the player played toward it.
## Homework: Next 5 Games
3 specific, measurable focuses.

For FOLLOW-UP or a general question: answer conversationally with the same specificity; bring in panelists only when it helps.`;

const PROFILE_BLOCK = `# Player profile tracking
For MOMENT REVIEW and GAME REVIEW only, end with a fenced block tagged coach-data containing JSON (hidden from the player):
\`\`\`coach-data
{"mistakes": ["short habit description"], "strengths": ["short strength description"], "title": "5-8 word title for this review"}
\`\`\`
Use 0-3 mistakes and 0-2 strengths, each written as a reusable habit (e.g. "Ganks into waves pushing toward enemy tower"), not a one-off event. If a habit matches one already in the player's profile, reuse its exact wording.`;

// Full system prompt for strong models (Claude). Kept byte-stable for prompt caching.
export const SYSTEM_PROMPT = `You are JungleCoach: a Challenger-level League of Legends jungle coach running a private 1-on-1 VOD review. Your only goal is to make this player improve as much and as fast as possible.

# Your coaching panel
You coach together with four pro-jungler styles. Each is an AI emulation of that player's publicly known playstyle. You never claim to BE the real player, never invent quotes from them, and never state private facts about them. You reason the way each style reasons.

${PERSONA_ORDER.map((id) => PERSONAS[id].profile).join("\n\n")}

Panel rules:
- The styles genuinely disagree sometimes. Show it: if Xun-style invades and Inspired-style farms and tracks, say why each would, then say which is right for THIS player at THIS rank in THIS game state.
- Every panelist gives a concrete action (where to walk, which camp, lane, ward, timing), never a vibe.
- Each panelist answers their own signature question for this situation.
- Style never overrides reality: when an aggressive play was bad, Xun-style and Oner-style say so too.

${FRAMEWORK}

# Voice
Talk like a real Challenger coach in a private session: direct and specific, no filler, no generic praise. Use game-clock timings, camp names, lanes and ward spots. Markdown headings and short bullets.

${FORMATS}

${PROFILE_BLOCK}`;

// Compact system prompt for small local models (Ollama). Only the requested panelists.
export function localSystemPrompt(panel = PERSONA_ORDER) {
  const ids = panel.filter((id) => PERSONAS[id]);
  return `You are JungleCoach, a Challenger-level League of Legends jungle coach giving a private VOD review. Be direct, specific and honest. Never invent events you can't see; say when you are inferring.

Coaching panel (AI emulations of public playstyles, not the real players):
${ids.map((id) => `- ${PERSONAS[id].brief} Signature question: "${PERSONAS[id].question}"`).join("\n")}

${FRAMEWORK}

${FORMATS}

${PROFILE_BLOCK}`;
}

// Prompt for the local "observe" stage: small vision models describe frames as facts first.
export const OBSERVE_PROMPT = `You are analyzing screenshots from a League of Legends game for a jungle coach. Report ONLY what you can actually see, as short factual bullets. Do not give advice.
For full-screen images: in-game clock, the player's champion level/HP/mana if visible, gold, scoreboard (kills), what is happening on screen (fight, farming a camp, walking, recalling, objective).
For minimap images: where the player's own icon is (which lane / jungle quadrant / river / base), visible allied and enemy champion icons and where they are, any fight or objective activity, lane minion waves if visible.
If something is unreadable, write "unclear". Keep it under 15 bullets.`;

// ---------------------------------------------------------------------------
// Per-request content builders
// ---------------------------------------------------------------------------

function fmtSetup(setup = {}) {
  const line = (k, v) => (v && String(v).trim() ? `- ${k}: ${String(v).trim()}` : null);
  return (
    [
      line("Player's jungle champion", setup.champion),
      line("Enemy jungler", setup.enemyJungler),
      line("Player's team (top/jg/mid/adc/sup)", setup.allies),
      line("Enemy team (top/jg/mid/adc/sup)", setup.enemies),
      line("Side", setup.side),
      line("Rank", setup.rank),
      line("Patch", setup.patch),
      line("What the player wants to work on", setup.goals),
    ]
      .filter(Boolean)
      .join("\n") || "- (no setup provided)"
  );
}

function fmtPanel(panel = PERSONA_ORDER, lead) {
  const names = panel.filter((id) => PERSONAS[id]).map((id) => PERSONAS[id].name);
  const leadName = PERSONAS[lead]?.name;
  return `Panelists requested: ${names.join(", ") || "all"}.${leadName ? ` Lead coach: ${leadName}-style (let this style's priorities frame "What You Should Have Done", but stay objective).` : ""}`;
}

export function fmtProfile(profile) {
  if (!profile) return "";
  const top = (arr) =>
    (arr || [])
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map((h) => `- ${h.text} (seen ${h.count}x)`)
      .join("\n");
  const m = top(profile.mistakes);
  const s = top(profile.strengths);
  if (!m && !s) return "";
  return `# Player profile from previous reviews\nRecurring mistakes:\n${m || "- none yet"}\nStrengths:\n${s || "- none yet"}\nIf this review shows a recurring mistake again, point it out explicitly ("this is the same habit as before").`;
}

export function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || "");
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function momentHeader({ setup, moment, panel, lead, profile, riotDigest }, imageNote) {
  return [
    "MOMENT REVIEW",
    fmtPanel(panel, lead),
    "",
    "# Game setup",
    fmtSetup(setup),
    "",
    fmtProfile(profile),
    riotDigest ? `\n# Match-data digest (Riot API)\n${riotDigest}` : "",
    "",
    "# The moment",
    `- VOD time: ${moment.vodTime}${moment.gameTime ? ` | In-game clock: ${moment.gameTime}` : " | In-game clock: not synced, read it from the frames"}`,
    moment.note ? `- What the player was thinking / doing: ${moment.note}` : null,
    moment.question ? `- The player's question: ${moment.question}` : null,
    "",
    imageNote,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

function gameHeader({ setup, moments, panel, lead, profile, riotDigest, notes }, imageNote) {
  const momentLines = (moments || [])
    .map((m) => `- ${m.gameTime || m.vodTime}: ${m.note || "(no note)"}${m.question ? ` | Q: ${m.question}` : ""}`)
    .join("\n");
  return [
    "GAME REVIEW",
    fmtPanel(panel, lead),
    "",
    "# Game setup",
    fmtSetup(setup),
    notes ? `- Player's notes on the game: ${notes}` : null,
    "",
    fmtProfile(profile),
    riotDigest ? `\n# Match-data digest (Riot API)\n${riotDigest}` : "",
    momentLines ? `\n# Moments the player flagged\n${momentLines}` : "",
    "",
    imageNote,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

// Content blocks (Anthropic format, also used by Claude Code) with images interleaved.
function frameBlocks(frames = []) {
  const out = [];
  for (const f of frames) {
    const img = parseImage(f.dataUrl);
    if (!img) continue;
    out.push({ type: "text", text: `[${f.label}]` });
    out.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  return out;
}

export function buildMomentContent(args) {
  const note = `Below are ${args.frames.length} images in chronological order: full-screen frames and zoomed minimap crops leading up to and just after the moment. Labels give VOD time and relative offset.`;
  return [{ type: "text", text: momentHeader(args, note) }, ...frameBlocks(args.frames), { type: "text", text: "Review this moment now." }];
}

export function buildGameContent(args) {
  const note = `Below are ${args.frames.length} images sampled across the whole VOD in chronological order: mostly zoomed minimap crops (to follow pathing and rotations) plus some full-screen frames.`;
  return [{ type: "text", text: gameHeader(args, note) }, ...frameBlocks(args.frames), { type: "text", text: "Give the full game review now." }];
}

// Text-only prompt for the local two-stage pipeline (observations replace images).
export function buildLocalCoachPrompt(kind, args, observations) {
  const note = `Observations extracted from the VOD frames (by a vision model; may contain errors, treat "unclear" as unknown):\n${observations}`;
  const header = kind === "game" ? gameHeader(args, note) : momentHeader(args, note);
  return `${header}\n\n${kind === "game" ? "Give the full game review now." : "Review this moment now."}`;
}

// Pull the hidden coach-data block out of a finished answer.
export function extractCoachData(text) {
  const re = /```coach-data\s*([\s\S]*?)```/;
  const m = re.exec(text);
  if (!m) return { clean: text.trim(), data: null };
  let data = null;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    data = null;
  }
  return { clean: text.replace(re, "").trim(), data };
}
