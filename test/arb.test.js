'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { findArbs, stakes, invSum, marketLabel } = require('../src/arb');
const betway = require('../src/books/betway');
const bet99 = require('../src/books/bet99');
const { clusterEvents, groupMarkets, resolveQuote, sideOf } = require('../src/match');
const bet365 = require('../src/books/bet365');
const ozoon = require('../src/books/ozoon');
const feed = require('../src/books/ozoon-feed');
const { BOOKS } = require('../src/books');
const { normalizePlayer, normalizeTeam, playersMatch, teamsMatch } = require('../src/normalize');
const { toAmerican, formatAmerican, fromAmerican } = require('../src/odds');
const { toThreshold } = require('../src/markets');

const EVENT = { home: 'JD Gaming', away: 'Edward Gaming', league: 'LPL', name: 'JD - EDG' };
const CANON = { homeKey: 'jd', awayKey: 'edward' };

/** A resolved line leg, as groupMarkets would hand it to the arb engine. */
const line = (book, side, l, odds) => ({ book, kind: 'line', side, line: l, odds, marketTitle: 'm', url: 'u', ref: {} });
const cat = (book, outcome, odds) => ({ book, kind: 'cat', outcome, odds, marketTitle: 'm', url: 'u', ref: {} });

const lineGroup = (legs, family = 'player_kills') =>
  ({ family, scope: 1, subject: 'Shaoye', subjectKey: 'shaoye', kind: 'line', legs });
const catGroup = (legs, family = 'match_winner') =>
  ({ family, scope: 0, subject: null, subjectKey: null, kind: 'cat', legs });

// ---------------------------------------------------------------- line arbs

test('exact arb is detected and staked evenly', () => {
  // The real 2026-08-06 LGD vs TTG quote: 2.40 / 2.05 on the same 3.5 line.
  const [arb] = findArbs(lineGroup([
    line('betway', 'over', 3.5, 2.40),
    line('bet99', 'under', 3.5, 2.05),
  ]), EVENT, { bankroll: 100 });
  assert.equal(arb.type, 'exact');
  assert.ok(Math.abs(arb.roi - 0.1056) < 0.0005, `roi was ${arb.roi}`);
  const [sOver, sUnder] = arb.stakes.each;
  assert.ok(Math.abs(sOver * 2.40 - sUnder * 2.05) < 0.02);
  assert.ok(Math.abs(sOver + sUnder - 100) < 0.02);
});

test('no arb when the book margin holds', () => {
  assert.equal(findArbs(lineGroup([
    line('betway', 'over', 3.5, 1.85),
    line('bet99', 'under', 3.5, 1.85),
  ]), EVENT).length, 0);
});

test('overlapping lines are reported as a middle', () => {
  // Over 2.5 and Under 3.5 both win on exactly 3, and every other result
  // still wins one leg.
  const [arb] = findArbs(lineGroup([
    line('betway', 'over', 2.5, 2.10),
    line('bet99', 'under', 3.5, 2.10),
  ]), EVENT);
  assert.equal(arb.type, 'middle');
  assert.deepEqual(arb.middleRange, [2.5, 3.5]);
});

test('a gap between lines is never reported', () => {
  // Under 2.5 + Over 3.5 loses both legs on exactly 3.
  assert.equal(findArbs(lineGroup([
    line('betway', 'over', 3.5, 3.00),
    line('bet99', 'under', 2.5, 3.00),
  ]), EVENT).length, 0);
});

test('same-book pairings are excluded by default', () => {
  const g = lineGroup([line('betway', 'over', 3.5, 2.40), line('betway', 'under', 3.5, 2.05)]);
  assert.equal(findArbs(g, EVENT).length, 0);
  assert.equal(findArbs(g, EVENT, { crossBookOnly: false }).length, 1);
});

test('minRoi filters out thin edges', () => {
  const g = lineGroup([line('betway', 'over', 3.5, 2.01), line('bet99', 'under', 3.5, 2.02)]);
  assert.equal(findArbs(g, EVENT, { minRoi: 0 }).length, 1);
  assert.equal(findArbs(g, EVENT, { minRoi: 0.05 }).length, 0);
});

// ------------------------------------------------------------- handicaps

test('handicaps convert to thresholds on the home-minus-away margin', () => {
  // Home -7.5 wins when the margin clears 7.5; away +7.5 wins when it doesn't.
  assert.deepEqual(toThreshold({ family: 'map_kills_handicap', handicap: -7.5, isHome: true }),
    { side: 'over', threshold: 7.5 });
  assert.deepEqual(toThreshold({ family: 'map_kills_handicap', handicap: 7.5, isHome: false }),
    { side: 'under', threshold: 7.5 });
  // Same line from both sides is exactly complementary — no gap, no overlap.
  const [arb] = findArbs(lineGroup([
    { ...line('betway', 'over', 7.5, 2.10) },
    { ...line('bet99', 'under', 7.5, 2.10) },
  ], 'map_kills_handicap'), EVENT);
  assert.equal(arb.type, 'exact');
});

