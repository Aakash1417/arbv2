'use strict';

/**
 * Betway (en-CA) sportsbook client.
 *
 * Two public, unauthenticated JSON endpoints behind /g/api/sports:
 *   content/getGroup        -> event ids + start times for a league
 *   content/getEventDetails -> every market/outcome for one event
 *
 * Both require the full brand/territory envelope; without it the gateway
 * answers ERR_NO_ROUTING_TARGET.
 */

const { randomUUID } = require('crypto');
const { postJson, mapLimit } = require('../http');
const { normalizeTeam, normalizePlayer, canonicalStat, SIDE } = require('../normalize');
const { FAMILIES, isLineFamily, isMarginFamily } = require('../markets');

const API = 'https://betway.com/g/api/sports';

const ENVELOPE = {
  BrandId: 3,
  LanguageId: 25,
  TerritoryId: 38,
  TerritoryCode: 'CA',
  ClientTypeId: 2,
  JurisdictionId: 2,
  ClientIntegratorId: 1,
};

const HEADERS = { origin: 'https://betway.com', referer: 'https://betway.com/g/en-ca/sports' };

const eventUrl = (id) => `https://betway.com/g/en-ca/sports/event/${id}`;

/**
 * Deep link straight to the tab holding the market, e.g.
 * .../event/17033494?marketGroup=map-1---player-specials
 * The slug is the market's own MarketGroupCName.
 */
const marketUrl = (id, groupCName) =>
  groupCName ? `${eventUrl(id)}?marketGroup=${groupCName}` : eventUrl(id);

/** League slugs as they appear in the /grp/esports/league-of-legends/<slug> URLs. */
const DEFAULT_LEAGUES = ['lpl', 'lck', 'lcs'];

async function listEvents(leagueSlug) {
  const data = await postJson(
    `${API}/content/getGroup`,
    {
      ...ENVELOPE,
      CorrelationId: randomUUID(),
      CategoryCName: 'esports',
      SubCategoryCName: 'league-of-legends',
      GroupCName: leagueSlug,
    },
    { headers: HEADERS },
  );
  if (!data.Success) {
    const msg = (data.Errors || []).map((e) => e.Message).join('; ') || 'unknown error';
    throw new Error(`betway getGroup(${leagueSlug}): ${msg}`);
  }
  return (data.EventSummaries || [])
    .filter((e) => !e.IsOutright)
    .map((e) => ({
      league: leagueSlug.toUpperCase(),
      eventId: e.EventId,
      // Betway stamps these as naive UTC strings.
      startTime: new Date(`${e.StartTime}Z`).getTime(),
    }));
}

async function fetchEvent(eventId) {
  return postJson(
    `${API}/content/getEventDetails`,
    {
      ...ENVELOPE,
      CorrelationId: randomUUID(),
      EventId: eventId,
      ScoreboardRequest: { IncidentRequest: {}, ScoreboardType: 3 },
    },
    { headers: HEADERS },
  );
}

/**
 * Title patterns, most specific first. Each returns the canonical family plus
 * the map it applies to (0 = whole series). `subject` is captured where the
 * market is per-team or per-player.
 *
 * Anything not listed here is deliberately ignored — combo markets
 * ("Map 1 Winner & Total Kills"), race-to-N, quadra/penta and game-time have
 * no BET99 counterpart, so pairing them would be guesswork.
 */
