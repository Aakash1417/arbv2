'use strict';

/**
 * Canonical market taxonomy shared by both books.
 *
 * Each book words its markets differently ("Map 1 Team to Draw First Blood" vs
 * "First Blood (Map 1)"), so every market either maps onto one of these family
 * ids or is dropped. Only families both books actually price can produce an
 * arb; the rest are kept out so nothing gets mis-paired.
 *
 * metric
 *   total   a count that both books measure identically (kills, maps, barons).
 *           Legs reduce to "> threshold" / "< threshold".
 *   margin  a handicap on home-minus-away. Also reduces to a threshold, which
 *           is what lets handicaps share the over/under arb logic.
 *   cat     an unordered set of mutually exclusive outcomes (winner, correct
 *           score, odd/even, yes/no).
 *
 * subject
 *   none    the market is about the fixture as a whole
 *   team    one market per team (team total kills, to win a map)
 *   player  one market per player (the original player props)
 */

const FAMILIES = {
  // --- series level -------------------------------------------------------
  match_winner:         { label: 'Match Winner',        metric: 'cat',    subject: 'none' },
  correct_score:        { label: 'Correct Score',       metric: 'cat',    subject: 'none' },
  maps_handicap:        { label: 'Maps Handicap',       metric: 'margin', subject: 'none' },
  total_maps:           { label: 'Total Maps',          metric: 'total',  subject: 'none' },
  match_kills_handicap: { label: 'Match Kills Handicap', metric: 'margin', subject: 'none' },
  match_total_kills:    { label: 'Match Total Kills',   metric: 'total',  subject: 'none' },
  win_at_least_one_map: { label: 'To Win At Least 1 Map', metric: 'cat',  subject: 'team' },

  // --- map level ----------------------------------------------------------
  map_winner:           { label: 'Map Winner',          metric: 'cat',    subject: 'none' },
  map_total_kills:      { label: 'Total Kills',         metric: 'total',  subject: 'none' },
  map_kills_handicap:   { label: 'Kills Handicap',      metric: 'margin', subject: 'none' },
  map_towers_handicap:  { label: 'Towers Handicap',     metric: 'margin', subject: 'none' },
  map_dragons_handicap: { label: 'Dragons Handicap',    metric: 'margin', subject: 'none' },
  map_total_barons:     { label: 'Total Barons',        metric: 'total',  subject: 'none' },
  map_total_towers:     { label: 'Total Towers',        metric: 'total',  subject: 'none' },
  map_total_dragons:    { label: 'Total Dragons',       metric: 'total',  subject: 'none' },
  map_kills_odd_even:   { label: 'Total Kills Odd/Even', metric: 'cat',   subject: 'none' },
  first_blood:          { label: 'First Blood',         metric: 'cat',    subject: 'none' },
  first_inhibitor:      { label: 'First Inhibitor',     metric: 'cat',    subject: 'none' },
  first_baron:          { label: 'First Baron',         metric: 'cat',    subject: 'none' },
  race_to_10_kills:     { label: 'Race To 10 Kills',    metric: 'cat',    subject: 'none' },
  team_total_kills:     { label: 'Team Total Kills',    metric: 'total',  subject: 'team' },

  // --- player level -------------------------------------------------------
  player_kills:         { label: 'Player Total Kills',  metric: 'total',  subject: 'player' },
  player_deaths:        { label: 'Player Total Deaths', metric: 'total',  subject: 'player' },
  player_assists:       { label: 'Player Total Assists', metric: 'total', subject: 'player' },
};

const isLineFamily = (id) => {
  const f = FAMILIES[id];
  return !!f && (f.metric === 'total' || f.metric === 'margin');
};

const isMarginFamily = (id) => FAMILIES[id]?.metric === 'margin';

/**
 * Convert a raw outcome into the "threshold" frame that the arb engine works
 * in, where every line leg is either `X > t` (over) or `X < t` (under).
 *
 * totals   Over 31.5  ->  over @ 31.5        Under 31.5 -> under @ 31.5
 * margins  Home -7.5  ->  over @ 7.5         Away +7.5  -> under @ 7.5
 *
 * For a handicap the underlying quantity is (home - away). Backing the home
 * side at -7.5 wins when that margin exceeds 7.5; backing the away side at
 * +7.5 wins when it falls short of 7.5. Expressing both as thresholds is what
 * makes "home at one line vs away at another" comparable, and it is how
 * handicap middles surface.
 */
function toThreshold({ family, side, line, handicap, isHome }) {
  if (!isLineFamily(family)) return null;

  if (FAMILIES[family].metric === 'total') {
    if (side !== 'over' && side !== 'under') return null;
    return { side, threshold: line };
  }

  // margin: `handicap` is signed from the perspective of the team being backed
  if (!Number.isFinite(handicap)) return null;
  return isHome
    ? { side: 'over', threshold: -handicap }
    : { side: 'under', threshold: handicap };
}

/** Render a threshold leg back into the wording the book displays. */
function describeLeg(family, leg, event) {
  if (!isMarginFamily(family)) {
    return `${leg.side === 'over' ? 'OVER ' : 'UNDER'} ${leg.line}`;
  }
  const team = leg.side === 'over' ? event.home : event.away;
  const hcap = leg.side === 'over' ? -leg.line : leg.line;
  const sign = hcap > 0 ? `+${hcap}` : `${hcap}`;
  return `${team} ${sign}`;
}

module.exports = { FAMILIES, isLineFamily, isMarginFamily, toThreshold, describeLeg };
