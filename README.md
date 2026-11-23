# JungleCoach: AI pro-level jungle VOD reviewer

Load your League of Legends VOD, flag the moments that matter, and get coached by a Challenger-level AI coach with a pro panel. Each panelist is an AI emulation of a pro jungler's publicly known playstyle:

| Coach | Style | Focus |
|---|---|---|
| **Xun** | The Invader (LPL) | Tempo, invades, fighting the enemy jungler head-on |
| **Inspired** | The Architect (LEC/LCS) | Pathing planned backwards from goals, tracking, wave states |
| **Canyon** | The Carry (LCK) | Farm efficiency, power curves, converting every lead |
| **Oner** | The Enforcer (LCK) | Early lane pressure, dives, frontline engage |

> The coaches are AI emulations based on public knowledge of each player's style. They are not the real players and have no affiliation with them or their teams.

## What you get
- **Moment review:** for every play you flag, you get *The Read* (game state), a *Verdict*, *What You Should Have Done*, what **each pro** would have done (they sometimes disagree), *The Lesson*, and a *Drill*.
- **Full game review:** the coach follows your whole game through the minimap and grades your pathing, tracking, ganking, objectives, vision, fighting and risk. You also get your 3 biggest mistakes, each pro's game plan for your draft, and homework for your next 5 games.
- **Follow-up chat:** ask "what if my mid had no prio?" or "how would Canyon path Graves here?"
- **My Progress:** tracks your recurring mistakes across reviews. The coach sees this list and calls you out when you repeat a habit.
- **Riot match data (optional):** imports the real match timeline (your position and the enemy jungler's every minute, gold, CS, levels, kills, objectives) so the coach works from ground truth.

## Setup (Windows): free
1. Install [Node.js](https://nodejs.org) 22 or newer.
2. Double-click **`start.bat`**. It installs dependencies the first time and opens http://localhost:5178.
3. Click **⚙ Engine** and pick one of the free engines:

| Engine | Cost | Quality | One-time setup |
|---|---|---|---|
| **Claude Code (your Claude subscription)** | $0 extra (uses your Pro/Max plan's usage limits) | Best | Click **Log in to Claude** in the Engine dialog and sign in |
| **Local AI (Ollama)** | 100% free, offline | Good with Riot data, weaker at reading the minimap | Install [Ollama](https://ollama.com), then `ollama pull qwen2.5vl:7b` |
| Claude API | Paid per review | Best | API key from console.anthropic.com |

The Claude Code engine deliberately strips any API key from its environment, so it always runs on your subscription and never bills an API key.

**Local AI on a 6 GB GPU (e.g. RTX 4050):** `qwen2.5vl:7b` gives the best quality and `gemma3:4b` is faster. For better coaching text you can also `ollama pull qwen3:8b` and pick it as the **Coach model**: the vision model reads the frames, then the coach model writes the review. A full-game review takes a few minutes locally.

Optional: a free **Riot API key** from https://developer.riotgames.com (dev keys expire every 24h). Highly recommended with the local engine.

Your video never leaves your PC. With Local AI, nothing leaves your PC at all.

## How to use it
1. **Setup tab:** enter your champion, the enemy jungler, both team comps, your rank and what you want to improve. Or import the match with your Riot ID, which fills these in automatically.
2. **Load your VOD** by dragging it onto the player.
3. **⏱ Sync clock:** pause on a frame where the in-game timer is visible and type what it shows. All timestamps then use game time.
4. **🗺 Set minimap:** drag a box around your minimap (check the preview in the Setup tab). Do this once and it is remembered.
5. Pause on deaths, ganks, objective fights and decisions you weren't sure about, then press **M**. Write what you were thinking, because that is what the coach corrects.
6. Click **Review with coach** on a moment, or run **3 · Full Game**.

## Tips for the best coaching
- Record with the **minimap visible and reasonably large**. It is the coach's main source for pathing and tracking.
- Always write your intent in the note ("I thought their jungler was top"). Decision errors are where you improve fastest.
- Set the **look-back** to 60–90s for pathing and tempo questions, and 15–30s for fights.
- Import Riot match data whenever you can. It removes the guesswork about where the enemy jungler was.

## Configuration (`.env`)
| Variable | Default | Meaning |
|---|---|---|
| `COACH_BACKEND` | auto | `claudecode`, `ollama` or `anthropic` (set from the Engine dialog) |
| `CC_MODEL` | `opus` | Claude Code model (`opus`/`sonnet`) |
| `OLLAMA_VISION_MODEL` / `OLLAMA_COACH_MODEL` | first vision model | Local models |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama address |
| `CLAUDE_CODE_PATH` | auto-detected | Path to `claude.exe` if not found automatically |
| `ANTHROPIC_API_KEY` | | Only for the paid Claude API engine |
| `RIOT_API_KEY` | | Optional match-timeline import |
| `COACH_MODEL` | `claude-opus-5-5` | Claude model |
| `COACH_EFFORT` | `high` | `low`/`medium`/`high`/`xhigh`/`max`. Higher means deeper analysis at higher cost |
| `COACH_FALLBACKS` | on | Server-side refusal fallback; set `off` to disable |
| `PORT` | `5178` | Local port |

**Usage:** a moment review sends about 12 images, and a full game review sends up to 95 small minimap crops plus a few screenshots. On the Claude Code engine that counts toward your plan's usage limits (pick Sonnet to use less). The local engine reads at most 42 of them in batches.

## Files
- `coach/personas.js`: the four pro coaching styles (edit these to tune each coach)
- `coach/prompts.js`: the coaching framework, output formats and request builders
- `coach/riot.js`: Riot API import and timeline digest
- `coach/backends.js`: the three engines (Claude Code, Ollama, Claude API)
- `server.js`: local server (streaming, reviews, profile)
- `public/`: the web app (video player, frame capture, UI)
- `data/`: your saved reviews and habit profile
