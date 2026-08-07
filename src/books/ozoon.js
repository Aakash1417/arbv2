'use strict';

/**
 * Ozoon client.
 *
 * Everything arrives over one public WebSocket feed (see ozoon-feed.js) — no
 * auth, no Cloudflare challenge. Two subscription shapes are used:
 *
 *   /competitions/117310   the League of Legends tree: leagues, fixtures,
 *                          start times and competitors (with home flags)
 *   /eventByLink/<path>    one fixture's full market book, delivered as two
 *                          `fullEvent` frames ("main" and "alternate") that
 *                          have to be merged
 *
 * Prices come as {american, decimal, fractional}; decimal is used as the
 * source of truth so every book converts identically.
 */

const feed = require('./ozoon-feed');
const { normalizeTeam, normalizePlayer } = require('../normalize');
const { FAMILIES, isMarginFamily } = require('../markets');

const SITE = 'https://www.ozoon.eu/sports';

const eventUrl = (link) => `${SITE}${link}`;

/**
 * Strip season/split decoration so "LPL Split 3" matches a request for "LPL",
 * while "LCK CL" stays distinct from "LCK" — they are different competitions.
 */
function canonicalLeague(description) {
  return String(description || '')
    .replace(/\b(split|summer|spring|winter|season|20\d\d|\d+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Ozoon periods: "Game" is the whole series, "Map N" a single map. */
function periodScope(period) {
  const d = String(period?.description || '');
  const m = /map\s*(\d+)/i.exec(d);
  if (m) return Number(m[1]);
  return /game/i.test(d) ? 0 : null;
}

/**
 * Market description -> canonical family. Order matters: "Asian Handicap
 * Kills" has to be seen before the generic asian-handicap rule, which would
 * otherwise claim it as the maps handicap.
 */
const DESC_RULES = [
  [/asian handicap kills/i, () => 'map_kills_handicap'],
  [/under\/over kills/i, () => 'map_total_kills'],
  [/^head to head$/i, (scope) => (scope === 0 ? 'match_winner' : 'map_winner')],
  [/asian[\s-]*handicap$/i, (scope) => (scope === 0 ? 'maps_handicap' : null)],
  [/main dynamic over\/under/i, (scope) => (scope === 0 ? 'total_maps' : null)],
  [/team to draw first blood/i, () => 'first_blood'],
  [/team to destroy the first inhibitor/i, () => 'first_inhibitor'],
  [/team to kill the first baron/i, () => 'first_baron'],
  [/first team to get 10 kills/i, () => 'race_to_10_kills'],
  [/total map kills odd\/even/i, () => 'map_kills_odd_even'],
  [/^correct score$/i, (scope) => (scope === 0 ? 'correct_score' : null)],
];

/** "Total kills - Bdd (KT)" -> the player prop, with the handle captured. */
const PLAYER_RE = /^total\s+kills\s*-\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/i;

/**
 * "Map Totals" is a grab-bag market whose outcomes each describe their own
 * quantity and line ("Total Barons Over 1.5 - Map 1"), so the family is
 * decided per outcome rather than per market.
 */
const MAP_TOTAL_RE = /^total\s+(towers?|dragons?|barons?)\s+(over|under)\s+(-?[\d.]+)/i;
const MAP_TOTAL_FAMILY = {
  tower: 'map_total_towers',
  dragon: 'map_total_dragons',
  baron: 'map_total_barons',
};

function classifyMarket(market) {
  const scope = periodScope(market.period);
  if (scope === null) return null;
  const desc = String(market.descriptionKey || market.description || '').trim();

  const player = PLAYER_RE.exec(desc);
  if (player) return { family: 'player_kills', scope, subject: player[1].trim() };

  for (const [re, pick] of DESC_RULES) {
    if (!re.test(desc)) continue;
    const family = pick(scope);
    return family && FAMILIES[family] ? { family, scope } : null;
  }
  if (/^map totals$/i.test(desc)) return { family: null, scope, perOutcome: true };
  return null;
}

const teamOf = (outcome, competitors) =>
  competitors.find((c) => c.id === outcome.competitorId)?.name || null;

/**
 * Turn one Ozoon outcome into the book-agnostic fragment the matcher expects.
 * Team-based outcomes keep the raw team name; home/away is resolved later
 * against the fixture's canonical frame.
 */
function readOutcome(family, outcome, competitors) {
  const price = outcome.price || {};
  const odds = Number(price.decimal);
  if (!Number.isFinite(odds) || odds <= 1) return null;

  const meta = FAMILIES[family];
  const desc = String(outcome.description || '');
  const base = { odds, outcomeLabel: desc };

  if (isMarginFamily(family)) {
    const team = teamOf(outcome, competitors);
    const handicap = Number(price.handicap);
    if (!team || !Number.isFinite(handicap)) return null;
    return { ...base, team, handicap };
  }

  if (meta.metric === 'total') {
    const side = outcome.type === 'O' ? 'over' : outcome.type === 'U' ? 'under' : null;
    const line = Number(price.handicap);
    if (!side || !Number.isFinite(line)) return null;
    return { ...base, side, line };
  }

  if (family === 'correct_score') {
    // Stated home-first, e.g. "2 - 1"; the outcome type (H/A) agrees.
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(desc.trim());
    if (!m || !competitors[0]) return null;
    const home = competitors.find((c) => c.home) || competitors[0];
    return { ...base, team: home.name, self: +m[1], opp: +m[2] };
  }

  const word = desc.replace(/\s*-\s*map\s*\d+\s*$/i, '').trim().toLowerCase();
  if (word === 'odd' || word === 'even') return { ...base, outcome: word };
  if (word === 'yes' || word === 'no') return { ...base, outcome: word };

  const team = teamOf(outcome, competitors);
  return team ? { ...base, team } : null;
}

/** Per-outcome families, for the mixed "Map Totals" market. */
function readMapTotalOutcome(outcome) {
  const price = outcome.price || {};
  const odds = Number(price.decimal);
  if (!Number.isFinite(odds) || odds <= 1) return null;
  const m = MAP_TOTAL_RE.exec(String(outcome.description || '').trim());
  if (!m) return null;
  const family = MAP_TOTAL_FAMILY[m[1].toLowerCase().replace(/s$/, '')];
  if (!family) return null;
  return {
    family,
    side: m[2].toLowerCase(),
    line: Number(m[3]),
    odds,
    outcomeLabel: outcome.description,
  };
}

const subjectKey = (family, subject) => {
  if (!subject) return null;
  return FAMILIES[family].subject === 'player'
    ? normalizePlayer(subject)
    : normalizeTeam(subject);
};

/** Merge the "main" and "alternate" fullEvent frames for one fixture. */
function mergeEventFrames(frames, eventId) {
  const parts = frames.filter(
    (f) => f.header?.type === 'fullEvent' && String(f.header.eventId) === String(eventId),
  );
  if (!parts.length) return null;
  const merged = { ...parts[0].body, displayGroups: [] };
  for (const p of parts) merged.displayGroups.push(...(p.body.displayGroups || []));
  return merged;
}

function extractProps(raw, league) {
  const competitors = raw.competitors || [];
  const home = competitors.find((c) => c.home) || competitors[0];
  const away = competitors.find((c) => !c.home) || competitors[1];
  if (!home || !away) return { event: null, quotes: [] };

  const event = {
    book: 'ozoon',
    id: String(raw.id),
    name: raw.description,
    league: league || '',
    home: home.name,
    away: away.name,
    homeKey: normalizeTeam(home.name),
    awayKey: normalizeTeam(away.name),
    startTime: Number(raw.startTime),
    url: eventUrl(raw.link),
  };

  const quotes = [];
  const push = (family, cls, parsed, market) => quotes.push({
    book: 'ozoon',
    eventId: event.id,
    family,
    scope: cls.scope,
    subject: cls.subject || null,
    subjectKey: subjectKey(family, cls.subject),
    ...parsed,
    marketTitle: market.description || market.descriptionKey,
    url: event.url,
    ref: { marketId: market.id, outcomeId: parsed.outcomeId },
  });

  for (const group of raw.displayGroups || []) {
    for (const market of group.markets || []) {
      if (market.status && market.status !== 'O') continue;
      const cls = classifyMarket(market);
      if (!cls) continue;

      for (const outcome of market.outcomes || []) {
        if (outcome.status && outcome.status !== 'O') continue;

        if (cls.perOutcome) {
          const parsed = readMapTotalOutcome(outcome);
          if (parsed) push(parsed.family, cls, parsed, market);
          continue;
        }
        const parsed = readOutcome(cls.family, outcome, competitors);
        if (parsed) push(cls.family, cls, parsed, market);
      }
    }
  }
  return { event, quotes };
}

/** League tree + fixtures, from a single competitions subscription. */
function parseCompetitions(frames) {
  const out = [];
  for (const f of frames) {
    if (f.header?.type !== 'competition' || !f.body) continue;
    const leagueNode = (f.body.path || []).find((p) => p.type === 'LEAGUE');
    const league = leagueNode?.description || '';
    for (const ev of f.body.events || []) {
      if (ev.type !== 'GAMEEVENT' || ev.live) continue;
      out.push({
        id: String(ev.id),
        link: ev.link,
        league,
        leagueKey: canonicalLeague(league),
        name: ev.description,
        startTime: Number(ev.startTime),
        numMarkets: Number(ev.numMarkets) || 0,
      });
    }
  }
  return out;
}

async function listEvents({ onWarn } = {}) {
  const frames = await feed.collectFrames([feed.competitionPath()], { onWarn });
  return parseCompetitions(frames);
}

/**
 * Fetch every LoL market Ozoon is currently pricing that we can canonicalise.
 *
 * The whole scan runs over one socket: the competition subscription and every
 * fixture subscription are fired together, then the feed is read until quiet.
 */
async function collect({
  leagues = ['LPL', 'LCK', 'LCS'],
  withinMs = 24 * 3600e3,
  onWarn,
} = {}) {
  const now = Date.now();
  const wanted = leagues ? new Set(leagues.map((l) => l.toUpperCase())) : null;

  const listing = await listEvents({ onWarn });
  const candidates = listing.filter((e) => {
    if (!(e.startTime > now - 3600e3 && e.startTime < now + withinMs)) return false;
    return !wanted || wanted.has(e.leagueKey);
  });

  if (!candidates.length) return { events: [], quotes: [] };

  const frames = await feed.collectFrames(
    candidates.map((e) => feed.eventPath(e.link)),
    { onWarn, timeoutMs: 60000 },
  );

  const events = [];
  const quotes = [];
  for (const cand of candidates) {
    const merged = mergeEventFrames(frames, cand.id);
    if (!merged) continue;
    const { event, quotes: qs } = extractProps(merged, cand.league);
    if (!event) continue;
    events.push(event);
    quotes.push(...qs);
  }
  return { events, quotes };
}

module.exports = {
  collect, listEvents, extractProps, classifyMarket, parseCompetitions,
  mergeEventFrames, canonicalLeague, periodScope, eventUrl,
};
