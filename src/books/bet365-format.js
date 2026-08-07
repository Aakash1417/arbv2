'use strict';

/**
 * Parser for bet365's proprietary wire format.
 *
 * Payloads are pipe-delimited records; each record is a two-letter type
 * followed by semicolon-separated KEY=VALUE pairs:
 *
 *   F|CS;IT=LN-HL1;NA=Sports;|CL;ID=-5;NA=Promos;PD=#OF#;AE=1;|CL;ID=151;NA=Esports;PD=#AS#B151#;
 *
 * Common keys: NA/N2 name, ID id, PD page-route, OD odds as a fraction
 * ("5/2"), HA handicap, IT item key, CS/CL/EV/MA/PA record types.
 *
 * Validated against live `leftnavcontentapi` payloads.
 */

/**
 * Split one payload into typed records. Values may contain '=', keys never do.
 *
 * Payloads open with a bare structural marker ("F|CS;...") that carries no
 * fields; those are dropped so record indices line up with actual content.
 */
function parseRecords(payload) {
  return String(payload || '')
    .split('|')
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split(';');
      const rec = { _type: parts[0] };
      for (const kv of parts.slice(1)) {
        if (!kv) continue;
        const i = kv.indexOf('=');
        if (i > 0) rec[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return rec;
    })
    .filter((rec) => Object.keys(rec).length > 1);
}

/** First record whose name matches, e.g. the Esports classification row. */
function findNavEntry(records, nameRe) {
  return records.find((r) => nameRe.test(r.NA || '') || nameRe.test(r.N2 || '')) || null;
}

/**
 * bet365 quotes prices as fractions ("5/2", "10/11") or "EVS".
 * Everything downstream works in decimal.
 */
function fractionToDecimal(odds) {
  const s = String(odds || '').trim();
  if (!s) return null;
  if (/^evs?$/i.test(s)) return 2;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (!m) {
    const d = Number(s);
    return Number.isFinite(d) && d > 1 ? d : null;
  }
  const den = Number(m[2]);
  if (!den) return null;
  return Number(m[1]) / den + 1;
}

/**
 * Route strings are '#'-delimited segments: '#AC#B151#C1#D50#E3#F163#'.
 * Returns { A:'C', B:'151', C:'1', D:'50', E:'3', F:'163' }.
 */
function parseRoute(pd) {
  const out = {};
  for (const seg of String(pd || '').split('#')) {
    if (!seg) continue;
    const m = /^([A-Z])(.*)$/.exec(seg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const buildRoute = (parts) =>
  '#' + Object.entries(parts).map(([k, v]) => `${k}${v}`).join('#') + '#';

module.exports = { parseRecords, findNavEntry, fractionToDecimal, parseRoute, buildRoute };
