#!/usr/bin/env node
'use strict';

/**
 * Selenium collector for bet365 League of Legends markets.
 *
 * Writes data/bet365.json, which `src/books/bet365.js` reads. Kept separate
 * from the scan so a browser run never slows down the HTTP books.
 *
 *   node tools/bet365-scrape.js              scrape and write the snapshot
 *   node tools/bet365-scrape.js --hours 24   only fixtures starting within 24h
 *   node tools/bet365-scrape.js --limit 3    stop after N fixtures
 *
 * How it works:
 *
 *   1. Load the LoL coupon and read every fixture (league, teams, kickoff).
 *      Fixtures with no kickoff time have closed/ended — they are dropped, not
 *      clicked.
 *   2. Click each wanted fixture just long enough for the hash to change,
 *      record the URL, and step back. The coupon never unloads, so `back()`
 *      restores it instantly.
 *   3. Deep-link to each recorded URL, then **refresh**, and scrape it.
 *
 * Step 3 is the important one. bet365 routes are hash changes, which the
 * browser treats as same-document — visiting the URL updates the address bar
 * but nothing repaints (`get()` on a hash-only difference is a no-op). A
 * refresh reloads the document at that hash, so the SPA boots and the page
 * actually renders. This is the manual "click a game, then hit refresh" trick.
 *
 * Player props live on the same route plus `/I11/`, loaded the same way.
 *
 * Waits are deliberately short: the coupon and each event render within a few
 * seconds or not at all, so a fixture that hasn't painted inside the render
 * budget is skipped and the run moves on rather than stalling.
 *
 * The browser must be visible: headless is served a 687-byte shell that never
 * populates, which is also why Playwright fails on this site.
 *
 * LPL is skipped — bet365 prices no LoL player props for it.
 */

const fs = require('fs');
const path = require('path');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const dom = require('./bet365-dom');
const { canonicalLeague } = require('../src/normalize');

const COUPON_URL = 'https://www.bet365.com/#/AC/B151/C1/D50/E3/F163/';
const SNAPSHOT = path.join(__dirname, '..', 'data', 'bet365.json');
const FIXTURE_SEL = '.ses-ParticipantFixtureDetailsEsports_TeamNames';

/** Nested route holding the player-prop tab. */
const PLAYER_ROUTE = 'I11/';

const SKIP_LEAGUE = /\bLPL\b/i;

/** bet365's SPA needs a moment after a load before it will answer scripts. */
const SETTLE_MS = 6000;

/**
 * Per-tab render budget when several are booting together. Loading N tabs at
 * once makes each one paint later than it would alone, so this is deliberately
 * more generous than the serial path's budget.
 */
const PARALLEL_RENDER_S = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => String((e && e.message) || e).split('\n')[0];

