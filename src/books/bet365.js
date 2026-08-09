'use strict';

/**
 * bet365 — reads the snapshot written by `tools/bet365-scrape.js`.
 *
 * bet365 has no usable public API: its origin returns `200 OK` with a zero-byte
 * body for every odds endpoint under automation. What *does* work is a visible
 * Chrome driven by Selenium, so the scraper renders the site and dumps a
 * snapshot, and this module normalises it. Keeping them separate stops a
 * ~40s-per-fixture browser scrape from slowing the main HTTP scan.
 *
 * Run the scraper on its own schedule:
 *   node tools/bet365-scrape.js --hours 24
 *
 * Snapshot layout (see the scraper for how it is produced):
 *   { scrapedAt, events: [{ league, home, away, header, url, groups: [
 *       { title, labels: [...], columns: [{ header, cells: [{hcap, odds, name}] }] } ] }] }
 *
 * Every column's `cells[i]` belongs to `labels[i]` — bet365 renders markets as
 * a grid, so all the mapping below is index alignment.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTeam, normalizePlayer, canonicalLeague } = require('../normalize');
const { DEFAULT_KEYS } = require('../leagues');
const { FAMILIES } = require('../markets');

const SNAPSHOT = path.join(__dirname, '..', '..', 'data', 'bet365.json');

/** Snapshots older than this are ignored rather than bet on. */
const DEFAULT_MAX_AGE_MS = 2 * 3600e3;

/** bet365 prices no LoL player props for the LPL; the scraper skips it too. */
const SKIP_LEAGUE = /\bLPL\b/i;

/** The site renders fixture times in US Pacific. */
const SITE_TZ = 'America/Los_Angeles';

/**
 * Parse "LOL - LCK | Aug 9 1:00 AM | Dplus KIA vs KT Rolster | ..." into epoch
 * ms. The clock is the site's Pacific time, so the UTC offset is resolved for
 * that actual date rather than assumed (it changes with daylight saving).
 */
function parseHeaderTime(header, now = new Date()) {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(header || ''));
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mon = months.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;

  let hour = Number(m[3]);
  if (m[5]) {
    const pm = /pm/i.test(m[5]);
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  let year = now.getUTCFullYear();
  let guess = Date.UTC(year, mon, Number(m[2]), hour, Number(m[4]));
  if (guess < now.getTime() - 182 * 864e5) guess = Date.UTC(++year, mon, Number(m[2]), hour, Number(m[4]));

  // Shift the naive UTC reading by the site's offset on that date.
  return guess + tzOffsetMs(guess, SITE_TZ);
}

/** How far `tz` is behind UTC at `ms`, in milliseconds. */
function tzOffsetMs(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return ms - asUtc;
}

/**
 * Row label -> canonical family, for groups whose labels name the market and
 * whose columns are the two teams (or Over/Under).
 */
const ROW_FAMILY = {
  'to win': 'match_winner',
  'match handicap': 'maps_handicap',
  'total maps': 'total_maps',
  'first blood': 'first_blood',
  'slay baron': 'first_baron',
  'destroy inhibitor': 'first_inhibitor',
  'kill handicap': 'map_kills_handicap',
  'total kills': 'map_total_kills',
  'total towers': 'map_total_towers',
  'total dragons': 'map_total_dragons',
  'total barons': 'map_total_barons',
};