test('handicap legs from different lines make a middle', () => {
  // Home -6.5 (over 6.5) with away +9.5 (under 9.5): margins 7,8,9 win both.
  const [arb] = findArbs(lineGroup([
    line('betway', 'over', 6.5, 2.10),
    line('bet99', 'under', 9.5, 2.10),
  ], 'map_kills_handicap'), EVENT);
  assert.equal(arb.type, 'middle');
  assert.deepEqual(arb.middleRange, [6.5, 9.5]);
});

test('handicap legs are labelled back in team terms', () => {
  const [arb] = findArbs(lineGroup([
    line('betway', 'over', 7.5, 2.10),
    line('bet99', 'under', 7.5, 2.10),
  ], 'map_kills_handicap'), EVENT);
  assert.equal(arb.legs[0].label, 'JD Gaming -7.5');
  assert.equal(arb.legs[1].label, 'Edward Gaming +7.5');
});

// ---------------------------------------------------------- categorical

test('two-way categorical arb uses best price per outcome', () => {
  const [arb] = findArbs(catGroup([
    cat('betway', 'home', 2.10),
    cat('betway', 'away', 1.70),
    cat('bet99', 'home', 1.90),
    cat('bet99', 'away', 2.10),
  ]), EVENT, { bankroll: 100 });
  // best home 2.10 (betway) + best away 2.10 (bet99) -> 0.952
  assert.ok(Math.abs(arb.impliedSum - 0.95238) < 0.0005);
  assert.equal(arb.legs.length, 2);
  assert.deepEqual(arb.legs.map((l) => l.book).sort(), ['bet99', 'betway']);
  assert.equal(arb.legs[0].label, 'JD Gaming');
});

test('categorical arb needs every outcome covered', () => {
  // Only one side quoted — backing it alone is not an arb.
  assert.equal(findArbs(catGroup([cat('betway', 'home', 1.10)]), EVENT).length, 0);
});

test('n-way correct score arb sums all four outcomes', () => {
  // Each book holds the best price on two of the four scores.
  const legs = [
    cat('betway', '2-0', 4.3), cat('bet99', '2-0', 4.0),
    cat('betway', '2-1', 4.0), cat('bet99', '2-1', 4.3),
    cat('betway', '1-2', 4.3), cat('bet99', '1-2', 4.0),
    cat('betway', '0-2', 4.0), cat('bet99', '0-2', 4.3),
  ];
  const [arb] = findArbs(catGroup(legs, 'correct_score'), EVENT);
  assert.equal(arb.legs.length, 4);
  assert.ok(Math.abs(arb.impliedSum - 4 / 4.3) < 0.0005);
  assert.ok(arb.roi > 0);
  assert.equal(arb.stakes.each.length, 4);
  // Whichever score lands, the return is the same.
  arb.legs.forEach((l, i) => assert.ok(Math.abs(arb.stakes.each[i] * l.odds - arb.stakes.payout) < 0.05));
});

test('categorical arb from a single book is rejected in cross-book mode', () => {
  const g = catGroup([cat('betway', 'odd', 2.10), cat('betway', 'even', 2.10)], 'map_kills_odd_even');
  assert.equal(findArbs(g, EVENT).length, 0);
  assert.equal(findArbs(g, EVENT, { crossBookOnly: false }).length, 1);
});

// ------------------------------------------------------- orientation

test('team names resolve to home/away across book wordings', () => {
  assert.equal(sideOf('JD Gaming', CANON), true);
  assert.equal(sideOf('EDward Gaming', CANON), false);
  assert.equal(sideOf('Some Other Org', CANON), null);
});

test('correct score is always stated home-first', () => {
  // Betway names the winning team; BET99 states it from its own A-side.
  const bw = resolveQuote(
    { family: 'correct_score', team: 'Edward Gaming', self: 2, opp: 0 }, CANON);
  assert.equal(bw.outcome, '0-2');
  const b9 = resolveQuote(
    { family: 'correct_score', team: 'JD Gaming', self: 2, opp: 0 }, CANON);
  assert.equal(b9.outcome, '2-0');
});

test('a handicap on the away side flips to an under threshold', () => {
  const r = resolveQuote(
    { family: 'match_kills_handicap', team: 'Edward Gaming', handicap: 20.5 }, CANON);
  assert.deepEqual(r, { kind: 'line', side: 'under', line: 20.5 });
});

// --------------------------------------------------------- odds & parsing

