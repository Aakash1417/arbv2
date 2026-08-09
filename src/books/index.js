'use strict';

/**
 * Book registry, in priority order.
 *
 * The first book that carries a given fixture becomes that fixture's canonical
 * home/away frame; every other book's outcomes are resolved onto it. Betway
 * leads because its event payload names home and away explicitly.
 *
 * Adding a book means implementing `collect({ leagues, withinMs, onWarn })`
 * returning `{ events, quotes }` in the shapes described in markets.js, then
 * listing it here — the scan, matcher and arb engine are all N-book.
 */

const betway = require('./betway');
const bet99 = require('./bet99');
const ozoon = require('./ozoon');
const bet365 = require('./bet365');

const BOOKS = [
  { id: 'betway', label: 'Betway', enabled: true, mod: betway },
  { id: 'bet99', label: 'BET99', enabled: true, mod: bet99 },
  { id: 'ozoon', label: 'Ozoon', enabled: true, mod: ozoon },
  // Scraped by tools/bet365-scrape.js into data/bet365.json; this reads that.
  { id: 'bet365', label: 'bet365 (Selenium snapshot)', enabled: true, mod: bet365 },
];

const enabledBooks = () => BOOKS.filter((b) => b.enabled);
const byId = (id) => BOOKS.find((b) => b.id === id);

module.exports = { BOOKS, enabledBooks, byId };