function parseArgs(argv) {
  const o = {
    days: 1, limit: 0, headless: false, out: SNAPSHOT, url: COUPON_URL, tabs: 4,
    // null = take every league the page lists (bar LPL). The page is the source
    // of truth; hardcoding a list silently drops competitions bet365 adds.
    leagues: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--days': o.days = Number(next()); break;
      case '--leagues': o.leagues = next().split(',').map((x) => x.trim().toUpperCase()); break;
      case '--limit': o.limit = Number(next()); break;
      case '--tabs': o.tabs = Math.max(1, Number(next())); break;
      case '--headless': o.headless = true; break;
      case '--out': o.out = next(); break;
      case '--url': o.url = next(); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown flag: ${argv[i]}`);
    }
  }
  return o;
}

const HELP = `
bet365 LoL scraper -> data/bet365.json

  --days N        how many days ahead to take, by the coupon's own date
                  headings in local time (default 1 = today and tomorrow)
  --leagues A,B   restrict to these leagues (default: every league on the page)
  --limit N       stop after N fixtures
  --tabs N        fixtures loaded concurrently (default 4)
  --headless      bet365 serves headless an empty shell; expect nothing
  --out FILE      snapshot path
`;

function makeDriver(opts) {
  const c = new chrome.Options();
  c.addArguments('--disable-blink-features=AutomationControlled', '--window-size=1600,1400', '--lang=en-CA');
  if (opts.headless) c.addArguments('--headless=new');
  return new Builder().forBrowser('chrome').setChromeOptions(c).build();
}

/** Poll (fast) until the market grid has painted, or the budget runs out. */
async function waitRendered(driver, seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const s = await driver.executeScript(dom.renderState);
      if (s.groups > 0 && s.odds > 4) return s;
    } catch { /* mid-reload — the document is briefly gone; keep polling */ }
    await sleep(700);
  }
  return null;
}

/**
 * Deep-link to `url`, force a refresh so bet365's SPA renders the hash route,
 * poll briefly for the grid, then hand the page to `read`.
 *
 * `get()` alone is a no-op when only the hash differs from the current URL, so
 * the refresh is what makes the page actually paint — the same "open the game,
 * then reload" trick that works by hand. If nothing renders inside `seconds`,
 * returns null and the caller moves on.
 */
async function loadEvent(driver, url, read, { seconds = 12 } = {}) {
  await driver.get(url);
  await driver.navigate().refresh();
  // Let the SPA boot before touching it. Polling executeScript straight
  // through a cold start reliably yields an empty page; waiting first does not.
  await sleep(SETTLE_MS);
  if (!await waitRendered(driver, seconds)) return null;
  return read();
}

/**
 * Poll the coupon until it lists fixtures. The coupon renders no market grid,
 * so readiness has to be judged on the fixtures themselves.
 */
async function waitCoupon(driver, seconds) {
  // Let the SPA boot before touching it. Polling executeScript through the
  // cold start reliably yields an empty coupon; waiting first does not.
  await sleep(SETTLE_MS);
  const end = Date.now() + seconds * 1000;
  let last = { fixtures: [], leagues: [] };
  let reported = false;
  while (Date.now() < end) {
    try {
      const r = await driver.executeScript(dom.readCoupon);
      if (r && r.fixtures.length) return { fixtures: r.fixtures, leagues: r.leagues || [] };
      last = { fixtures: (r && r.fixtures) || [], leagues: (r && r.leagues) || [] };
    } catch (err) {
      // Report once: a persistent failure here looks identical to "no fixtures".
      if (!reported) { console.log(`  (coupon read: ${firstLine(err)})`); reported = true; }
    }
    await sleep(1500);
  }
  return last;
}

/**
 * Turn a coupon date heading ("Mon Aug 10") into a local calendar day.
 *
 * The coupon shows the viewer's local clock, so these are compared against the
 * local date. The year is absent, so a heading that looks well in the past is
 * really next year's.
 */
function parseDayHeading(text, now = new Date()) {
  const m = /([A-Z][a-z]{2})\s+(\d{1,2})/.exec(String(text || '').replace(/^[A-Z][a-z]{2}\s+/, (s) =>
    // Drop a leading weekday ("Mon ") so the month is what matches.
    (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s) ? s : '')));
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mon = months.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;

  let d = new Date(now.getFullYear(), mon, Number(m[2]));
  if (d.getTime() < now.getTime() - 182 * 864e5) d = new Date(now.getFullYear() + 1, mon, Number(m[2]));
  return d;
}

/** Local midnight, `days` from today. */
function localDay(days, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/** Click each fixture to learn its route, then step back to the coupon. */
async function harvestRoutes(driver, fixtures) {
  const routes = [];
  for (const f of fixtures) {
    try {
      const els = await driver.findElements(By.css(FIXTURE_SEL));
      const el = els[f.index];
      if (!el) continue;
      await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', el);
      await sleep(150);
      await el.click();
      await sleep(1200);
      const url = await driver.getCurrentUrl();
      await driver.navigate().back();
      await sleep(1000);
      if (url && url !== COUPON_URL) routes.push({ ...f, url });
    } catch (err) {
      console.log(`  ! ${f.home} vs ${f.away}: ${firstLine(err)}`);
    }
  }
  return routes;
}

/** Main markets + player props for one fixture, via deep-link + refresh. */
async function scrapeEvent(driver, url) {
  const read = () => driver.executeScript(dom.readGroups);

  // A refresh occasionally lands mid-boot and misses the window; one quick
  // retry recovers most of those without dragging the run out.
  let main = await loadEvent(driver, url, read);
  if (!main) main = await loadEvent(driver, url, read);
  if (!main) return null;

  const out = { url, header: main.header, groups: [...main.groups] };

  // Player props are the same route plus /I11/ — deep-link + refresh loads it.
  const player = await loadEvent(driver, url + PLAYER_ROUTE, read);
  if (player) mergeGroups(out, player);
  return out;
}

/** Fold a second read's groups into an event, skipping ones already present. */
function mergeGroups(out, extra) {
  out.header = out.header || extra.header;
  for (const g of extra.groups) {
    if (!out.groups.some((x) => x.title === g.title)) out.groups.push(g);
  }
}

/**
 * Scrape a batch of fixtures across several tabs at once.
 *
 * One WebDriver session serialises its commands, so this does not run scripts
 * concurrently — what it overlaps is the *waiting*. Every tab is told to load,
 * then they all boot at the same time while we settle once, and only then are
 * they read one after another. Since almost all the per-fixture cost is waiting
 * for bet365's SPA to come up, N tabs cut the wall time by roughly N.
 *
 * Each URL still gets `get()` + `refresh()`, because a hash-only change alone
 * never repaints.
 */
async function scrapeBatch(driver, routes, home) {
  const tabs = [];
  for (const r of routes) {
    await driver.switchTo().newWindow('tab');
    tabs.push({ route: r, handle: await driver.getWindowHandle(), out: null });
  }

  const loadAll = async (urlFor) => {
    for (const t of tabs) {
      try {
        await driver.switchTo().window(t.handle);
        await driver.get(urlFor(t.route));
        await driver.navigate().refresh();
      } catch (err) { t.error = firstLine(err); }
    }
    // One settle for the whole batch — they are all booting in parallel.
    await sleep(SETTLE_MS);
  };

  /**
   * Poll the tabs round-robin rather than draining them one at a time.
   *
   * Waiting on each tab to completion in turn makes the waits add up — the
   * whole point of loading them together is lost. Cycling through instead
   * means the batch costs about as long as its slowest tab.
   */
  const readAll = async (onRead) => {
    const pending = tabs.filter((t) => !t.error);
    const finished = new Set();
    const deadline = Date.now() + PARALLEL_RENDER_S * 1000;

    while (finished.size < pending.length && Date.now() < deadline) {
      for (const t of pending) {
        if (finished.has(t)) continue;
        try {
          await driver.switchTo().window(t.handle);
          const s = await driver.executeScript(dom.renderState);
          if (s.groups > 0 && s.odds > 4) {
            onRead(t, await driver.executeScript(dom.readGroups));
            finished.add(t);
          }
        } catch (err) {
          t.error = firstLine(err);
          finished.add(t);
        }
      }
      if (finished.size < pending.length) await sleep(700);
    }
  };

  await loadAll((r) => r.url);
  await readAll((t, groups) => { t.out = { url: t.route.url, header: groups.header, groups: [...groups.groups] }; });

  // Same tabs, now pointed at the player route.
  await loadAll((r) => r.url + PLAYER_ROUTE);
  await readAll((t, groups) => { if (t.out) mergeGroups(t.out, groups); });

  for (const t of tabs) {
    try { await driver.switchTo().window(t.handle); await driver.close(); } catch { /* gone */ }
  }
  await driver.switchTo().window(home);
  return tabs;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv); } catch (e) { console.error(e.message, HELP); process.exit(1); }
  if (opts.help) return console.log(HELP);

  let driver = await makeDriver(opts);
  const events = [];
  const save = () => {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify({ scrapedAt: Date.now(), events }, null, 1));
  };

  try {
    console.log('loading coupon…');
    await driver.get(opts.url);
    // The coupon has no market grid, so `waitRendered` cannot judge it — poll
    // for the fixtures themselves, and return the moment they appear.
    const { fixtures, leagues: found } = await waitCoupon(driver, 75);
    console.log(`  ${fixtures.length} fixtures across ${found.length} leagues`);
    found.forEach((l) => console.log(`     ${l}`));
    if (!fixtures.length) {
      console.log(opts.headless
        ? '  (headless is served an empty shell — run without --headless)'
        : '  (nothing rendered; try again)');
    }

    // Fixtures are listed under date headings in local time. Keep today and
    // tomorrow and stop there — anything further out has no player props yet,
    // and clicking it is pure wasted browser time.
    const now = new Date();
    const cutoff = localDay(opts.days, now);
    let wanted = fixtures.filter((f) => {
      if (!f.home || !f.away || SKIP_LEAGUE.test(f.league)) return false;
      // No kickoff time on the coupon means the market has closed / the game
      // is over — don't bother clicking it.
      if (!f.time || !f.time.trim()) return false;
      if (opts.leagues && !opts.leagues.includes(canonicalLeague(f.league))) return false;
      const day = parseDayHeading(f.day, now);
      // An unreadable heading is kept: better a wasted click than a missed game.
      return !day || day <= cutoff;
    });
    if (opts.limit) wanted = wanted.slice(0, opts.limit);
    const skipped = fixtures.length - wanted.length;
    const until = cutoff.toDateString();
    console.log(`  ${wanted.length} to scrape (${skipped} skipped: past ${until} / no time / LPL)`);

    console.log('\nharvesting routes…');
    const routes = await harvestRoutes(driver, wanted);
    console.log(`  got ${routes.length} routes`);

    let home = await driver.getWindowHandle();
    const started = Date.now();
    console.log(`\nscraping ${routes.length} fixtures, ${opts.tabs} at a time…`);

    for (let i = 0; i < routes.length; i += opts.tabs) {
      const batch = routes.slice(i, i + opts.tabs);
      let done;
      try {
        done = await scrapeBatch(driver, batch, home);
      } catch (err) {
        console.log(`  ! batch failed: ${firstLine(err)}`);
        // Several heavy tabs can take Chrome down with them. Every route is
        // already harvested, so a fresh browser just carries on from here.
        try { await driver.quit(); } catch { /* already gone */ }
        try {
          driver = await makeDriver(opts);
          home = await driver.getWindowHandle();
          console.log('    (browser restarted)');
        } catch (e) {
          console.log(`    ! could not restart: ${firstLine(e)}`);
          break;
        }
        continue;
      }
      for (const t of done) {
        const r = t.route;
        const label = `[${routes.indexOf(r) + 1}/${routes.length}] ${r.home} vs ${r.away}`;
        if (!t.out) { console.log(`${label} … ${t.error || 'never rendered'}`); continue; }
        const players = t.out.groups.filter((g) => /Player Total/i.test(g.title)).length;
        console.log(`${label} … ${t.out.groups.length} groups, ${players} player-prop`);
        events.push({ league: r.league, home: r.home, away: r.away, time: r.time, ...t.out });
      }
      save();   // checkpoint per batch, so a later failure cannot discard work
    }
    console.log(`  scraped in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    try { await driver.quit(); } catch { /* already gone */ }
  }

  save();
  const withProps = events.filter((e) => e.groups.some((g) => /Player Total/i.test(g.title)));
  console.log(`\nwrote ${opts.out} — ${events.length} events, ${withProps.length} with player props`);
}

main().catch((e) => { console.error(e); process.exit(1); });
