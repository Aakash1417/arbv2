'use strict';

/**
 * Shared text normalisation + the parsers that turn each book's market titles
 * into a common player-prop shape.
 *
 * Canonical prop identity is: stat + map + player + line + side.
 */

const TEAM_STOPWORDS = new Set([
  'esports', 'esport', 'e', 'sports', 'gaming', 'game', 'team', 'club',
  'the', 'gg', 'gc', 'academy', 'gamingtd',
]);

const strip = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Team name reduced to its distinguishing tokens ("LGD Gaming" -> "lgd"). */
function normalizeTeam(name) {
  const tokens = strip(name).split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !TEAM_STOPWORDS.has(t));
  return (kept.length ? kept : tokens).join(' ');
}

/**
 * Player handle reduced for cross-book comparison. Books decorate handles with
 * real names ("Ahn (An Shan-Ye)"), so parentheticals are dropped.
 */
function normalizePlayer(name) {
  return strip(String(name).replace(/\([^)]*\)/g, '')).replace(/\s+/g, '');
}

function teamsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const A = new Set(a.split(' '));
  const B = new Set(b.split(' '));
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size) >= 0.5;
}

function playersMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Map a book's free-text stat wording onto a canonical id. Both books currently
 * only price player kills, but they publish other stats intermittently, so the
 * table keeps those aligned rather than silently mixing them.
 */
const STAT_PATTERNS = [
  [/\bkills?\b/, 'kills'],
  [/\bassists?\b/, 'assists'],
  [/\bdeaths?\b/, 'deaths'],
  [/\b(cs|creep score)\b/, 'cs'],
];

function canonicalStat(text) {
  const t = String(text).toLowerCase();
  for (const [re, id] of STAT_PATTERNS) if (re.test(t)) return id;
  return null;
}

const SIDE = (s) => {
  const t = String(s).toLowerCase();
  if (t.startsWith('over')) return 'over';
  if (t.startsWith('under')) return 'under';
  return null;
};

module.exports = {
  strip,
  normalizeTeam,
  normalizePlayer,
  teamsMatch,
  playersMatch,
  canonicalStat,
  SIDE,
};
