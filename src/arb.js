'use strict';

/**
 * Arbitrage detection.
 *
 * Two shapes of market, one test. An arb exists whenever a set of legs covers
 * every possible result and their implied probabilities sum to under 1.
 *
 * LINE markets (totals, handicaps, player props) reduce to two thresholds:
 *
 *   exact   X > t @ a  +  X < t @ b
 *           Exactly one leg wins.
 *
 *   middle  X > t1 @ a +  X < t2 @ b, t2 > t1
 *           With half-point lines every result is covered by at least one leg,
 *           and anything strictly between t1 and t2 wins BOTH. Same test, plus
 *           upside. These are usually the fatter edges.
 *
 *   The reverse pairing (X < t1 and X > t2 with t2 > t1) leaves a gap where
 *   both legs lose, so it is never reported.
 *
 * CATEGORICAL markets (winner, correct score, odd/even, yes/no) take the best
 * price for each distinct outcome and test the same sum. The outcome set is
 * taken as the union of what the two books quote, so a book that omits an
 * outcome cannot silently turn a losing position into a phantom arb.
 */

const { toAmerican } = require('./odds');
const { FAMILIES, isMarginFamily, describeLeg } = require('./markets');

const round2 = (n) => Math.round(n * 100) / 100;
const invSum = (odds) => odds.reduce((s, o) => s + 1 / o, 0);

/**
 * Split `bankroll` so every leg returns the same amount whichever one wins.
 */
function stakes(bankroll, legOdds) {
  const inv = invSum(legOdds);
  const each = legOdds.map((o) => round2((bankroll * (1 / o)) / inv));
  const payout = round2((bankroll / inv));
  return { each, payout, profit: round2(payout - bankroll) };
}

const legView = (q, event, family) => ({
  book: q.book,
  side: q.side,
  outcome: q.outcome,
  line: q.line,
  label: q.kind === 'line' ? describeLeg(family, q, event) : outcomeLabel(q.outcome, event),
  bookLabel: q.outcomeLabel,
  odds: q.odds,
  american: toAmerican(q.odds),
  market: q.marketTitle,
  url: q.url,
  ref: q.ref,
});

function outcomeLabel(outcome, event) {
  if (outcome === 'home') return event.home;
  if (outcome === 'away') return event.away;
  if (/^\d+-\d+$/.test(outcome)) return `${event.home} ${outcome}`;
  return outcome.charAt(0).toUpperCase() + outcome.slice(1);
}

/** Best (highest) price per key, keeping which book offered it. */
function bestByKey(legs, keyOf) {
  const best = new Map();
  for (const l of legs) {
    const k = keyOf(l);
    if (!best.has(k) || l.odds > best.get(k).odds) best.set(k, l);
  }
  return best;
}

function findLineArbs(group, event, opts) {
  const { crossBookOnly, minRoi, bankroll } = opts;
  const overs = group.legs.filter((l) => l.side === 'over');
  const unders = group.legs.filter((l) => l.side === 'under');
  const out = [];

  for (const o of overs) {
    for (const u of unders) {
      if (crossBookOnly && o.book === u.book) continue;
      // The under's threshold must sit at or above the over's, else the two
      // legs leave a hole between them.
      if (u.line < o.line) continue;

      const inv = invSum([o.odds, u.odds]);
      if (inv >= 1) continue;
      const roi = 1 / inv - 1;
      if (roi < minRoi) continue;

      const s = stakes(bankroll, [o.odds, u.odds]);
      const isMiddle = u.line > o.line;
      out.push({
        shape: 'line',
        type: isMiddle ? 'middle' : 'exact',
        family: group.family,
        scope: group.scope,
        subject: group.subject,
        roi,
        impliedSum: inv,
        middleRange: isMiddle ? [o.line, u.line] : null,
        pushRisk: !isMiddle && Number.isInteger(o.line),
        legs: [legView(o, event, group.family), legView(u, event, group.family)],
        stakes: { each: s.each, payout: s.payout, profit: s.profit },
      });
    }
  }
  return out;
}

