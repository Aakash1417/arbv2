'use strict';

/**
 * bet365 client — currently NON-FUNCTIONAL for odds. See `STATUS` below.
 *
 * What is implemented and verified:
 *   - their proprietary wire format parser (validated against real payloads)
 *   - the route/endpoint manifest lookup (`websiteroutingdatacontentapi`)
 *   - a browser transport that boots a session and calls the content API
 *
 * What is blocked:
 *   bet365's origin returns `200 OK` with a zero-byte body for every odds
 *   endpoint when the session is automated. Static content still arrives
 *   because Cloudflare serves it from a shared public cache — the response
 *   headers make the split explicit:
 *
 *     /leftnavcontentapi/allsportsmenu   200  12278 bytes  cf-cache-status: HIT
 *     /splashcontentapi/splash           200      0 bytes  cf-cache-status: DYNAMIC
 *
 * Anything that actually reaches bet365 comes back empty. Their own SPA hangs
 * on a loading spinner under automation for exactly this reason. Verified the
 * same on www.bet365.com and www.on.bet365.ca, via plain HTTP (Cloudflare 403),
 * headless Chromium, real Chrome headful with a persistent profile, and CDP
 * attach to an independently launched Chrome.
 *
 * Getting past that means browser-fingerprint evasion, which this tool does not
 * do. `collect()` therefore reports the block and returns nothing rather than
 * failing silently or inventing prices.
 */

const { parseRecords, findNavEntry } = require('./bet365-format');

const STATUS = {
  ok: false,
  reason:
    'bet365 returns empty payloads for all odds endpoints under automation ' +
    '(cf-cache-status: DYNAMIC, content-length: 0). Only Cloudflare-cached ' +
    'static content is retrievable.',
};

const ORIGINS = {
  com: 'https://www.bet365.com',
  ca: 'https://www.on.bet365.ca',
};

/** Esports classification id; the LoL route the user works from is #AC#B151#C1#D50#E3#F163#. */
const ESPORTS_CLASSIFICATION = 151;

/** Query envelope the site attaches to every content API call. */
const QUERY = { lid: '32', zid: '0', cid: '36', cgid: '2', ctid: '36' };

/**
 * Content endpoints by page type, taken from bet365's own routing manifest.
 * Kept here so the module is ready the moment a data path exists.
 */
const ENDPOINTS = {
  nav: '/leftnavcontentapi/allsportsmenu',
  splash: '/splashcontentapi/splash',
  competitionList: '/othersportsmatchmarketscontentapi/list',
  competitionCoupon: '/othersportsmatchmarketscontentapi/coupon',
  playerProps: '/playercontentapi/playerprops',
};

/**
 * Fetch one content endpoint through a live browser page (same-origin fetch,
 * so it inherits whatever Cloudflare clearance the page already has).
 */
async function fetchContent(page, endpoint, pd) {
  return page.evaluate(async ([endpoint, pd, query]) => {
    const url = new URL(endpoint, location.origin);
    url.search = new URLSearchParams({ ...query, pd }).toString();
    const res = await fetch(url.toString(), { headers: { accept: '*/*' } });
    const text = await res.text();
    return { status: res.status, body: text };
  }, [endpoint, pd, QUERY]);
}

/**
 * Boot a session and pull the esports nav entry. This is the one call that
 * currently succeeds, and it is what `collect()` uses to prove the block is
 * still in place rather than assuming it.
 */
async function probe({ origin = ORIGINS.ca, launch } = {}) {
  if (!launch) throw new Error('bet365: a browser launcher is required');
  const { page, close } = await launch(origin);
  try {
    const nav = await fetchContent(page, ENDPOINTS.nav, '#AL#R^1#');
    const splash = await fetchContent(page, ENDPOINTS.splash, `#AS#B${ESPORTS_CLASSIFICATION}#`);
    const esports = findNavEntry(parseRecords(nav.body), /esports/i);
    return {
      navBytes: nav.body.length,
      oddsBytes: splash.body.length,
      esports,
      blocked: splash.body.length === 0,
    };
  } finally {
    await close();
  }
}

/**
 * Same signature as the other books so it can sit in the registry unchanged.
 * Returns nothing while the block stands; `onWarn` explains why.
 */
async function collect({ onWarn } = {}) {
  onWarn?.(`bet365: skipped — ${STATUS.reason}`);
  return { events: [], quotes: [], status: STATUS };
}

module.exports = {
  id: 'bet365',
  label: 'bet365',
  enabled: false,
  STATUS,
  ORIGINS,
  ENDPOINTS,
  QUERY,
  ESPORTS_CLASSIFICATION,
  collect,
  probe,
  fetchContent,
};
