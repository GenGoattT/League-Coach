// Optional Riot API integration: turns a match timeline into a compact text digest
// the coach can use as ground truth (per-minute positions, gold, CS, kills, objectives).

const CLUSTERS = new Set(["americas", "europe", "asia", "sea"]);

async function riotGet(url) {
  const key = process.env.RIOT_API_KEY;
  if (!key) throw Object.assign(new Error("No Riot API key set (Settings)."), { status: 400 });
  const r = await fetch(url, { headers: { "X-Riot-Token": key } });
  if (!r.ok) {
    const msg =
      r.status === 401 || r.status === 403
        ? "Riot API key is invalid or expired (development keys expire every 24h)."
        : r.status === 404
          ? "Not found on Riot's servers (check Riot ID and region)."
          : r.status === 429
            ? "Riot API rate limit hit, wait a minute."
            : `Riot API error ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.json();
}

function cluster(region) {
  if (!CLUSTERS.has(region)) throw Object.assign(new Error("Unknown region cluster"), { status: 400 });
  return region;
}

export async function findMatches(riotId, region) {
  const c = cluster(region);
  const [gameName, tagLine] = String(riotId || "").split("#");
  if (!gameName || !tagLine) throw Object.assign(new Error("Use the format Name#TAG"), { status: 400 });
  const accountCluster = c === "sea" ? "asia" : c;
  const acct = await riotGet(
    `https://${accountCluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
  );
  const ids = await riotGet(`https://${c}.api.riotgames.com/lol/match/v5/matches/by-puuid/${acct.puuid}/ids?count=8`);
  const matches = [];
  for (const id of ids) {
    try {
      const m = await riotGet(`https://${c}.api.riotgames.com/lol/match/v5/matches/${id}`);
      const p = m.info.participants.find((x) => x.puuid === acct.puuid);
      if (!p) continue;
      matches.push({
        id,
        champion: p.championName,
        position: p.teamPosition,
        win: p.win,
        kda: `${p.kills}/${p.deaths}/${p.assists}`,
        duration: Math.round(m.info.gameDuration / 60),
        when: m.info.gameCreation,
        queue: m.info.queueId,
      });
    } catch {
      /* skip unreadable match */
    }
  }
  return { puuid: acct.puuid, matches };
}

// ---- Map zone approximation (Summoner's Rift coords ~0..14870, blue base bottom-left)
function zone(pos) {
  if (!pos) return "unknown";
  const { x, y } = pos;
  if (x < 4200 && y < 4200 && x + y < 6500) return "blue base";
  if (x > 10700 && y > 10700 && x + y > 23200) return "red base";
  if ((x < 2100 && y >= 4200) || (y > 12800 && x <= 10700)) return "top lane";
  if ((y < 2100 && x >= 4200) || (x > 12800 && y <= 10700)) return "bot lane";
  if (Math.abs(x - y) < 1100) return "mid lane";
  const s = x + y;
  const topSide = y > x;
  if (Math.abs(s - 14870) < 1300) return topSide ? "top river" : "bot river";
  const side = s < 14870 ? "blue" : "red";
  return `${side} ${topSide ? "top-side" : "bot-side"} jungle`;
}

const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export async function buildDigest(matchId, puuid, region) {
  const c = cluster(region);
  if (!/^[A-Z0-9]+_\d+$/.test(matchId)) throw Object.assign(new Error("Bad match id"), { status: 400 });
  const [match, tl] = await Promise.all([
    riotGet(`https://${c}.api.riotgames.com/lol/match/v5/matches/${matchId}`),
    riotGet(`https://${c}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`),
  ]);
  return digestFrom(match, tl, puuid);
}

