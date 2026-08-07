'use strict';

/**
 * Decimal <-> American (moneyline) odds.
 *
 * Decimal 2.00 is the pivot: at or above it the payout beats the stake, so the
 * line is a positive "win X on 100"; below it, it is a negative "risk X to win
 * 100". Exactly 2.00 is conventionally shown as +100.
 */
function toAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

/** "+175" / "-135" — always signed, which is how books display them. */
function formatAmerican(decimal) {
  const a = toAmerican(decimal);
  if (a === null) return '—';
  return a > 0 ? `+${a}` : String(a);
}

function fromAmerican(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a > 0 ? a / 100 + 1 : 100 / -a + 1;
}

module.exports = { toAmerican, formatAmerican, fromAmerican };