test('decimal odds convert to american', () => {
  assert.equal(toAmerican(2.75), 175);
  assert.equal(toAmerican(2.10), 110);
  assert.equal(toAmerican(1.741), -135);
  assert.equal(toAmerican(1.625), -160);
  assert.equal(toAmerican(2.0), 100);   // pivot shows as +100, not -100
  assert.equal(formatAmerican(2.75), '+175');
  assert.equal(formatAmerican(1), '—');
});

test('american odds round-trip back to decimal', () => {
  for (const d of [1.25, 1.625, 1.91, 2.0, 2.5, 4.33]) {
    assert.ok(Math.abs(fromAmerican(toAmerican(d)) - d) < 0.01);
  }
});

test('stake split returns equal payouts', () => {
  const s = stakes(250, [2.4, 2.05]);
  assert.ok(Math.abs(s.each[0] + s.each[1] - 250) < 0.02);
  assert.ok(Math.abs(s.each[0] * 2.4 - s.payout) < 0.02);
  assert.ok(invSum([2.4, 2.05]) < 1);
});

test('betway titles classify into families', () => {
  const c = betway.classifyMarket;
  assert.deepEqual(c('Map 1 - Total Kills - Burdol'),
    { family: 'player_kills', scope: 1, subject: 'Burdol' });
  assert.deepEqual(c('Match Winner'), { family: 'match_winner', scope: 0 });
  assert.deepEqual(c('Match Kills Handicap'), { family: 'match_kills_handicap', scope: 0 });
  assert.deepEqual(c('Map 2 Winner'), { family: 'map_winner', scope: 2 });
  assert.deepEqual(c('Map 1 Total Kills Scored Over/Under'),
    { family: 'map_total_kills', scope: 1 });
  assert.deepEqual(c('Map 3 Team to Draw First Blood'), { family: 'first_blood', scope: 3 });
  assert.deepEqual(c('Map 1 Bilibili Gaming Total Kills'),
    { family: 'team_total_kills', scope: 1, subject: 'Bilibili Gaming' });
  assert.deepEqual(c('Bilibili Gaming To Win At Least 1 Map'),
    { family: 'win_at_least_one_map', scope: 0, subject: 'Bilibili Gaming' });
  // Ozoon prices this one too, so Betway's version is now classified.
  assert.deepEqual(c('Map 1 Race to 10 Kills'), { family: 'race_to_10_kills', scope: 1 });
  // Markets no other book prices stay unclassified rather than guessed at.
  assert.equal(c('Map 1 Winner & Total Kills'), null);
  assert.equal(c('Map 1 Race to 5 Kills'), null);
  assert.equal(c('Map 1 Penta Kill'), null);
});

test('bet99 types classify into the same families', () => {
  const c = bet99.classifyMarket;
  assert.deepEqual(c({ type: 'E_LEAGUE_OF_LEGENDS:FT:ML', name: 'Winner' }),
    { family: 'match_winner', scope: 0, subject: null });
  assert.deepEqual(c({ type: 'E_LEAGUE_OF_LEGENDS:P:ML', name: 'Winner (Map 2)' }),
    { family: 'map_winner', scope: 2, subject: null });
  assert.deepEqual(
    c({ type: 'E_LEAGUE_OF_LEGENDS:P:PLAYTKOU', name: 'Burdol Total Kills Over/Under 2.5 (Map 1)' }),
    { family: 'player_kills', scope: 1, subject: 'Burdol' });
  // Same wording as a player prop — only the type separates team from player.
  assert.deepEqual(
    c({ type: 'E_LEAGUE_OF_LEGENDS:P:TEAMTKOU', name: 'Top Esports Total Kills Over/Under 14.5 (Map 1)' }),
    { family: 'team_total_kills', scope: 1, subject: 'Top Esports' });
  assert.equal(c({ type: 'E_LEAGUE_OF_LEGENDS:P:MOSTDRAXB', name: 'Most Drakes 3-Way (Map 1)' }), null);
});

test('player handles normalise across the two books', () => {
  assert.equal(normalizePlayer('Ahn (An Shan-Ye)'), 'ahn');
  assert.ok(playersMatch(normalizePlayer('Ahn (An Shan-Ye)'), normalizePlayer('Ahn')));
  assert.ok(playersMatch(normalizePlayer('sheer'), normalizePlayer('Sheer')));
  assert.ok(playersMatch(normalizePlayer('Wenbo (Yang Wen-Bo)'), normalizePlayer('Wenbo')));
  assert.ok(!playersMatch('ahn', 'bin'));
  assert.equal(normalizeTeam('LGD Gaming'), 'lgd');
});