export function digestFrom(match, tl, puuid) {
  const parts = match.info.participants;
  const me = parts.find((p) => p.puuid === puuid);
  if (!me) throw Object.assign(new Error("Player not found in this match"), { status: 404 });
  const myTeam = me.teamId;
  const enemyJg = parts.find((p) => p.teamId !== myTeam && p.teamPosition === "JUNGLE");
  const allyJg = me;
  const champ = Object.fromEntries(parts.map((p) => [p.participantId, p.championName]));
  const team = Object.fromEntries(parts.map((p) => [p.participantId, p.teamId === myTeam ? "ally" : "enemy"]));
  const order = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
  const comp = (tid) =>
    parts
      .filter((p) => p.teamId === tid)
      .sort((a, b) => order.indexOf(a.teamPosition) - order.indexOf(b.teamPosition))
      .map((p) => p.championName)
      .join(", ");
  const enemyTeamId = myTeam === 100 ? 200 : 100;
  const who = (id) => (id ? `${team[id] === "ally" ? "" : "enemy "}${champ[id]}${id === allyJg.participantId ? " (YOU)" : ""}` : "minions/tower");

  const lines = [];
  lines.push(
    `Player: ${me.championName} (${me.teamId === 100 ? "blue" : "red"} side), result: ${me.win ? "WIN" : "LOSS"}, KDA ${me.kills}/${me.deaths}/${me.assists}, ${Math.round(match.info.gameDuration / 60)} min.`
  );
  lines.push(`Allies: ${comp(myTeam)} | Enemies: ${comp(enemyTeamId)}`);
  lines.push("");
  lines.push("Per-minute snapshot (YOU vs enemy jungler): clock | level | jungle CS | total gold (gold diff) | your zone | enemy jungler zone");

  const evLines = [];
  for (const fr of tl.info.frames) {
    const t = mmss(fr.timestamp);
    const a = fr.participantFrames?.[allyJg.participantId];
    const e = enemyJg ? fr.participantFrames?.[enemyJg.participantId] : null;
    if (a && fr.timestamp > 0) {
      const diff = e ? a.totalGold - e.totalGold : 0;
      lines.push(
        `${t} | lv${a.level}${e ? ` vs lv${e.level}` : ""} | jgCS ${a.jungleMinionsKilled}${e ? ` vs ${e.jungleMinionsKilled}` : ""} | ${a.totalGold}g (${diff >= 0 ? "+" : ""}${diff}) | ${zone(a.position)} | ${e ? zone(e.position) : "?"}`
      );
    }
    for (const ev of fr.events || []) {
      const et = mmss(ev.timestamp);
      if (ev.type === "CHAMPION_KILL") {
        const assists = (ev.assistingParticipantIds || []).map((id) => champ[id]).join(", ");
        const involved = [ev.killerId, ev.victimId, ...(ev.assistingParticipantIds || [])].includes(allyJg.participantId);
        evLines.push(
          `${et} KILL${involved ? " [you involved]" : ""}: ${who(ev.killerId)} killed ${who(ev.victimId)}${assists ? ` (assists: ${assists})` : ""} at ${zone(ev.position)}`
        );
      } else if (ev.type === "ELITE_MONSTER_KILL") {
        const kind = ev.monsterSubType ? `${ev.monsterType} (${ev.monsterSubType})` : ev.monsterType;
        evLines.push(`${et} OBJECTIVE: ${kind} taken by ${ev.killerTeamId === myTeam ? "YOUR TEAM" : "ENEMY TEAM"} (${who(ev.killerId)})`);
      } else if (ev.type === "BUILDING_KILL") {
        const lost = ev.teamId === myTeam; // teamId = team that owned the building
        evLines.push(`${et} ${lost ? "LOST" : "TOOK"} ${ev.buildingType === "TOWER_BUILDING" ? `${ev.towerType || "tower"}` : ev.buildingType} in ${ev.laneType || "?"}`);
      } else if (ev.type === "ITEM_PURCHASED" && ev.participantId === allyJg.participantId && ev.timestamp > 60000) {
        evLines.push(`${et} you bought item #${ev.itemId}`);
      }
    }
  }
  lines.push("");
  lines.push("Events:");
  lines.push(...evLines);
  return {
    digest: lines.join("\n"),
    meta: {
      champion: me.championName,
      enemyJungler: enemyJg?.championName || "",
      side: me.teamId === 100 ? "Blue" : "Red",
      allies: comp(myTeam),
      enemies: comp(enemyTeamId),
      result: me.win ? "Win" : "Loss",
    },
  };
}
