#!/usr/bin/env node
'use strict';

/**
 * Selenium collector for bet365 League of Legends markets.
 *
 * Writes a snapshot to data/bet365.json which `src/books/bet365.js` reads, so
 * the main scan stays fast HTTP while this runs on its own schedule.
 *
 *   node tools/bet365-scrape.js              scrape and write the snapshot
 *   node tools/bet365-scrape.js --hours 24   only fixtures starting within 24h
 *   node tools/bet365-scrape.js --limit 3    stop after N fixtures
 *
 * Three site behaviours shape this script:
 *
 * 1. **The browser must be visible.** Headless Chrome is served a 687-byte
 *    shell that never populates — both `--headless=new` and the old mode, held
 *    for 100s+, and a reload does not rescue it. That is also why Playwright
 *    fails here. `--headless` exists only to re-check the claim.
 *
 * 2. **Navigation needs an explicit reload.** Every route is a hash change,
 *    which the browser treats as same-document: the URL updates but the view
 *    never repaints, and `driver.get()` on a hash-only difference is a no-op.
 *    The fix is to change the hash (click or get) and then `refresh()`.
 *
 * 3. **Player props sit behind a "Player" tab** (route suffix `/I11/`) — same
 *    click-then-refresh dance.
 *
 * Because a click never unloads the coupon document, `back()` restores it
 * instantly. Every fixture's route is therefore harvested in one cheap pass
 * (~3.5s each) before any event page is loaded.
 *
 * LPL fixtures are skipped: bet365 prices no LoL player props for that league.
 */

const fs = require('fs');
const path = require('path');
const { Builder, By } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const dom = require('./bet365-dom');

const COUPON_URL = 'https://www.bet365.com/#/AC/B151/C1/D50/E3/F163/';
const SNAPSHOT = path.join(__dirname, '..', 'data', 'bet365.json');
const FIXTURE_SEL = '.ses-ParticipantFixtureDetailsEsports_TeamNames';

/** bet365 has no LoL player props for the LPL. */
const SKIP_LEAGUE = /\bLPL\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { hours: 24, limit: 0, headless: false, out: SNAPSHOT, url: COUPON_URL };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--hours': o.hours = Number(next()); break;
      case '--limit': o.limit = Number(next()); break;
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

  --hours N    only fixtures starting within N hours (default 24)
  --limit N    stop after N fixtures
  --headless   bet365 serves headless an empty shell; expect nothing
  --out FILE   snapshot path
  --url URL    competition page to start from
`;

async function waitRendered(driver, seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await sleep(3000);
    const s = await driver.executeScript(dom.renderState);
    if (s.groups > 0 && s.odds > 4) return s;
  }
  return null;
}

/**
 * Point the browser at `url` and force a real document load. `get()` alone is
 * a no-op when only the hash differs, so the refresh is what actually paints.
 */
async function hardNav(driver, url, seconds = 90) {
  await driver.get(url);
  await driver.navigate().refresh();
  return waitRendered(driver, seconds);
}

/** Click every fixture just long enough to read its route, then step back. */
async function harvestRoutes(driver, fixtures) {
  const routes = [];
  for (const f of fixtures) {
    const els = await driver.findElements(By.css(FIXTURE_SEL));
    const el = els[f.index];
    if (!el) continue;
    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', el);
    await sleep(400);
    await el.click();
    await sleep(1500);
    const url = await driver.getCurrentUrl();
    await driver.navigate().back();
    await sleep(1500);
    if (url && url !== COUPON_URL) routes.push({ ...f, url });

    // The click never unloaded the coupon, so it should still be present. If
    // the SPA did re-render, it needs a real reload before the next click.
    const alive = (await driver.executeScript(dom.readCoupon)).fixtures.length;
    if (!alive) {
      await hardNav(driver, COUPON_URL, 60).catch(() => null);
      await sleep(2000);
    }
  }
  return routes;
}

/** Load one event page and read its main + player market groups. */
async function scrapeEvent(driver, url) {
  if (!await hardNav(driver, url)) return null;
  await sleep(3000);

  const out = { url, groups: [] };
  const main = await driver.executeScript(dom.readGroups);
  out.header = main.header;
  out.groups.push(...main.groups);

  const tabs = await driver.executeScript(dom.readNavTabs);
  if (tabs.some((t) => /^player$/i.test(t))) {
    await driver.executeScript(dom.clickNavTab, 'Player');
    await sleep(2000);
    await driver.navigate().refresh();
    if (await waitRendered(driver, 75)) {
      await sleep(3000);
      const player = await driver.executeScript(dom.readGroups);
      out.header = out.header || player.header;
      out.groups.push(...player.groups);
    } else {
      console.log('    player tab never painted');
    }
  }
  return out;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv); } catch (e) { console.error(e.message, HELP); process.exit(1); }
  if (opts.help) return console.log(HELP);

  const c = new chrome.Options();
  c.addArguments('--disable-blink-features=AutomationControlled', '--window-size=1600,1400', '--lang=en-CA');
  if (opts.headless) c.addArguments('--headless=new');
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(c).build();

  const events = [];
  try {
    console.log('loading coupon…');
    await driver.get(opts.url);
    await sleep(28000);
    const { fixtures } = await driver.executeScript(dom.readCoupon);
    console.log(`  ${fixtures.length} fixtures listed`);
    if (!fixtures.length && opts.headless) {
      console.log('  (bet365 serves headless an empty shell — run without --headless)');
    }

    let wanted = fixtures.filter((f) => f.home && f.away && !SKIP_LEAGUE.test(f.league));
    if (opts.limit) wanted = wanted.slice(0, opts.limit);
    console.log(`  ${wanted.length} to scrape (LPL skipped)`);
    wanted.forEach((f) => console.log(`   · ${f.league} — ${f.home} vs ${f.away}`));

    console.log('\nharvesting routes…');
    const routes = await harvestRoutes(driver, wanted);
    console.log(`  got ${routes.length} routes`);

    for (const r of routes) {
      console.log(`scraping ${r.home} vs ${r.away}`);
      const ev = await scrapeEvent(driver, r.url);
      if (!ev) { console.log('  never rendered, skipping'); continue; }
      const players = ev.groups.filter((g) => /Player Total/i.test(g.title)).length;
      console.log(`  ${ev.groups.length} groups (${players} player-prop groups)`);
      events.push({ league: r.league, home: r.home, away: r.away, time: r.time, ...ev });
    }
  } finally {
    await driver.quit();
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify({ scrapedAt: Date.now(), events }, null, 1));
  console.log(`\nwrote ${opts.out} — ${events.length} events`);

  // The scan applies its own start-time window; the scraper takes them all.
  const withProps = events.filter((e) => e.groups.some((g) => /Player Total/i.test(g.title)));
  console.log(`${withProps.length} of ${events.length} carry player props`);
}

main().catch((e) => { console.error(e); process.exit(1); });
