'use strict';

const { teamsMatch, playersMatch, normalizeTeam } = require('./normalize');
const { FAMILIES, isMarginFamily, toThreshold } = require('./markets');

const HOUR = 3600e3;

/**
 * Cluster the same fixture across any number of books.
 *
 * Books word fixtures differently ("LGD Gaming - ThunderTalk Gaming" vs
 * "LGD Gaming vs ThunderTalk Gaming"), so teams are compared on their
 * distinguishing tokens. Start time is the tie-breaker and the guard against
 * merging two different meetings of the same pair.
 *
 * `lists` is ordered by book priority: the first book to contribute an event
 * becomes the cluster's canonical home/away frame, and every other book's
 * outcomes are resolved onto it.
 *
 * @param {Array<Array<object>>} lists one event array per book, in priority order
 */
function clusterEvents(lists, { maxSkewMs = 3 * HOUR } = {}) {
  const clusters = [];

  for (const events of lists) {
    for (const ev of events) {
      let best = null;
      for (const c of clusters) {
        if (c.byBook.has(ev.book)) continue;         // one event per book per fixture
        const skew = Math.abs(c.canon.startTime - ev.startTime);
        if (skew > maxSkewMs) continue;

        const straight = teamsMatch(c.canon.homeKey, ev.homeKey) && teamsMatch(c.canon.awayKey, ev.awayKey);
        const swapped = teamsMatch(c.canon.homeKey, ev.awayKey) && teamsMatch(c.canon.awayKey, ev.homeKey);
        if (!straight && !swapped) continue;

        if (!best || skew < best.skew) best = { c, skew };
      }
      if (best) best.c.byBook.set(ev.book, ev);
      else clusters.push({ canon: ev, byBook: new Map([[ev.book, ev]]) });
    }
  }

  // Only fixtures at two or more books can produce a cross-book arb.
  return clusters.filter((c) => c.byBook.size > 1);
}

/**
 * Which side of the fixture a team name refers to, in the canonical frame.
 * Returns true for home, false for away, null when it is ambiguous — the books
 * disagree on team wording ("Top" vs "Top Esports"), so an exact hit wins and
 * a fuzzy hit only counts when it is unambiguous.
 */
function sideOf(name, canon) {
  const k = normalizeTeam(name);
  if (k === canon.homeKey) return true;
  if (k === canon.awayKey) return false;
  const h = teamsMatch(k, canon.homeKey);
  const a = teamsMatch(k, canon.awayKey);
  if (h && !a) return true;
  if (a && !h) return false;
  return null;
}

/**
 * Reduce a raw quote to the frame the arb engine compares in: either a
 * threshold leg (`X > t` / `X < t`) or a categorical outcome key. Every book's
 * quotes pass through here, so however each one words its outcomes, they come
 * out expressed against the same home/away orientation.
 */
function resolveQuote(q, canon) {
  const meta = FAMILIES[q.family];
  if (!meta) return null;

  if (isMarginFamily(q.family)) {
    const isHome = sideOf(q.team, canon);
    if (isHome === null) return null;
    const t = toThreshold({ family: q.family, handicap: q.handicap, isHome });
    return t && { kind: 'line', side: t.side, line: t.threshold };
  }

  if (meta.metric === 'total') {
    const t = toThreshold({ family: q.family, side: q.side, line: q.line });
    return t && { kind: 'line', side: t.side, line: t.threshold };
  }

  if (q.family === 'correct_score') {
    const isHome = sideOf(q.team, canon);
    if (isHome === null) return null;
    // Always stated home-first so every book lands on the same key.
    return { kind: 'cat', outcome: isHome ? `${q.self}-${q.opp}` : `${q.opp}-${q.self}` };
  }

  if (q.outcome) return { kind: 'cat', outcome: q.outcome };

  if (q.team) {
    const isHome = sideOf(q.team, canon);
    if (isHome === null) return null;
    return { kind: 'cat', outcome: isHome ? 'home' : 'away' };
  }
  return null;
}

const subjectsMatch = (family, a, b) =>
  FAMILIES[family].subject === 'player' ? playersMatch(a, b) : teamsMatch(a, b);

/**
 * Group every book's quotes into comparable markets. A group is one family, one
 * map scope and one subject (a player, a team, or the fixture itself). Lines
 * are deliberately not part of the key — differing lines are where middles are.
 *
 * Subjects are matched fuzzily across books (`Ahn (An Shan-Ye)` vs `Ahn`), so
 * groups are found by scanning rather than by exact key lookup.
 *
 * @param {Array<Array<object>>} quoteLists one quote array per book, priority order
 */
function groupMarkets(quoteLists, canon) {
  const groups = [];

  for (const quotes of quoteLists) {
    for (const q of quotes) {
      const resolved = resolveQuote(q, canon);
      if (!resolved) continue;

      let g = groups.find((x) =>
        x.family === q.family &&
        x.scope === q.scope &&
        x.kind === resolved.kind &&
        (x.subjectKey || q.subjectKey
          ? x.subjectKey && q.subjectKey && subjectsMatch(x.family, x.subjectKey, q.subjectKey)
          : true));

      if (!g) {
        g = {
          family: q.family,
          scope: q.scope,
          subject: q.subject,
          subjectKey: q.subjectKey,
          kind: resolved.kind,
          legs: [],
        };
        groups.push(g);
      }
      g.legs.push({ ...q, ...resolved });
    }
  }

  return groups.filter((g) => new Set(g.legs.map((l) => l.book)).size > 1);
}

module.exports = { clusterEvents, groupMarkets, resolveQuote, sideOf };
