'use strict';

/**
 * theScore Bet (Alberta) sportsbook client.
 *
 * Its frontend uses Apollo persisted GET queries. A public Startup query
 * returns a short-lived anonymous token; subsequent competition/event queries
 * send that token in x-anonymous-authorization. No account session or browser
 * state is involved.
 */

const { randomUUID } = require('crypto');
const { getJson, mapLimit } = require('../http');
const {
  canonicalLeague,
  normalizePlayer,
  normalizeTeam,
  SIDE,
} = require('../normalize');
const { FAMILIES, isMarginFamily } = require('../markets');
const { fromAmerican } = require('../odds');
const { DEFAULT_KEYS } = require('../leagues');

const ORIGIN = 'https://sportsbook.thescore.bet';
const API = 'https://sportsbook.ca-ab.thescore.bet/graphql/persisted_queries';

// These are the persisted operations shipped by the current public web app.
const OPERATIONS = {
  Startup: '8c52170d05417bcc2642d4fb132694a00b4825facf4f23fa47bb78f2b8b59d83',
  SportsMenu: '27e68b7528beaec518b78b90f3fc1f232618e0045890629272616a5be6d3bb16',
  CompetitionPage: '5a1f47ccb1ac7b7c1f7da8d6607e6d6c429b25ba57b749961711a6cd4aa32119',
  CompetitionPageSectionLinesTabNode:
    'bf8963f33b5a9f74940f9f1afca32e51ff1d4ed78ffc9503b5247f4b130cdce4',
  EventPage: 'ea73e76bd4a828b507a14359bc702885cf473358f8a519315f9ad9569f641aa1',
  EventSection: '8ac31d28c8fd43e02a73beebd64e888bb0390db701907ecbd7b633a1bf00a750',
  EventDrawerContent: '0f351a688287fbcb437b57d8b6ec26ded758eb18fc889ca04b2595f7aa6960f1',
};

const APP_VERSION = '26.17.1';
const SUPPORTED_KEYS = new Set([
  'LCS', 'LEC', 'LPL', 'CBLOL', 'PRIME LEAGUE', 'LES', 'LFL', 'CIRCUITO DESAFIANTE',
]);

const BASE_HEADERS = {
  origin: ORIGIN,
  referer: `${ORIGIN}/`,
  'x-platform': 'web',
  'x-app-version': APP_VERSION,
  'x-app': 'tsb',
  'x-client': 'tsb',
  'x-device': 'DESKTOP',
};

const eventUrl = (path, section = 'lines') => `${ORIGIN}${path}#${section}`;

function persistedUrl(operation, variables) {
  const hash = OPERATIONS[operation];
  if (!hash) throw new Error(`unknown persisted operation ${operation}`);
  const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };
  const params = new URLSearchParams({
    operationName: operation,
    variables: JSON.stringify(variables || {}),
    extensions: JSON.stringify(extensions),
  });
  return `${API}/${hash}?${params}`;
}

class ScorebetClient {
  constructor() {
    this.installId = randomUUID();
    this.token = null;
  }

  async query(operation, variables = {}) {
    const headers = {
      ...BASE_HEADERS,
      'x-apollo-operation-name': operation,
      'x-install-id': this.installId,
    };
    if (this.token) headers['x-anonymous-authorization'] = `Bearer ${this.token}`;

    const payload = await getJson(persistedUrl(operation, variables), { headers });
    if (payload.errors?.length) {
      const message = payload.errors.map((e) => e.message).filter(Boolean).join('; ');
      throw new Error(`${operation}: ${message || 'GraphQL error'}`);
    }
    return payload.data;
  }

  async startup() {
    const data = await this.query('Startup', { connectToken: `arbv2-${randomUUID()}` });
    const startup = data?.startup;
    if (!startup?.anonymousToken) throw new Error('Startup returned no anonymous token');
    if (startup.regionalMetadata?.validRegion === false) {
      throw new Error(`not available in ${startup.regionalMetadata.currentRegionCode || 'this region'}`);
    }
    this.token = startup.anonymousToken;
    return startup;
  }
}

/** Walk a GraphQL response without coupling extraction to a particular card UI. */
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  for (const child of Object.values(value)) walk(child, visit);
}

