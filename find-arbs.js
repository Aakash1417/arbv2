#!/usr/bin/env node
'use strict';

/**
 * League of Legends arbitrage scanner: Betway (en-CA) vs BET99.
 *
 *   node find-arbs.js                       one scan, LPL/LCK/LCS, next 24h
 *   node find-arbs.js --players             player props only
 *   node find-arbs.js --hours 6 --min-roi 1 tighter window, >=1% edge only
 *   node find-arbs.js --watch 60            rescan every 60s
 *   node find-arbs.js --json out.json       also write raw results
 */

const fs = require('fs');
const { scan } = require('./src/scan');
const { FAMILIES } = require('./src/markets');
const { marketLabel } = require('./src/arb');
const { BOOKS } = require('./src/books');
const { DEFAULT_KEYS } = require('./src/leagues');

function parseArgs(argv) {
  const o = {
    leagues: DEFAULT_KEYS,
    hours: 24,
    minRoi: 0.01,
    bankroll: 100,
    crossBookOnly: true,
    families: null,
    watch: 0,
    json: null,
    all: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--leagues': o.leagues = next().split(',').map((s) => s.trim().toUpperCase()); break;
      case '--hours': o.hours = Number(next()); break;
      case '--min-roi': o.minRoi = Number(next()) / 100; break;
      case '--bankroll': o.bankroll = Number(next()); break;
      case '--allow-same-book': o.crossBookOnly = false; break;
      case '--players': o.families = ['player_kills']; break;
      case '--markets': o.families = next().split(',').map((s) => s.trim()); break;
      case '--books': o.books = next().split(',').map((s) => s.trim()); break;
      case '--list-markets': o.listMarkets = true; break;
      case '--list-books': o.listBooks = true; break;
      case '--watch': o.watch = Number(next()); break;
      case '--json': o.json = next(); break;
      case '--all': o.all = true; break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  if (o.families) {
    const bad = o.families.filter((f) => !FAMILIES[f]);
    if (bad.length) throw new Error(`unknown market(s): ${bad.join(', ')}`);
  }
  return o;
}

const HELP = `
LoL arbitrage scanner — Betway vs BET99

  --leagues LPL,LCK       leagues to scan            (default: all tracked)
  --hours N               only events starting within N hours (default 24)
  --min-roi P             minimum edge in percent    (default 2; use 0 for all)
  --bankroll N            total stake for the worked example (default 100)
  --players               player props only
  --markets a,b,c         restrict to these market families
  --books betway,bet99    restrict to these books
  --list-markets          print the market families and exit
  --list-books            print the books and their status and exit
  --allow-same-book       also report same-book middles
  --watch S               rescan every S seconds
  --json FILE             write full results as JSON
  --all                   list every pairing, not just the best per market
  -v, --verbose           show fetch warnings and matched fixtures
`;

const pct = (n) => `${(n * 100).toFixed(2)}%`;

/** Kickoff times are shown in Mountain time, matching where these are bet from. */
const DISPLAY_TZ = 'America/Edmonton';

const when = (ms) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: DISPLAY_TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
};

const american = (n) => (n > 0 ? `+${n}` : String(n));

function render(result, opts) {
  const { stats } = result;
  const line = result.books
    .filter((b) => b.active)
    .map((b) => `${b.id}: ${b.events} events / ${b.quotes} quotes`)
    .join('   ');
  console.log(`\n${line}`);
  console.log(
    `fixtures at 2+ books: ${stats.matchedFixtures}   comparable markets: ${stats.comparedMarkets}`,
  );

  for (const b of result.books.filter((x) => !x.active && x.status)) {
    console.log(`\n  ${b.id} unavailable — ${b.status.reason}`);
  }

  // A book that contributed nothing is indistinguishable from a book with no
  // markets, so always say so — the reason is in the warnings below.
  const empty = result.books.filter((b) => b.active && !b.quotes).map((b) => b.id);
  if (empty.length) console.log(`\n  contributed nothing: ${empty.join(', ')}`);

  if (opts.verbose) {
    for (const f of result.fixtures) {
      console.log(
        `   · ${String(f.league).padEnd(6)} ${when(f.startTime)}  ${f.name}  [${f.books.join(', ')}]`,
      );
    }
  }

  const list = opts.all ? result.allArbs : result.arbs;
  if (!list.length) {
    console.log('\nNo arbitrage found at the current prices.\n');
    return;
  }

  console.log(`\n${list.length} opportunit${list.length === 1 ? 'y' : 'ies'}:\n`);

  for (const a of list) {
    const tag = a.type === 'middle'
      ? `MIDDLE ${a.middleRange[0]}–${a.middleRange[1]}`
      : a.shape === 'categorical' && a.legs.length > 2 ? `${a.legs.length}-WAY` : 'EXACT';

    console.log(`  ${pct(a.roi).padStart(7)}  ${tag}  ${marketLabel(a)}`);
    console.log(`           ${a.event.league} — ${a.event.name}  (${when(a.event.startTime)})`);

    const width = Math.max(...a.legs.map((l) => l.label.length));
    a.legs.forEach((l) => {
      console.log(
        `           ${l.label.padEnd(width)}  ${american(l.american).padStart(6)} ` +
        `(${l.odds.toFixed(3)})  on ${l.book}`,
      );
    });

    if (a.type === 'middle') console.log(
      `           both legs win between ${a.middleRange[0]} and ${a.middleRange[1]}`,
    );
    if (a.pushRisk) console.log('           note: whole-number line, a tie pushes.');
    // Per-leg links: each goes straight to the book and market tab you bet on.
    a.legs.forEach((l) => console.log(`           ${l.book.padEnd(7)}-> ${l.url}`));
    console.log();
  }
}

async function once(opts) {
  const warnings = [];
  const result = await scan({ ...opts, onWarn: (m) => warnings.push(m) });
  console.log(`[${new Date().toISOString()}] scan complete`);
  render(result, opts);
  // Always shown: every warning means a book is missing data, which silently
  // changes what the scan can find.
  if (warnings.length) {
    console.log('warnings:');
    warnings.forEach((w) => console.log('  !', w));
  }
  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(result, null, 2));
    console.log(`wrote ${opts.json}`);
  }
  return result;
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message, '\n', HELP);
    process.exit(1);
  }
  if (opts.help) return console.log(HELP);
  if (opts.listMarkets) {
    for (const [id, f] of Object.entries(FAMILIES)) {
      console.log(`  ${id.padEnd(22)} ${f.label.padEnd(24)} ${f.metric}`);
    }
    return;
  }
  if (opts.listBooks) {
    for (const b of BOOKS) {
      console.log(`  ${b.id.padEnd(8)} ${b.enabled ? 'enabled ' : 'disabled'}  ${b.label}`);
      if (b.status && !b.status.ok) console.log(`           ${b.status.reason}`);
    }
    return;
  }

  if (!opts.watch) {
    await once(opts);
    return;
  }
  // Odds move constantly; keep polling until interrupted.
  for (;;) {
    try {
      await once(opts);
    } catch (err) {
      console.error('scan failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, opts.watch * 1000));
  }
})();
