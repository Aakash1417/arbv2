'use strict';

/**
 * The League of Legends competitions this tool compares, and what each book
 * calls them.
 *
 * Books disagree on naming in two ways that both have to be reconciled:
 *   - season decoration — "LPL Split 3", "LEC Summer", "CBLOL Split 2"
 *   - different names for the same competition — BET99's "LCK Challengers
 *     League" is Betway's and Ozoon's "LCK CL"
 *
 * `key` is the canonical id used everywhere else. `betway` is the group slug
 * in Betway's `/grp/esports/league-of-legends/<slug>` URLs, which is how that
 * book is queried; the others are filtered by name.
 *
 * Only competitions at least two books price are listed — a league one book
 * carries alone can never produce a cross-book arb.
 */

const LEAGUES = [
  { key: 'LPL',          betway: 'lpl' },
  { key: 'LCK',          betway: 'lck' },
  { key: 'LCS',          betway: 'lcs' },
  { key: 'LEC',          betway: 'lec' },
  { key: 'LCP',          betway: 'lcp' },
  { key: 'CBLOL',        betway: 'cblol' },
  // The Challengers League is a separate competition from the LCK proper.
  { key: 'LCK CL',       betway: 'lck-cl', aliases: ['LCK CHALLENGERS LEAGUE', 'LCK CHALLENGERS'] },
  { key: 'LES',          betway: 'les' },
  { key: 'LRN',          betway: 'lrn' },
  { key: 'LRS',          betway: 'lrs' },
  { key: 'PRIME LEAGUE', betway: 'prime-league', aliases: ['PRIME LEAGUE 1ST DIVISION'] },
];

const DEFAULT_KEYS = LEAGUES.map((l) => l.key);

/** alias (and key) -> canonical key */
const ALIAS_TO_KEY = new Map();
for (const l of LEAGUES) {
  ALIAS_TO_KEY.set(l.key, l.key);
  for (const a of l.aliases || []) ALIAS_TO_KEY.set(a.toUpperCase(), l.key);
}

const BETWAY_SLUG = new Map(LEAGUES.map((l) => [l.key, l.betway]));

/** Canonical keys -> the Betway group slugs to query. */
const betwaySlugs = (keys) =>
  (keys || DEFAULT_KEYS).map((k) => BETWAY_SLUG.get(String(k).toUpperCase())).filter(Boolean);

/** Resolve a book's own league wording onto a canonical key, if we track it. */
const resolveKey = (canonicalName) => ALIAS_TO_KEY.get(String(canonicalName).toUpperCase()) || null;

module.exports = { LEAGUES, DEFAULT_KEYS, betwaySlugs, resolveKey };
