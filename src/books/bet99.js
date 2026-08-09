'use strict';

/**
 * BET99 sportsbook client (Amelco platform).
 *
 * Everything comes from one public GraphQL endpoint, /java-graphql/graphql,
 * via the `betSync` query. Introspection is disabled, so the selection sets
 * below are the ones the site itself ships.
 *
 * Note the live price stream (wss://bet99.com/graphql-ws) 403s for
 * non-browser clients — but `selection.odds` on the HTTP query carries the
 * same decimal prices, so polling this endpoint is sufficient.
 */

const { postJson, mapLimit } = require('../http');
const { normalizeTeam, normalizePlayer, canonicalLeague } = require('../normalize');
const { DEFAULT_KEYS } = require('../leagues');
const { FAMILIES, isMarginFamily } = require('../markets');

const ENDPOINT = 'https://bet99.com/java-graphql/graphql';
const SPORT = 'E_LEAGUE_OF_LEGENDS';
const LEAGUE_PAGE = 'https://bet99.com/en/esports/e_league_of_legends';

const HEADERS = { origin: 'https://bet99.com', referer: LEAGUE_PAGE };

/** "LPL split 3 2026" -> "lpl-split-3-2026" */
const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Deep link to a single event page, e.g.
 * /en/esports/e_league_of_legends/lpl/lpl-split-3-2026/bilibili-gaming-vs-top-esports/4970487
 *
 * The router resolves the event from the trailing id — the category, competition
 * and fixture slugs are cosmetic — so a slug that drifts from BET99's own
 * wording still lands on the right page.
 */
function eventUrl({ league, competition, name, id }) {
  return [
    'https://bet99.com/en/esports',
    SPORT.toLowerCase(),
    slug(league),
    slug(competition),
    slug(name),
    id,
  ].filter(Boolean).join('/');
}

const BASE_VARS = {
  channel: 'BET99_MASTER',
  segment: 'bet99',
  region: 'ca',
  language: 'en',
};

const TREE_QUERY = `query betSync($sports:[String],$segment:String,$region:String,$language:String,$channel:String,$nonTradingFilters:[NodeFilterType]){
  betSync(cmsSegment:$segment,region:$region,language:$language,channel:$channel,eventParams:{sportList:$sports}){
    sports(filters:$nonTradingFilters){
      id code
      categories(filters:$nonTradingFilters){
        id name
        competitions(filters:$nonTradingFilters){ id name numEventsDisplayed }
      }
    }
  }
}`;

const EVENTS_QUERY = `query betSync($filters:[Filter],$segment:String,$region:String,$language:String,$channel:String,$sports:[String],$slice:Interval,$sort:Sort){
  betSync(cmsSegment:$segment,region:$region,language:$language,channel:$channel){
    events(filters:$filters,sports:$sports,slice:$slice,sort:$sort){
      count
      data{ id compId compName eventTime name numMarkets displayed bestOf
        participants{ id name shortName } }
    }
  }
}`;

const MARKETS_QUERY = `query betSync($filters:[Filter],$segment:String,$region:String,$language:String,$channel:String,$sports:[String]){
  betSync(cmsSegment:$segment,region:$region,language:$language,channel:$channel){
    events(filters:$filters,sports:$sports){
      data{ id compId compName eventTime name
        participants{ id name shortName }
        markets{ id name type subtype line suspended state displayed
          selection{ id name type odds displayed suspended } } }
    }
  }
}`;

async function gql(query, variables) {
  const res = await postJson(
    ENDPOINT,
    { operationName: 'betSync', query, variables: { ...BASE_VARS, ...variables } },
    { headers: HEADERS },
  );
  if (res.errors?.length) throw new Error(`bet99 graphql: ${res.errors[0].message}`);
  return res.data.betSync;
}

/** Category name -> competition ids, so callers can filter by "LPL"/"LCK"/... */
async function leagueMap() {
  const data = await gql(TREE_QUERY, { sports: [SPORT], nonTradingFilters: ['DISPLAYED'] });
  const sport = (data.sports || []).find((s) => s.code === SPORT);
  const byCompId = new Map();
  for (const cat of sport?.categories || []) {
    for (const comp of cat.competitions || []) {
      byCompId.set(String(comp.id), { league: cat.name, competition: comp.name });
    }
  }
  return byCompId;
}