test('a player handle is never matched to a longer one', () => {
  // Invictus Gaming and LNG both field a "Wei" and a "Weiwei". A prefix rule
  // pairs one player's Over with the other's Under and invents a huge arb.
  assert.ok(!playersMatch('wei', 'weiwei'));
  assert.ok(!playersMatch('weiwei', 'wei'));
  assert.ok(playersMatch('wei', 'wei'));
});

test('team names are not matched as raw substrings', () => {
  // "Team WE" -> "we" and "Weibo Gaming" -> "weibo" are different LPL orgs.
  assert.ok(!teamsMatch(normalizeTeam('Team WE'), normalizeTeam('Weibo Gaming')));
  // Qualified names still pair on their shared token.
  assert.ok(teamsMatch(normalizeTeam('FearX'), normalizeTeam('Bnk Fearx')));
  assert.ok(teamsMatch(normalizeTeam('DRX'), normalizeTeam('Kiwoom DRX')));
  assert.ok(teamsMatch(normalizeTeam('Top'), normalizeTeam('Top Esports')));
  assert.ok(!teamsMatch(normalizeTeam('Gen.G'), normalizeTeam('G2 Esports')));
});

test('same-named-prefix players stay in separate markets', () => {
  const pq = (book, subject, side, line, odds) => ({
    book, eventId: 'e', family: 'player_kills', scope: 1,
    subject, subjectKey: normalizePlayer(subject),
    side, line, odds, marketTitle: 'm', url: 'u', ref: {},
  });
  const groups = groupMarkets([
    [pq('betway', 'Weiwei', 'over', 3.5, 3.2), pq('betway', 'Wei', 'over', 3.5, 1.65)],
    [pq('bet99', 'Wei', 'under', 3.5, 2.05)],
  ], CANON);

  const weiwei = groups.find((g) => g.subjectKey === 'weiwei');
  const wei = groups.find((g) => g.subjectKey === 'wei');
  // Weiwei is Betway-only here, so it cannot be arbed at all.
  assert.equal(weiwei, undefined);
  assert.equal(wei.legs.length, 2);
  assert.ok(wei.legs.every((l) => l.subjectKey === 'wei'));
  // The old prefix rule produced 3.20 over vs 2.05 under -> a fake 24.95%.
  const arbs = findArbs(wei, EVENT);
  assert.equal(arbs.length, 0);
});

const ev = (book, id, homeKey, awayKey, startTime) =>
  ({ book, id, homeKey, awayKey, startTime, name: `${book}:${id}`, url: 'u' });

test('fixtures cluster on teams plus start time', () => {
  const a = [ev('betway', '1', 'lgd', 'thundertalk', 1000)];
  const b = [
    ev('bet99', '9', 'lgd', 'thundertalk', 9e9),      // same teams, different meeting
    ev('bet99', '2', 'thundertalk', 'lgd', 1000),      // listed the other way round
  ];
  const clusters = clusterEvents([a, b]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].byBook.get('bet99').id, '2');
  // The first book to contribute sets the canonical frame.
  assert.equal(clusters[0].canon.book, 'betway');
});

test('fixtures cluster across three books', () => {
  const clusters = clusterEvents([
    [ev('betway', '1', 'lgd', 'thundertalk', 1000)],
    [ev('bet99', '2', 'lgd', 'thundertalk', 1000)],
    [ev('bet365', '3', 'thundertalk', 'lgd', 1000)],
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual([...clusters[0].byBook.keys()], ['betway', 'bet99', 'bet365']);
});

test('a fixture only one book carries is dropped', () => {
  const clusters = clusterEvents([
    [ev('betway', '1', 'lgd', 'thundertalk', 1000)],
    [ev('bet99', '2', 'gen', 't1', 1000)],
  ]);
  assert.equal(clusters.length, 0);
});

// ------------------------------------------------------------- grouping

const q = (book, family, extra) => ({
  book, eventId: 'e', family, scope: 1, subject: null, subjectKey: null,
  odds: 2, marketTitle: 'm', url: 'u', ref: {}, ...extra,
});

test('grouping joins the same market across books and drops one-sided ones', () => {
  const groups = groupMarkets([
    [q('betway', 'map_total_kills', { side: 'over', line: 23.5 }),
      q('betway', 'first_blood', { team: 'JD Gaming' })],
    [q('bet99', 'map_total_kills', { side: 'under', line: 23.5 })],
  ], CANON);
  // first_blood is Betway-only here, so it cannot be arbed and is dropped.
  assert.equal(groups.length, 1);
  assert.equal(groups[0].family, 'map_total_kills');
  assert.equal(groups[0].legs.length, 2);
});

test('grouping merges legs from three books into one market', () => {
  const groups = groupMarkets([
    [q('betway', 'map_total_kills', { side: 'over', line: 23.5 })],
    [q('bet99', 'map_total_kills', { side: 'under', line: 23.5 })],
    [q('bet365', 'map_total_kills', { side: 'over', line: 24.5 })],
  ], CANON);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].legs.length, 3);
  assert.deepEqual(groups[0].legs.map((l) => l.book), ['betway', 'bet99', 'bet365']);
});