function rawId(id) {
  return String(id || '').replace(/^[^:]+:/, '');
}

function fullParticipant(participant) {
  return participant?.fullName || participant?.mediumName || participant?.abbreviation || '';
}

function eventSummaries(section, fallbackLeague = '') {
  const byId = new Map();
  walk(section, (node) => {
    const ev = node?.fallbackEvent;
    if (!ev || !String(ev.id).startsWith('StandardEvent:')) return;

    const id = rawId(ev.id);
    const home = fullParticipant(ev.homeParticipant);
    const away = fullParticipant(ev.awayParticipant);
    const startTime = Date.parse(ev.startTime);
    const path = ev.deepLink?.webUrl || node.deepLink?.webUrl;
    if (!id || !home || !away || !Number.isFinite(startTime) || !path) return;

    byId.set(id, {
      book: 'scorebet',
      id,
      name: ev.name || `${home} - ${away}`,
      league: canonicalLeague(ev.competition?.name || fallbackLeague),
      home,
      away,
      homeKey: normalizeTeam(home),
      awayKey: normalizeTeam(away),
      startTime,
      path,
      url: eventUrl(path),
      status: ev.status,
    });
  });
  return [...byId.values()];
}

function menuCompetitions(sportsMenu, wantedKeys) {
  const items = sportsMenu?.menuItems || [];
  const esports = items.find((i) => String(i.label).toLowerCase() === 'esports');
  const lol = (esports?.sportsMenuItemChildren || [])
    .find((i) => String(i.label).toLowerCase() === 'lol');

  return (lol?.sportsMenuItemChildren || [])
    .map((item) => ({
      league: canonicalLeague(item.label),
      label: item.label,
      path: item.deepLink?.webUrl,
    }))
    .filter((item) => item.path && wantedKeys.has(item.league));
}

const COMPETITION_SECTION_VARIABLES = {
  isSubscription: false,
  pageType: 'PAGE',
  includeRecommendedProps: true,
  isBrandingImageEnabled: false,
  isNewFeaturedBetParticipantLogoEnabled: true,
  isFeaturedBetCarouselHeaderRedesignEnabled: true,
  includeStandardizedBoxscore: true,
  isCfpRankingEnabled: true,
  isCombatSportsRedesignEnabled: true,
  isFeaturedMarketCardRedesignEnabled: true,
  isDsModelRecommendedPropsEnabled: true,
  isBlueprintUiFieldEnabled: false,
  includeRichEvent: true,
  oddsFormat: 'AMERICAN',
};

async function listCompetition(client, competition) {
  const pageData = await client.query('CompetitionPage', { canonicalUrl: competition.path });
  const lines = (pageData?.page?.pageChildren || [])
    .find((s) => s.slug === 'lines' || s.archetype === 'COMPETITION_LINES');
  if (!lines?.id || lines.hasContent === false) return [];

  const sectionData = await client.query('CompetitionPageSectionLinesTabNode', {
    ...COMPETITION_SECTION_VARIABLES,
    sectionId: lines.id,
    selectedFilterId: '',
  });
  return eventSummaries(sectionData?.competitionSection, competition.label);
}