async function listEvents() {
  const data = await gql(EVENTS_QUERY, {
    sports: [SPORT],
    filters: [
      { field: 'outright', value: 'false' },
      { field: 'displayed', value: 'true' },
    ],
    slice: { from: 0, to: 499 },
    sort: { field: 'eventTime', descending: false },
  });
  return data.events?.data || [];
}

async function fetchMarkets(eventIds) {
  const data = await gql(MARKETS_QUERY, {
    sports: [SPORT],
    filters: [{ field: 'id', values: eventIds.map(String) }],
  });
  return data.events?.data || [];
}

/**
 * Market type suffix -> canonical family. The type is authoritative here:
 * "X Total Kills Over/Under 2.5 (Map 1)" is worded identically for a team and
 * for a player, and only PLAYTKOU vs TEAMTKOU tells them apart.
 *
 * Types with no Betway counterpart (drakes, towers, most-X, 3-way markets,
 * ACCA combos, exact-score buckets) are left out on purpose.
 */
const TYPE_FAMILY = {
  'FT:ML': 'match_winner',
  'FT:CS': 'correct_score',
  'FT:MHCP': 'maps_handicap',
  'FT:MOU': 'total_maps',
  'FT:KHCP': 'match_kills_handicap',
  'FT:PWAM': 'win_at_least_one_map',

  'P:ML': 'map_winner',
  'P:TOTKILLOU': 'map_total_kills',
  'P:KHCP': 'map_kills_handicap',
  'P:THCP': 'map_towers_handicap',
  'P:DRHCP': 'map_dragons_handicap',
  'P:TOTNSHOU': 'map_total_barons',
  'P:TOTTOWOU': 'map_total_towers',
  'P:TOTDROU': 'map_total_dragons',
  'P:TOTKILLOE': 'map_kills_odd_even',
  'P:FIRSTBLOOD': 'first_blood',
  'P:FIRSTINH': 'first_inhibitor',
  'P:FIRSTNSH': 'first_baron',
  'P:TEAMTKOU': 'team_total_kills',
  'P:PLAYTKOU': 'player_kills',
};

const SCOPE_RE = /\(map\s*(\d+)\)\s*$/i;

/** "<subject> Total Kills Over/Under 2.5 (Map 1)" / "<subject> To Win A Map" */
const SUBJECT_RES = [
  /^(.+?)\s+total\s+[a-z ]+?\s+over\/under\b/i,
  /^(.+?)\s+to win a map$/i,
];

function classifyMarket(market) {
  const suffix = String(market.type || '').replace(/^E_LEAGUE_OF_LEGENDS:/, '');
  const family = TYPE_FAMILY[suffix];
  if (!family) return null;

  const name = String(market.name || '');
  const scope = SCOPE_RE.test(name) ? Number(SCOPE_RE.exec(name)[1]) : 0;

  let subject = null;
  if (FAMILIES[family].subject !== 'none') {
    for (const re of SUBJECT_RES) {
      const m = re.exec(name.replace(SCOPE_RE, '').trim());
      if (m) { subject = m[1].trim(); break; }
    }
    if (!subject) return null;
  }
  return { family, scope, subject };
}

/** Trailing signed number on a handicap selection: "Bilibili Gaming -12.5". */
const HCAP_RE = /^(.*?)\s*([+-]\d+(?:\.\d+)?)$/;
/** "Over 2.5" / "Under 31.5" */
const OU_RE = /^(over|under)\s+(-?\d+(?:\.\d+)?)$/i;

