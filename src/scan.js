'use strict';

const { BOOKS, enabledBooks } = require('./books');
const { clusterEvents, groupMarkets } = require('./match');
const { findArbs, dedupeBest } = require('./arb');
const { FAMILIES } = require('./markets');

const HOUR = 3600e3;

/**
 * One full pass: pull every enabled book, cluster fixtures, group comparable
 * markets, price the arbs.
 *
 * @param {object} opts
 * @param {string[]} opts.books  restrict to these book ids
 * @param {string[]} opts.families restrict to these canonical families
 */
async function scan(opts = {}) {
  const {
    leagues = ['LPL', 'LCK', 'LCS'],
    hours = 24,
    minRoi = 0,
    bankroll = 100,
    crossBookOnly = true,
    families = null,
    books = null,
    onWarn = () => {},
  } = opts;

  const withinMs = hours * HOUR;
  const wantFamily = families ? new Set(families) : null;
  const active = enabledBooks().filter((b) => !books || books.includes(b.id));

  if (active.length < 2) {
    onWarn(`only ${active.length} book(s) active — need at least two to find an arb`);
  }

  // Fetch every book in parallel; a book that fails is reported, not fatal.
  const results = await Promise.all(active.map(async (b) => {
    try {
      const out = await b.mod.collect({
        leagues: b.id === 'betway' ? leagues.map((l) => l.toLowerCase()) : leagues,
        withinMs,
        onWarn,
      });
      return { book: b, ...out };
    } catch (err) {
      onWarn(`${b.id}: ${err.message}`);
      return { book: b, events: [], quotes: [] };
    }
  }));

  const clusters = clusterEvents(results.map((r) => r.events));
  const quotesByBook = new Map(results.map((r) => [r.book.id, r.quotes]));

  const arbs = [];
  let comparedMarkets = 0;

  for (const cluster of clusters) {
    // Quote lists ordered by book priority, matching the canonical frame.
    const lists = [];
    for (const b of active) {
      const ev = cluster.byBook.get(b.id);
      if (!ev) continue;
      const qs = (quotesByBook.get(b.id) || []).filter(
        (q) => q.eventId === ev.id && (!wantFamily || wantFamily.has(q.family)),
      );
      if (qs.length) lists.push(qs);
    }
    if (lists.length < 2) continue;

    const canon = cluster.canon;
    const links = {};
    for (const [id, ev] of cluster.byBook) links[id] = ev.url;

    const event = {
      key: `${canon.homeKey}|${canon.awayKey}|${canon.startTime}`,
      name: canon.name,
      league: canon.league,
      home: canon.home,
      away: canon.away,
      startTime: canon.startTime,
      books: [...cluster.byBook.keys()],
      links,
    };

    const groups = groupMarkets(lists, canon);
    comparedMarkets += groups.length;

    for (const group of groups) {
      for (const arb of findArbs(group, event, { crossBookOnly, minRoi, bankroll })) {
        arbs.push({ ...arb, event });
      }
    }
  }

  return {
    scannedAt: Date.now(),
    books: BOOKS.map((b) => ({
      id: b.id,
      enabled: b.enabled,
      active: active.some((a) => a.id === b.id),
      events: results.find((r) => r.book.id === b.id)?.events.length ?? 0,
      quotes: results.find((r) => r.book.id === b.id)?.quotes.length ?? 0,
      status: b.status || null,
    })),
    stats: {
      matchedFixtures: clusters.length,
      comparedMarkets,
      rawArbs: arbs.length,
    },
    fixtures: clusters.map((c) => ({
      name: c.canon.name,
      league: c.canon.league,
      startTime: c.canon.startTime,
      books: [...c.byBook.keys()],
    })),
    arbs: dedupeBest(arbs),
    allArbs: arbs.sort((x, y) => y.roi - x.roi),
  };
}

module.exports = { scan, FAMILIES };