const TITLE_RULES = [
  [/^moneyline$/i, () => ({ family: 'match_winner', scope: 0 })],
  [/^map spread$/i, () => ({ family: 'maps_handicap', scope: 0 })],
  [/^total maps$/i, () => ({ family: 'total_maps', scope: 0 })],
  [/^correct score(?:\s*-.*)?$/i, () => ({ family: 'correct_score', scope: 0 })],
  [/^map\s*(\d+)\s+winner$/i, (m) => ({ family: 'map_winner', scope: +m[1] })],
  [/^map\s*(\d+)\s+kill spread$/i,
    (m) => ({ family: 'map_kills_handicap', scope: +m[1] })],
  [/^map\s*(\d+)\s+total kills$/i,
    (m) => ({ family: 'map_total_kills', scope: +m[1] })],
  [/^map\s*(\d+)\s+total barons(?: slain)?$/i,
    (m) => ({ family: 'map_total_barons', scope: +m[1] })],
  [/^map\s*(\d+)\s+total towers$/i,
    (m) => ({ family: 'map_total_towers', scope: +m[1] })],
  [/^map\s*(\d+)\s+total dragons$/i,
    (m) => ({ family: 'map_total_dragons', scope: +m[1] })],
  [/^map\s*(\d+)\s+total kills odd\/even$/i,
    (m) => ({ family: 'map_kills_odd_even', scope: +m[1] })],
  [/^map\s*(\d+)\s+first blood$/i,
    (m) => ({ family: 'first_blood', scope: +m[1] })],
  [/^map\s*(\d+)\s+first baron(?: slain)?$/i,
    (m) => ({ family: 'first_baron', scope: +m[1] })],
  [/^map\s*(\d+)\s+first inhibitor(?: destroyed)?$/i,
    (m) => ({ family: 'first_inhibitor', scope: +m[1] })],
  [/^map\s*(\d+)\s+race to 10 kills$/i,
    (m) => ({ family: 'race_to_10_kills', scope: +m[1] })],
  [/^(.+?)\s+to win a map$/i,
    (m) => ({ family: 'win_at_least_one_map', scope: 0, subject: m[1].trim() })],
  [/^map\s*(\d+)\s+(.+?)\s+total kills$/i,
    (m) => ({ family: 'team_total_kills', scope: +m[1], subject: m[2].trim() })],
  [/^map\s*(\d+)\s*-\s*total kills\s*-\s*(.+)$/i,
    (m) => ({ family: 'player_kills', scope: +m[1], subject: m[2].trim() })],
];

function classifyMarket(title) {
  for (const [pattern, build] of TITLE_RULES) {
    const match = pattern.exec(String(title || '').trim());
    if (!match) continue;
    const out = build(match);
    return FAMILIES[out.family] ? out : null;
  }
  return null;
}

function readOdds(selection) {
  const numerator = Number(selection?.odds?.numeratorLong);
  const denominator = Number(selection?.odds?.denominatorLong);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    const decimal = numerator / denominator;
    if (decimal > 1) return decimal;
  }

  const shown = String(selection?.odds?.formattedOdds || '').trim();
  if (/^even$/i.test(shown)) return 2;
  return fromAmerican(shown.replace(/^\+/, ''));
}

function selectionName(selection) {
  return selection?.name?.fullName || selection?.name?.defaultName ||
    selection?.name?.cleanName || '';
}

function selectionTeam(selection) {
  return fullParticipant(selection?.participant) || selection?.name?.cleanName || selectionName(selection);
}

function readSelection(cls, market, selection) {
  const family = cls.family;
  const meta = FAMILIES[family];
  const name = selectionName(selection);

  if (isMarginFamily(family)) {
    const handicap = selection.points?.decimalPoints;
    if (!Number.isFinite(handicap)) return null;
    return { team: selectionTeam(selection), handicap };
  }

  if (meta.metric === 'total') {
    const side = SIDE(selection.type || name);
    const line = selection.points?.decimalPoints;
    return side && Number.isFinite(line) ? { side, line } : null;
  }

  if (family === 'correct_score') {
    const score = /(\d+)\s*-\s*(\d+)\s*$/.exec(name);
    if (!score) return null;
    return { team: selectionTeam(selection), self: +score[1], opp: +score[2] };
  }

  const lower = String(selection?.name?.cleanName || name).trim().toLowerCase();
  if (lower === 'yes' || lower === 'no' || lower === 'odd' || lower === 'even') {
    return { outcome: lower };
  }
  return { team: selectionTeam(selection) };
}

function marketNodes(drawer) {
  const byId = new Map();
  walk(drawer, (node) => {
    if (!String(node?.id || '').startsWith('Market:') || !Array.isArray(node.selections)) return;
    byId.set(node.id, node);
  });
  return [...byId.values()];
}

function subjectKey(family, subject) {
  if (!subject) return null;
  return FAMILIES[family].subject === 'player'
    ? normalizePlayer(subject)
    : normalizeTeam(subject);
}