const TITLE_RULES = [
  // player props: "Map 1 - Total Kills - JackeyLove"
  [/^map\s*(\d+)\s*-\s*total\s+([a-z ]+?)\s*-\s*(.+)$/i,
    (m) => ({ family: statFamily(m[2]), scope: +m[1], subject: m[3].trim() })],
  [/^total\s+([a-z ]+?)\s*-\s*(.+)$/i,
    (m) => ({ family: statFamily(m[1]), scope: 0, subject: m[2].trim() })],

  // series
  [/^match winner$/i,                    () => ({ family: 'match_winner', scope: 0 })],
  [/^correct score$/i,                   () => ({ family: 'correct_score', scope: 0 })],
  [/^match up handicap$/i,               () => ({ family: 'maps_handicap', scope: 0 })],
  [/^total maps played over\/under$/i,   () => ({ family: 'total_maps', scope: 0 })],
  [/^match kills handicap$/i,            () => ({ family: 'match_kills_handicap', scope: 0 })],
  [/^match total kills$/i,               () => ({ family: 'match_total_kills', scope: 0 })],
  [/^(.+?) to win at least 1 map$/i,
    (m) => ({ family: 'win_at_least_one_map', scope: 0, subject: m[1].trim() })],

  // per map — specific wordings before the generic team-total fallback
  [/^map\s*(\d+)\s+winner$/i,            (m) => ({ family: 'map_winner', scope: +m[1] })],
  [/^map\s*(\d+)\s+total kills scored over\/under$/i,
    (m) => ({ family: 'map_total_kills', scope: +m[1] })],
  [/^map\s*(\d+)\s+team to score the most kills handicap$/i,
    (m) => ({ family: 'map_kills_handicap', scope: +m[1] })],
  [/^map\s*(\d+)\s+total barons slain over\/under$/i,
    (m) => ({ family: 'map_total_barons', scope: +m[1] })],
  [/^map\s*(\d+)\s+total kills odd\/even$/i,
    (m) => ({ family: 'map_kills_odd_even', scope: +m[1] })],
  [/^map\s*(\d+)\s+team to draw first blood$/i,
    (m) => ({ family: 'first_blood', scope: +m[1] })],
  [/^map\s*(\d+)\s+team to destroy the 1st inhibitor$/i,
    (m) => ({ family: 'first_inhibitor', scope: +m[1] })],
  [/^map\s*(\d+)\s+team to slay the 1st baron$/i,
    (m) => ({ family: 'first_baron', scope: +m[1] })],
  [/^map\s*(\d+)\s+race to 10 kills$/i,
    (m) => ({ family: 'race_to_10_kills', scope: +m[1] })],
  // Combo markets ("Map 1 Winner & Total Kills") end in "Total Kills" too, so
  // they have to be rejected before the team-total fallback sees them.
  [/^map\s*\d+\s+.*&/i, () => ({ family: null })],
  [/^map\s*(\d+)\s+(.+?)\s+total kills$/i,
    (m) => ({ family: 'team_total_kills', scope: +m[1], subject: m[2].trim() })],
];

const statFamily = (word) => (canonicalStat(`total ${word}`) === 'kills' ? 'player_kills' : null);

function classifyMarket(title) {
  for (const [re, build] of TITLE_RULES) {
    const m = re.exec(String(title).trim());
    if (!m) continue;
    const out = build(m);
    if (out.family && FAMILIES[out.family]) return out;
    return null;
  }
  return null;
}

/**
 * Turn one Betway outcome into the book-agnostic fragment the matcher expects.
 * Team-based outcomes keep the raw team name — home/away is resolved later
 * against whichever book is treated as the canonical frame for the fixture.
 */
function readOutcome(family, market, o, event) {
  const name = String(o.BetName || '').trim();
  const meta = FAMILIES[family];

  if (isMarginFamily(family)) {
    const hcap = Number(o.HandicapDisplay ?? o.Handicap ?? market.Handicap);
    if (!Number.isFinite(hcap)) return null;
    return { team: name, handicap: hcap };
  }

  if (meta.metric === 'total') {
    const side = SIDE(name);
    if (!side) return null;
    const line = Number(o.Handicap ?? o.HandicapDisplay ?? market.Handicap);
    return Number.isFinite(line) ? { side, line } : null;
  }

  // categorical
  if (family === 'correct_score') {
    // "Bilibili Gaming 2-0" -> that team wins 2-0
    const m = /^(.*?)\s*(\d+)\s*-\s*(\d+)$/.exec(name);
    if (!m) return null;
    return { team: m[1].trim(), self: +m[2], opp: +m[3] };
  }
  const lower = name.toLowerCase();
  if (lower === 'yes' || lower === 'no') return { outcome: lower };
  if (lower === 'odd' || lower === 'even') return { outcome: lower };
  // remaining categorical families are team pickers
  if (matchesEitherTeam(name, event)) return { team: name };
  return null;
}