test('a market two non-canonical books share is still grouped', () => {
  // Betway does not price it; the other two do, and that is still an arb.
  const groups = groupMarkets([
    [q('betway', 'map_total_kills', { side: 'over', line: 23.5 })],
    [q('bet99', 'first_blood', { team: 'JD Gaming' })],
    [q('bet365', 'first_blood', { team: 'Edward Gaming' })],
  ], CANON);
  const fb = groups.find((g) => g.family === 'first_blood');
  assert.ok(fb, 'first_blood group should exist');
  assert.deepEqual(fb.legs.map((l) => l.outcome).sort(), ['away', 'home']);
});

test('a fixture the books orient differently still lines up', () => {
  // BET99 lists the teams the other way round; outcomes resolve by name, so
  // both books' "JD Gaming" legs land on the same canonical `home` key.
  const mk = (book, team) => q(book, 'match_winner', { team, scope: 0 });
  const groups = groupMarkets([[mk('betway', 'JD Gaming')], [mk('bet99', 'JD Gaming')]], CANON);
  assert.equal(groups[0].legs.every((l) => l.outcome === 'home'), true);
});

// -------------------------------------------------------------- ozoon

const ozMarket = (descriptionKey, period, outcomes, extra = {}) => ({
  id: 'm1', descriptionKey, description: descriptionKey, status: 'O',
  period: { description: period }, outcomes, ...extra,
});
const ozPrice = (decimal, handicap) => ({ decimal: String(decimal), handicap: handicap == null ? undefined : String(handicap) });
const OZ_COMPETITORS = [
  { id: 'e-1', name: 'KT Rolster', home: true },
  { id: 'e-2', name: 'Gen.G', home: false },
];

test('ozoon periods map to map scope', () => {
  assert.equal(ozoon.periodScope({ description: 'Game' }), 0);
  assert.equal(ozoon.periodScope({ description: 'Map 2' }), 2);
  assert.equal(ozoon.periodScope({ description: 'Set 1' }), null);
});

test('ozoon league names drop season decoration but stay distinct', () => {
  assert.equal(ozoon.canonicalLeague('LPL Split 3'), 'LPL');
  assert.equal(ozoon.canonicalLeague('LCS Summer'), 'LCS');
  assert.equal(ozoon.canonicalLeague('LCK'), 'LCK');
  // LCK Challengers is a different competition and must not collapse into LCK.
  assert.equal(ozoon.canonicalLeague('LCK CL'), 'LCK CL');
});

test('ozoon market descriptions classify into families', () => {
  const c = (d, p) => ozoon.classifyMarket({ descriptionKey: d, period: { description: p } });
  assert.deepEqual(c('Head To Head', 'Game'), { family: 'match_winner', scope: 0 });
  assert.deepEqual(c('Head To Head', 'Map 2'), { family: 'map_winner', scope: 2 });
  assert.deepEqual(c('Main Dynamic Asian Handicap', 'Game'), { family: 'maps_handicap', scope: 0 });
  assert.deepEqual(c('Asian - Handicap', 'Game'), { family: 'maps_handicap', scope: 0 });
  assert.deepEqual(c('Main Dynamic Over/Under', 'Game'), { family: 'total_maps', scope: 0 });
  // Must not be swallowed by the generic asian-handicap rule.
  assert.deepEqual(c('Asian Handicap Kills', 'Map 1'), { family: 'map_kills_handicap', scope: 1 });
  assert.deepEqual(c('Under/Over Kills', 'Map 3'), { family: 'map_total_kills', scope: 3 });
  assert.deepEqual(c('Team To Draw First Blood (First Kill)', 'Map 1'), { family: 'first_blood', scope: 1 });
  assert.deepEqual(c('First Team To Get 10 Kills', 'Map 1'), { family: 'race_to_10_kills', scope: 1 });
  assert.deepEqual(c('Total kills - Bdd (KT) ', 'Map 1'),
    { family: 'player_kills', scope: 1, subject: 'Bdd' });
  assert.equal(c('First Dragon type to be Killed', 'Map 1'), null);
  assert.equal(c('Map Exacta - Best of 3', 'Game'), null);
});