/** Group title -> what the group is and which map it covers. */
function classifyGroup(title) {
  const s = String(title || '').trim();
  let m;

  if ((m = /^Map\s*(\d+)\s*-\s*Player Total (Kills|Deaths|Assists)$/i.exec(s))) {
    return { kind: 'player', scope: +m[1], family: `player_${m[2].toLowerCase()}` };
  }
  if ((m = /^Map\s*(\d+)\s*Winner$/i.exec(s))) return { kind: 'teamCells', scope: +m[1], family: 'map_winner' };
  if ((m = /^Map\s*(\d+)\s*-\s*Tower Handicap$/i.exec(s))) return { kind: 'teamCols', scope: +m[1], family: 'map_towers_handicap' };
  if ((m = /^Map\s*(\d+)\s*-\s*Dragon Handicap$/i.exec(s))) return { kind: 'teamCols', scope: +m[1], family: 'map_dragons_handicap' };
  if ((m = /^Map\s*(\d+)\s*-\s*(?:Totals|First Team To|Handicaps)$/i.exec(s))) return { kind: 'rows', scope: +m[1] };
  if (/^Match Lines$/i.test(s)) return { kind: 'rows', scope: 0 };
  // Player matchups, rift herald, tower-destroy etc. have no counterpart.
  return null;
}

const price = (v) => {
  const n = Number(String(v || '').trim());
  return Number.isFinite(n) && n > 1 ? n : null;
};
const numeric = (v) => {
  const n = Number(String(v || '').replace(/^\+/, '').trim());
  return Number.isFinite(n) ? n : null;
};

/**
 * A cell's line: "2.5", "-4.5", or "O 2.5"/"U 2.5" where the letter carries
 * the side rather than the column header.
 */
function readCellLine(hcap) {
  const s = String(hcap || '').trim();
  const ou = /^([OU])\s*(-?[\d.]+)$/i.exec(s);
  if (ou) return { side: ou[1].toUpperCase() === 'O' ? 'over' : 'under', line: numeric(ou[2]) };
  return { side: null, line: numeric(s) };
}

const sideFromHeader = (h) => {
  const s = String(h || '').trim().toLowerCase();
  if (s === 'over') return 'over';
  if (s === 'under') return 'under';
  return null;
};

function extractEvent(ev, { now = Date.now() } = {}) {
  if (!ev.home || !ev.away) return { event: null, quotes: [] };
  if (SKIP_LEAGUE.test(ev.league || '')) return { event: null, quotes: [] };

  const startTime = parseHeaderTime(ev.header, new Date(now));
  if (!startTime) return { event: null, quotes: [] };

  const event = {
    book: 'bet365',
    id: String(ev.url || `${ev.home}|${ev.away}`),
    name: `${ev.home} vs ${ev.away}`,
    league: canonicalLeague(ev.league),
    home: ev.home,
    away: ev.away,
    homeKey: normalizeTeam(ev.home),
    awayKey: normalizeTeam(ev.away),
    startTime,
    url: ev.url || 'https://www.bet365.com/#/AC/B151/',
  };

  const quotes = [];
  const push = (family, scope, extra, subject, marketTitle) => {
    const meta = FAMILIES[family];
    if (!meta) return;
    quotes.push({
      book: 'bet365',
      eventId: event.id,
      family,
      scope,
      subject: subject || null,
      subjectKey: subject
        ? (meta.subject === 'player' ? normalizePlayer(subject) : normalizeTeam(subject))
        : null,
      ...extra,
      marketTitle,
      url: event.url,
      ref: { group: marketTitle },
    });
  };

  for (const g of ev.groups || []) {
    const cls = classifyGroup(g.title);
    if (!cls) continue;

    // Player props: labels are players, columns are Over / Under.
    if (cls.kind === 'player') {
      for (const col of g.columns) {
        const side = sideFromHeader(col.header);
        if (!side) continue;
        // Strict zip — a length mismatch means the grid moved under us.
        if (col.cells.length !== g.labels.length) continue;
        g.labels.forEach((player, i) => {
          const odds = price(col.cells[i].odds);
          const { line } = readCellLine(col.cells[i].hcap);
          if (odds && Number.isFinite(line)) {
            push(cls.family, cls.scope, { side, line, odds, outcomeLabel: `${side} ${line}` },
              player, g.title);
          }
        });
      }
      continue;
    }

    // "Map N Winner": a single column whose cells carry the team name.
    if (cls.kind === 'teamCells') {
      for (const col of g.columns) {
        for (const cell of col.cells) {
          const team = cell.name || cell.hcap;
          const odds = price(cell.odds);
          if (team && odds) push(cls.family, cls.scope, { team, odds, outcomeLabel: team }, null, g.title);
        }
      }
      continue;
    }

    // Single-row handicap groups: each column header is a team.
    if (cls.kind === 'teamCols') {
      for (const col of g.columns) {
        const team = col.header;
        const cell = col.cells[0];
        if (!team || !cell) continue;
        const odds = price(cell.odds);
        const handicap = numeric(cell.hcap);
        if (odds && Number.isFinite(handicap)) {
          push(cls.family, cls.scope, { team, handicap, odds, outcomeLabel: `${team} ${cell.hcap}` },
            null, g.title);
        }
      }
      continue;
    }

    // Labelled rows: the label names the market, the columns are teams or O/U.
    for (const col of g.columns) {
      if (col.cells.length !== g.labels.length) continue;
      const colSide = sideFromHeader(col.header);
      const colTeam = colSide ? null : col.header;

      g.labels.forEach((label, i) => {
        const family = ROW_FAMILY[String(label).trim().toLowerCase()];
        if (!family) return;
        const meta = FAMILIES[family];
        const cell = col.cells[i];
        const odds = price(cell.odds);
        if (!odds) return;
        const { side: cellSide, line } = readCellLine(cell.hcap);

        if (meta.metric === 'margin') {
          if (!colTeam || !Number.isFinite(line)) return;
          push(family, cls.scope, { team: colTeam, handicap: line, odds, outcomeLabel: `${colTeam} ${cell.hcap}` },
            null, `${g.title} — ${label}`);
        } else if (meta.metric === 'total') {
          const side = colSide || cellSide;
          if (!side || !Number.isFinite(line)) return;
          push(family, cls.scope, { side, line, odds, outcomeLabel: `${side} ${line}` },
            null, `${g.title} — ${label}`);
        } else {
          if (!colTeam) return;
          push(family, cls.scope, { team: colTeam, odds, outcomeLabel: colTeam },
            null, `${g.title} — ${label}`);
        }
      });
    }
  }
  return { event, quotes };
}