const matchesEitherTeam = (name, event) => {
  const k = normalizeTeam(name);
  return k === event.homeKey || k === event.awayKey;
};

/** Turn one getEventDetails payload into normalized quotes. */
function extractProps(detail) {
  const ev = detail.Event;
  if (!ev) return { event: null, quotes: [] };

  const event = {
    book: 'betway',
    id: String(ev.Id),
    name: ev.EventName || `${ev.HomeTeamName} - ${ev.AwayTeamName}`,
    league: ev.GroupName,
    home: ev.HomeTeamName,
    away: ev.AwayTeamName,
    homeKey: normalizeTeam(ev.HomeTeamName),
    awayKey: normalizeTeam(ev.AwayTeamName),
    startTime: ev.Milliseconds,
    url: eventUrl(ev.Id),
  };

  const outcomeById = new Map((detail.Outcomes || []).map((o) => [o.Id, o]));
  const quotes = [];

  for (const market of detail.Markets || []) {
    if (market.IsSuspended) continue;
    const cls = classifyMarket(market.Title);
    if (!cls) continue;

    // Per-team markets must name a team we recognise, otherwise the title
    // regex has latched onto something else.
    if (FAMILIES[cls.family].subject === 'team' && !matchesEitherTeam(cls.subject, event)) continue;

    for (const id of (market.Outcomes || []).flat()) {
      const o = outcomeById.get(id);
      if (!o || !o.IsActive || !o.IsDisplay) continue;
      const odds = Number(o.OddsDecimal);
      if (!Number.isFinite(odds) || odds <= 1) continue;

      const parsed = readOutcome(cls.family, market, o, event);
      if (!parsed) continue;

      quotes.push({
        book: 'betway',
        eventId: event.id,
        family: cls.family,
        scope: cls.scope,
        subject: cls.subject || null,
        subjectKey: subjectKey(cls.family, cls.subject),
        ...parsed,
        odds,
        outcomeLabel: o.BetName,
        marketTitle: market.Title,
        url: marketUrl(event.id, market.MarketGroupCName),
        ref: { marketId: market.Id, outcomeId: o.Id },
      });
    }
  }
  return { event, quotes };
}

const subjectKey = (family, subject) => {
  if (!subject) return null;
  return FAMILIES[family].subject === 'player'
    ? normalizePlayer(subject)
    : normalizeTeam(subject);
};

/**
 * Fetch every LoL market Betway is currently pricing that we can canonicalise.
 * @param {object} opts
 * @param {string[]} opts.leagues league slugs (default LPL/LCK/LCS)
 * @param {number} opts.withinMs only events starting within this window
 * @param {number} opts.concurrency parallel event detail requests
 */
async function collect({ leagues = DEFAULT_LEAGUES, withinMs = 24 * 3600e3, concurrency = 4, onWarn } = {}) {
  const now = Date.now();
  const listings = [];

  for (const league of leagues) {
    try {
      listings.push(...(await listEvents(league)));
    } catch (err) {
      onWarn?.(`betway: ${err.message}`);
    }
  }

  const upcoming = listings.filter(
    (e) => e.startTime > now - 3600e3 && e.startTime < now + withinMs,
  );

  const events = [];
  const quotes = [];

  await mapLimit(upcoming, concurrency, async (summary) => {
    try {
      const detail = await fetchEvent(summary.eventId);
      const { event, quotes: qs } = extractProps(detail);
      if (!event) return;
      event.league = event.league || summary.league;
      events.push(event);
      quotes.push(...qs);
    } catch (err) {
      onWarn?.(`betway event ${summary.eventId}: ${err.message}`);
    }
  });

  return { events, quotes };
}

module.exports = {
  collect, listEvents, fetchEvent, extractProps, classifyMarket, DEFAULT_LEAGUES,
};