test('ozoon over/under and handicap outcomes resolve', () => {
  const raw = {
    id: '1', description: 'KT Rolster vs Gen.G', link: '/x', startTime: 1,
    competitors: OZ_COMPETITORS,
    displayGroups: [{ markets: [
      ozMarket('Total kills - Bdd (KT) ', 'Map 1', [
        { description: 'Over - Map 1', status: 'O', type: 'O', price: ozPrice(1.666667, 2.5) },
        { description: 'Under - Map 1', status: 'O', type: 'U', price: ozPrice(2.05, 2.5) },
      ]),
      ozMarket('Asian Handicap Kills', 'Map 1', [
        { description: 'KT Rolster - Map 1', status: 'O', type: 'H', competitorId: 'e-1', price: ozPrice(2.35, -3.5) },
        { description: 'Gen.G - Map 1', status: 'O', type: 'A', competitorId: 'e-2', price: ozPrice(1.57, 3.5) },
      ]),
    ] }],
  };
  const { event, quotes } = ozoon.extractProps(raw, 'LCK');
  assert.equal(event.home, 'KT Rolster');
  const pp = quotes.filter((q) => q.family === 'player_kills');
  assert.equal(pp.length, 2);
  assert.equal(pp[0].subjectKey, 'bdd');
  assert.deepEqual(pp.map((q) => q.side).sort(), ['over', 'under']);
  // Handicaps keep the raw team + signed line; the matcher turns them into
  // thresholds once it knows which side is home.
  const hc = quotes.filter((q) => q.family === 'map_kills_handicap');
  assert.equal(hc.length, 2);
  assert.deepEqual(resolveQuote(hc[0], { homeKey: 'kt rolster', awayKey: 'gen g' }),
    { kind: 'line', side: 'over', line: 3.5 });
  assert.deepEqual(resolveQuote(hc[1], { homeKey: 'kt rolster', awayKey: 'gen g' }),
    { kind: 'line', side: 'under', line: 3.5 });
});

test('ozoon Map Totals splits into one family per outcome', () => {
  // A single market carrying towers, dragons and barons together.
  const raw = {
    id: '1', description: 'A vs B', link: '/x', startTime: 1,
    competitors: OZ_COMPETITORS,
    displayGroups: [{ markets: [ozMarket('Map Totals', 'Map 1', [
      { description: 'Total Towers Over 12.5 - Map 1', status: 'O', type: 'X', price: ozPrice(2.3) },
      { description: 'Total Towers Under 12.5 - Map 1', status: 'O', type: 'X', price: ozPrice(1.53) },
      { description: 'Total Dragons Over 4.5 - Map 1', status: 'O', type: 'X', price: ozPrice(1.83) },
      { description: 'Total Barons Under 1.5 - Map 1', status: 'O', type: 'X', price: ozPrice(1.59) },
      { description: 'First Dragon - Map 1', status: 'O', type: 'X', price: ozPrice(5.5) },
    ])] }],
  };
  const { quotes } = ozoon.extractProps(raw, 'LCK');
  const fams = quotes.map((q) => `${q.family}:${q.side}:${q.line}`).sort();
  assert.deepEqual(fams, [
    'map_total_barons:under:1.5',
    'map_total_dragons:over:4.5',
    'map_total_towers:over:12.5',
    'map_total_towers:under:12.5',
  ]);
});

test('ozoon correct score is stated home-first', () => {
  const raw = {
    id: '1', description: 'A vs B', link: '/x', startTime: 1,
    competitors: OZ_COMPETITORS,
    displayGroups: [{ markets: [ozMarket('Correct Score', 'Game', [
      { description: '2 - 0', status: 'O', type: 'H', price: ozPrice(5) },
      { description: '0 - 2', status: 'O', type: 'A', price: ozPrice(2.37) },
    ], { key: 'GAME-PROP-DYN' })] }],
  };
  const { quotes } = ozoon.extractProps(raw, 'LCK');
  const canon = { homeKey: 'kt rolster', awayKey: 'gen g' };
  assert.deepEqual(quotes.map((q) => resolveQuote(q, canon).outcome), ['2-0', '0-2']);
});

test('ozoon suspended markets and outcomes are dropped', () => {
  const raw = {
    id: '1', description: 'A vs B', link: '/x', startTime: 1,
    competitors: OZ_COMPETITORS,
    displayGroups: [{ markets: [
      ozMarket('Head To Head', 'Game', [
        { description: 'KT Rolster', status: 'O', type: 'H', competitorId: 'e-1', price: ozPrice(2.9) },
        { description: 'Gen.G', status: 'S', type: 'A', competitorId: 'e-2', price: ozPrice(1.38) },
      ]),
      { ...ozMarket('Under/Over Kills', 'Map 1', [
        { description: 'Over - Map 1', status: 'O', type: 'O', price: ozPrice(1.9, 24.5) },
      ]), status: 'S' },
    ] }],
  };
  const { quotes } = ozoon.extractProps(raw, 'LCK');
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].family, 'match_winner');
});