function extractQuotes(drawer, event, section = 'lines') {
  const quotes = [];
  for (const market of marketNodes(drawer)) {
    if (market.status !== 'OPEN') continue;
    const cls = classifyMarket(market.name);
    if (!cls) continue;

    for (const selection of market.selections) {
      if (selection.status !== 'OPEN') continue;
      const odds = readOdds(selection);
      if (!Number.isFinite(odds) || odds <= 1) continue;
      const parsed = readSelection(cls, market, selection);
      if (!parsed) continue;

      quotes.push({
        book: 'scorebet',
        eventId: event.id,
        family: cls.family,
        scope: cls.scope,
        subject: cls.subject || null,
        subjectKey: subjectKey(cls.family, cls.subject),
        ...parsed,
        odds,
        outcomeLabel: selectionName(selection),
        marketTitle: market.name,
        url: eventUrl(event.path, section),
        ref: { marketId: rawId(market.id), selectionId: rawId(selection.id) },
      });
    }
  }
  return quotes;
}

const EVENT_PAGE_VARIABLES = {
  includeRichEvent: true,
  includeStandardizedBoxscore: true,
  isCfpRankingEnabled: true,
  isCombatSportsRedesignEnabled: true,
};

const EVENT_SECTION_VARIABLES = {
  includeFeaturedCarousel: false,
  includeQuickBetDetails: false,
  selectedMarketId: null,
};

async function fetchEvent(client, event, { drawerConcurrency = 6 } = {}) {
  const pageData = await client.query('EventPage', {
    ...EVENT_PAGE_VARIABLES,
    canonicalUrl: event.path,
  });
  const sections = (pageData?.page?.pageChildren || [])
    .filter((s) => s.id && s.hasContent !== false && (s.slug === 'lines' || s.slug === 'game_props'));

  const drawerJobs = [];
  for (const section of sections) {
    const data = await client.query('EventSection', {
      ...EVENT_SECTION_VARIABLES,
      sectionId: section.id,
    });
    for (const drawer of data?.eventSection?.sectionChildren || []) {
      if (!drawer.groupId) continue;
      drawerJobs.push({ groupId: drawer.groupId, section: section.slug });
    }
  }

  const chunks = await mapLimit(drawerJobs, drawerConcurrency, async (job) => {
    const data = await client.query('EventDrawerContent', {
      isSubscription: false,
      pageType: 'EVENT',
      eventDrawerInput: {
        groupId: job.groupId,
        sectionSlug: job.section,
        eventId: event.id,
      },
      oddsFormat: 'AMERICAN',
    });
    return extractQuotes(data?.eventDrawer, event, job.section);
  });
  return chunks.flat();
}

async function collect({
  leagues = DEFAULT_KEYS,
  withinMs = 24 * 3600e3,
  concurrency = 3,
  onWarn,
} = {}) {
  const client = new ScorebetClient();
  await client.startup();

  const wanted = new Set(
    (leagues || DEFAULT_KEYS)
      .map((name) => canonicalLeague(name))
      .filter((key) => SUPPORTED_KEYS.has(key)),
  );
  if (!wanted.size) return { events: [], quotes: [] };

  const menuData = await client.query('SportsMenu');
  const competitions = menuCompetitions(menuData?.sportsMenu, wanted);
  const listingChunks = await mapLimit(competitions, concurrency, async (competition) => {
    try {
      return await listCompetition(client, competition);
    } catch (err) {
      onWarn?.(`scorebet ${competition.league}: ${err.message}`);
      return [];
    }
  });

  const now = Date.now();
  const byId = new Map(listingChunks.flat().map((event) => [event.id, event]));
  const events = [...byId.values()].filter((event) =>
    event.status !== 'FINAL' &&
    event.startTime > now - 3600e3 &&
    event.startTime < now + withinMs);
  const quotes = [];

  await mapLimit(events, concurrency, async (event) => {
    try {
      quotes.push(...await fetchEvent(client, event));
    } catch (err) {
      onWarn?.(`scorebet event ${event.id}: ${err.message}`);
    }
  });

  return { events, quotes };
}

module.exports = {
  APP_VERSION,
  OPERATIONS,
  ScorebetClient,
  SUPPORTED_KEYS,
  classifyMarket,
  collect,
  eventSummaries,
  extractQuotes,
  fetchEvent,
  listCompetition,
  menuCompetitions,
  readOdds,
};