function readSnapshot(file = SNAPSHOT) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Normalize the most recent scrape.
 *
 * @param {object} opts
 * @param {number} opts.maxAgeMs reject snapshots older than this
 */
async function collect({
  leagues = DEFAULT_KEYS,
  withinMs = 24 * 3600e3,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  file = SNAPSHOT,
  onWarn,
} = {}) {
  const snap = readSnapshot(file);
  if (!snap) {
    onWarn?.('bet365: no snapshot — run `node tools/bet365-scrape.js` first');
    return { events: [], quotes: [] };
  }

  const now = Date.now();
  const age = now - Number(snap.scrapedAt || 0);
  if (age > maxAgeMs) {
    onWarn?.(
      `bet365: snapshot is ${Math.round(age / 60e3)}min old (limit ${Math.round(maxAgeMs / 60e3)}min) — ` +
      're-run tools/bet365-scrape.js',
    );
    return { events: [], quotes: [] };
  }

  const wanted = leagues ? new Set(leagues.map((l) => l.toUpperCase())) : null;
  const events = [];
  const quotes = [];

  for (const raw of snap.events || []) {
    const { event, quotes: qs } = extractEvent(raw, { now });
    if (!event) continue;
    if (wanted && !wanted.has(event.league.toUpperCase())) continue;
    if (!(event.startTime > now - 3600e3 && event.startTime < now + withinMs)) continue;
    if (!qs.length) continue;
    events.push(event);
    quotes.push(...qs);
  }
  return { events, quotes };
}

module.exports = {
  collect, extractEvent, classifyGroup, parseHeaderTime, readSnapshot,
  SNAPSHOT, DEFAULT_MAX_AGE_MS,
};