test('ozoon merges the main and alternate event frames', () => {
  const frames = [
    { header: { type: 'fullEvent', eventId: '7', displayGroups: 'main' },
      body: { id: '7', displayGroups: [{ id: 'a' }] } },
    { header: { type: 'fullEvent', eventId: '7', displayGroups: 'alternate' },
      body: { id: '7', displayGroups: [{ id: 'b' }, { id: 'c' }] } },
    { header: { type: 'fullEvent', eventId: '8' }, body: { id: '8', displayGroups: [{ id: 'z' }] } },
  ];
  const merged = ozoon.mergeEventFrames(frames, '7');
  assert.deepEqual(merged.displayGroups.map((g) => g.id), ['a', 'b', 'c']);
  assert.equal(ozoon.mergeEventFrames(frames, '99'), null);
});

test('ozoon competition frames yield the fixture list', () => {
  const frames = [
    { header: { type: 'competition' }, body: {
      path: [{ type: 'LEAGUE', description: 'LPL Split 3' }, { type: 'SPORT', description: 'Esports' }],
      events: [
        { id: '1', type: 'GAMEEVENT', description: 'A vs B', link: '/l/a-b', startTime: 5, numMarkets: 97, live: false },
        { id: '2', type: 'GAMEEVENT', description: 'C vs D', link: '/l/c-d', startTime: 6, live: true },
      ],
    } },
    { header: { type: 'competition_catchup_end' }, body: null },
  ];
  const evs = ozoon.parseCompetitions(frames);
  // Live fixtures are skipped — this tool prices pre-match only.
  assert.equal(evs.length, 1);
  assert.equal(evs[0].leagueKey, 'LPL');
  assert.equal(evs[0].link, '/l/a-b');
});

test('ozoon feed frames split into header and body', () => {
  const f = feed.parseFrame('{"type":"competition","index":0}|{"events":["1","2"]}');
  assert.equal(f.header.type, 'competition');
  assert.deepEqual(f.body.events, ['1', '2']);
  assert.equal(feed.parseFrame('{"type":"chgEnablement"}').body, null);
  assert.equal(feed.parseFrame('not json at all'), null);
});

test('ozoon builds feed subscription paths', () => {
  assert.match(feed.competitionPath(), /^\/competitions\/117310\?.*preMatchOnly=true/);
  // Event links are the site path with '/' swapped for '$'.
  assert.match(feed.eventPath('/esports/league-of-legends/lck/kt-gen-g-1'),
    /^\/eventByLink\/\$esports\$league-of-legends\$lck\$kt-gen-g-1\?/);
});

// ------------------------------------------------------------- bet365

test('bet365 group titles classify', () => {
  const c = bet365.classifyGroup;
  assert.deepEqual(c('Map 1 - Player Total Kills'),
    { kind: 'player', scope: 1, family: 'player_kills' });
  assert.deepEqual(c('Map 2 - Player Total Assists'),
    { kind: 'player', scope: 2, family: 'player_assists' });
  assert.deepEqual(c('Map 1 Winner'), { kind: 'teamCells', scope: 1, family: 'map_winner' });
  assert.deepEqual(c('Map 1 - Tower Handicap'),
    { kind: 'teamCols', scope: 1, family: 'map_towers_handicap' });
  assert.deepEqual(c('Match Lines'), { kind: 'rows', scope: 0 });
  assert.deepEqual(c('Map 1 - Totals'), { kind: 'rows', scope: 1 });
  // Player matchups are head-to-head pairs no other book prices.
  assert.equal(c('Map 1 - Player Matchups - Most Kills'), null);
});

test('bet365 fixture times parse from Pacific into UTC', () => {
  const now = new Date('2026-08-09T00:00:00Z');
  // The site prints its own Pacific clock; this fixture is 08:00Z.
  assert.equal(bet365.parseHeaderTime('LOL - LCK | Aug 9 1:00 AM | Dplus KIA vs KT Rolster', now),
    Date.parse('2026-08-09T08:00:00Z'));
  assert.equal(bet365.parseHeaderTime('LOL - LCK | Aug 9 3:00 AM | BNK FearX vs Kiwoom DRX', now),
    Date.parse('2026-08-09T10:00:00Z'));
  assert.equal(bet365.parseHeaderTime('no time here', now), null);
});

const b365Event = (groups) => ({
  league: 'LOL - LCK', home: 'Dplus KIA', away: 'KT Rolster',
  url: 'https://www.bet365.com/#/AC/B151/C1/D19/E2/F19/',
  header: 'LOL - LCK | Aug 9 1:00 AM | Dplus KIA vs KT Rolster',
  groups,
});
const NOW = Date.parse('2026-08-09T00:00:00Z');