function readSelection(family, market, sel, participants) {
  const name = String(sel.name || '').trim();
  const type = String(sel.type || '').trim();
  const meta = FAMILIES[family];

  if (isMarginFamily(family)) {
    const m = HCAP_RE.exec(name);
    if (!m) return null;
    return { team: m[1].trim(), handicap: Number(m[2]) };
  }

  if (meta.metric === 'total') {
    const m = OU_RE.exec(name);
    if (m) return { side: m[1].toLowerCase(), line: Number(m[2]) };
    // Fall back to the market's own line when the selection is bare.
    const side = /^over$/i.test(type) ? 'over' : /^under$/i.test(type) ? 'under' : null;
    const line = Number(market.line);
    return side && Number.isFinite(line) ? { side, line } : null;
  }

  if (family === 'correct_score') {
    // Type is home-first from BET99's own A/B ordering, e.g. "2-1" or "1-2".
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(type || name);
    if (!m || !participants[0]) return null;
    return { team: participants[0].name, self: +m[1], opp: +m[2] };
  }

  const lower = (type || name).toLowerCase();
  if (lower === 'yes' || lower === 'no') return { outcome: lower };
  if (lower === 'odd' || lower === 'even') return { outcome: lower };
  if (name) return { team: name };
  return null;
}

function extractProps(evt, leagues) {
  const participants = evt.participants || [];
  const [home, away] = participants;
  const meta = leagues?.get(String(evt.compId));

  const event = {
    book: 'bet99',
    id: String(evt.id),
    name: evt.name,
    league: canonicalLeague(meta?.league || evt.compName),
    competition: evt.compName,
    home: home?.name || '',
    away: away?.name || '',
    homeKey: normalizeTeam(home?.name),
    awayKey: normalizeTeam(away?.name),
    startTime: Number(evt.eventTime),
    url: '',
  };
  event.url = eventUrl(event);

  const quotes = [];
  for (const market of evt.markets || []) {
    if (market.suspended || market.displayed === false) continue;
    if (market.state && market.state !== 'OPEN') continue;

    const cls = classifyMarket(market);
    if (!cls) continue;

    for (const sel of market.selection || []) {
      if (sel.suspended || sel.displayed === false) continue;
      const odds = Number(sel.odds);
      if (!Number.isFinite(odds) || odds <= 1) continue;

      const parsed = readSelection(cls.family, market, sel, participants);
      if (!parsed) continue;

      quotes.push({
        book: 'bet99',
        eventId: event.id,
        family: cls.family,
        scope: cls.scope,
        subject: cls.subject || null,
        subjectKey: subjectKey(cls.family, cls.subject),
        ...parsed,
        odds,
        outcomeLabel: sel.name,
        marketTitle: market.name,
        url: event.url,
        ref: { marketId: market.id, selectionId: sel.id },
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
 * Fetch every LoL market BET99 is currently pricing that we can canonicalise.
 * @param {object} opts
 * @param {string[]|null} opts.leagues category names to keep; null = all
 * @param {number} opts.withinMs only events starting within this window
 */
async function collect({
  leagues = DEFAULT_KEYS,
  withinMs = 24 * 3600e3,
  batchSize = 6,
  concurrency = 3,
  onWarn,
} = {}) {
  const now = Date.now();
  const byCompId = await leagueMap().catch((err) => {
    onWarn?.(`bet99 tree: ${err.message}`);
    return new Map();
  });

  const wanted = leagues ? new Set(leagues.map((l) => l.toUpperCase())) : null;
  const all = await listEvents();

  const candidates = all.filter((e) => {
    const t = Number(e.eventTime);
    if (!(t > now - 3600e3 && t < now + withinMs)) return false;
    if (!wanted) return true;
    const league = byCompId.get(String(e.compId))?.league || e.compName || '';
    return wanted.has(canonicalLeague(league));
  });

  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize).map((e) => e.id));
  }

  const events = [];
  const quotes = [];
  await mapLimit(batches, concurrency, async (ids) => {
    try {
      for (const evt of await fetchMarkets(ids)) {
        const { event, quotes: qs } = extractProps(evt, byCompId);
        events.push(event);
        quotes.push(...qs);
      }
    } catch (err) {
      onWarn?.(`bet99 events ${ids.join(',')}: ${err.message}`);
    }
  });

  return { events, quotes };
}

module.exports = {
  collect, listEvents, fetchMarkets, leagueMap, extractProps, classifyMarket, eventUrl, slug,
};