function findCategoricalArbs(group, event, opts) {
  const { crossBookOnly, minRoi, bankroll } = opts;
  const best = bestByKey(group.legs, (l) => l.outcome);
  const picks = [...best.values()];

  // Need at least a genuine two-way, and the union of outcomes must be covered.
  if (picks.length < 2) return [];
  if (crossBookOnly && new Set(picks.map((p) => p.book)).size < 2) return [];

  const inv = invSum(picks.map((p) => p.odds));
  if (inv >= 1) return [];
  const roi = 1 / inv - 1;
  if (roi < minRoi) return [];

  const s = stakes(bankroll, picks.map((p) => p.odds));
  return [{
    shape: 'categorical',
    type: 'exact',
    family: group.family,
    scope: group.scope,
    subject: group.subject,
    roi,
    impliedSum: inv,
    middleRange: null,
    pushRisk: false,
    legs: picks.map((p) => legView(p, event, group.family)),
    stakes: { each: s.each, payout: s.payout, profit: s.profit },
  }];
}

function findArbs(group, event, opts = {}) {
  const o = {
    crossBookOnly: opts.crossBookOnly !== false,
    minRoi: opts.minRoi ?? 0,
    bankroll: opts.bankroll ?? 100,
  };
  const found = group.kind === 'line'
    ? findLineArbs(group, event, o)
    : findCategoricalArbs(group, event, o);
  return found.sort((x, y) => y.roi - x.roi);
}

/** Keep only the best opportunity per market (highest max profit) so output stays readable. */
function dedupeBest(arbs, nowMs = Date.now()) {
  const getProfit = (a) => a.maxProfit ?? calculatePlatformSizing(a, nowMs).maxProfit;
  const best = new Map();
  for (const a of arbs) {
    const key = `${a.event.key}|${a.family}|${a.scope}|${a.subject || ''}`;
    const prev = best.get(key);
    if (!prev || getProfit(a) > getProfit(prev)) best.set(key, a);
  }
  return [...best.values()].sort((x, y) => getProfit(y) - getProfit(x) || y.roi - x.roi);
}

/** Human label for a market, e.g. "Kills Handicap · Map 1" or "JackeyLove · Map 1". */
function marketLabel(arb) {
  const fam = FAMILIES[arb.family];
  const scope = arb.scope === 0 ? 'Series' : `Map ${arb.scope}`;
  const base = fam.subject === 'none' ? fam.label : `${arb.subject} ${fam.label}`;
  return `${base} · ${scope}`;
}

const BETWAY_TARGET_WIN = 480;

/**
 * Calculates platform-specific sizing and max profit for an arbitrage opportunity.
 * The Betway leg is the sole betting-limit anchor: stake enough to win $480 net,
 * then size every other leg to return the same total payout.
 */
function calculatePlatformSizing(arb) {
  const legs = arb.legs || [];
  const betwayLeg = legs.find((l) => l.book && l.book.toLowerCase() === 'betway');

  // Opportunities without Betway have no applicable betting limit, so do not
  // present made-up stake advice for them.
  if (!betwayLeg || !(betwayLeg.odds > 1)) {
    return {
      targetWin: null,
      betwayTargetWin: null,
      betwayStake: 0,
      legStakes: {},
      payout: 0,
      totalStake: 0,
      maxProfit: 0,
    };
  }

  const betwayStake = round2(BETWAY_TARGET_WIN / (betwayLeg.odds - 1));
  const payout = round2(betwayStake * betwayLeg.odds);

  const legStakes = {};
  let totalStake = 0;
  legs.forEach((leg) => {
    const legStake = leg === betwayLeg ? betwayStake : round2(payout / leg.odds);
    legStakes[leg.book] = legStake;
    totalStake += legStake;
  });

  totalStake = round2(totalStake);
  const maxProfit = round2(payout - totalStake);

  return {
    // Keep targetWin as the generic persisted field while making its platform
    // explicit to callers and output formatters.
    targetWin: BETWAY_TARGET_WIN,
    betwayTargetWin: BETWAY_TARGET_WIN,
    betwayStake,
    legStakes,
    payout,
    totalStake,
    maxProfit,
  };
}

module.exports = {
  findArbs, findLineArbs, findCategoricalArbs, stakes, invSum, dedupeBest, marketLabel,
  BETWAY_TARGET_WIN, calculatePlatformSizing,
  isMarginFamily,
};