test('bet365 player props zip prices onto the right player', () => {
  // The grid is label-aligned: cells[i] belongs to labels[i].
  const { event, quotes } = bet365.extractEvent(b365Event([{
    title: 'Map 1 - Player Total Kills',
    labels: ['Siwoo', 'Lucid', 'ShowMaker'],
    columns: [
      { header: 'Over', cells: [{ hcap: '2.5', odds: '1.72' }, { hcap: '2.5', odds: '1.83' }, { hcap: '3.5', odds: '1.61' }] },
      { header: 'Under', cells: [{ hcap: '2.5', odds: '2.00' }, { hcap: '2.5', odds: '1.83' }, { hcap: '3.5', odds: '2.20' }] },
    ],
  }]), { now: NOW });
  assert.equal(event.league, 'LCK');
  assert.equal(event.startTime, Date.parse('2026-08-09T08:00:00Z'));
  assert.equal(quotes.length, 6);
  const show = quotes.filter((q) => q.subjectKey === 'showmaker');
  assert.deepEqual(show.map((q) => `${q.side}${q.line}@${q.odds}`), ['over3.5@1.61', 'under3.5@2.2']);
});

test('bet365 drops a column whose length does not match the labels', () => {
  // A shifted grid would otherwise hand one player another player's price.
  const { quotes } = bet365.extractEvent(b365Event([{
    title: 'Map 1 - Player Total Kills',
    labels: ['Siwoo', 'Lucid', 'ShowMaker'],
    columns: [{ header: 'Over', cells: [{ hcap: '2.5', odds: '1.72' }, { hcap: '2.5', odds: '1.83' }] }],
  }]), { now: NOW });
  assert.equal(quotes.length, 0);
});

test('bet365 Match Lines splits into three markets', () => {
  const { quotes } = bet365.extractEvent(b365Event([{
    title: 'Match Lines',
    labels: ['To Win', 'Match Handicap', 'Total Maps'],
    columns: [
      { header: 'Dplus KIA', cells: [{ hcap: '', odds: '1.57' }, { hcap: '-1.5', odds: '2.75' }, { hcap: 'O 2.5', odds: '1.90' }] },
      { header: 'KT Rolster', cells: [{ hcap: '', odds: '2.25' }, { hcap: '+1.5', odds: '1.40' }, { hcap: 'U 2.5', odds: '1.80' }] },
    ],
  }]), { now: NOW });
  const byFam = (f) => quotes.filter((q) => q.family === f);
  assert.deepEqual(byFam('match_winner').map((q) => [q.team, q.odds]),
    [['Dplus KIA', 1.57], ['KT Rolster', 2.25]]);
  assert.deepEqual(byFam('maps_handicap').map((q) => [q.team, q.handicap]),
    [['Dplus KIA', -1.5], ['KT Rolster', 1.5]]);
  // On the Total Maps row the columns are Over/Under, not teams — the O/U
  // prefix inside the cell is what decides the side.
  assert.deepEqual(byFam('total_maps').map((q) => `${q.side}${q.line}@${q.odds}`),
    ['over2.5@1.9', 'under2.5@1.8']);
});

test('bet365 LPL fixtures are skipped', () => {
  const ev = b365Event([]);
  ev.league = 'LOL - LPL Split 3';
  assert.equal(bet365.extractEvent(ev, { now: NOW }).event, null);
});

test('bet365 ignores a stale snapshot', async () => {
  const tmp = require('path').join(require('os').tmpdir(), 'b365-test.json');
  require('fs').writeFileSync(tmp, JSON.stringify({ scrapedAt: Date.now() - 6 * 3600e3, events: [] }));
  const warns = [];
  const out = await bet365.collect({ file: tmp, onWarn: (m) => warns.push(m) });
  assert.deepEqual(out.quotes, []);
  assert.match(warns[0], /snapshot is \d+min old/);
  require('fs').unlinkSync(tmp);
});

test('bet365 reports a missing snapshot instead of failing', async () => {
  const warns = [];
  const out = await bet365.collect({ file: '/definitely/not/here.json', onWarn: (m) => warns.push(m) });
  assert.deepEqual(out.events, []);
  assert.match(warns[0], /no snapshot/);
});

test('bet365 is registered in the book list', () => {
  assert.ok(BOOKS.find((b) => b.id === 'bet365'));
});

test('market labels read sensibly', () => {
  assert.equal(marketLabel({ family: 'map_kills_handicap', scope: 1, subject: null }),
    'Kills Handicap · Map 1');
  assert.equal(marketLabel({ family: 'player_kills', scope: 2, subject: 'Burdol' }),
    'Burdol Player Total Kills · Map 2');
  assert.equal(marketLabel({ family: 'match_winner', scope: 0, subject: null }),
    'Match Winner · Series');
});
