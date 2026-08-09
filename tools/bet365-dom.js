'use strict';

/**
 * Browser-side extraction for bet365 pages.
 *
 * These run inside the page via Selenium's executeScript, so they must be
 * self-contained functions with no closure over Node scope.
 *
 * bet365 lays markets out as a grid of columns inside a `gl-MarketGroup`:
 * one `gl-Market` flagged `-columnheader` holds the row labels (player or team
 * names), and the remaining `gl-Market` columns hold the prices, aligned to
 * those labels **by index**. Player props therefore look like:
 *
 *   [labels]      Siwoo   Lucid   ShowMaker  ...
 *   [Over]        2.5/1.72  2.5/1.83  3.5/1.61 ...
 *   [Under]       2.5/2.00  2.5/1.83  3.5/2.20 ...
 *
 * Index alignment is the whole game here — pairing the wrong column to a name
 * silently invents a player's price, so every reader below zips strictly and
 * drops rows whose columns disagree in length.
 */

/** Fixtures on a competition (coupon) page, with their league headings. */
function readCoupon() {
  const t = (e) => ((e && e.innerText) || '').trim();
  const nodes = [...document.querySelectorAll(
    '[class*="CompetitionMarketGroupButton_Title"],[class*="MarketGroupButton_Text"],' +
    '[class*="CouponHeader"],.ses-ParticipantFixtureDetailsEsports_TeamNames',
  )];

  const fixtures = [];
  let league = '';
  let index = 0;
  for (const n of nodes) {
    const cls = String(n.className || '');
    if (/TeamNames/.test(cls)) {
      const names = t(n).split('\n').map((s) => s.trim()).filter(Boolean);
      const box = n.closest('[class*="ParticipantFixtureDetails"]') || n;
      fixtures.push({
        index: index++,
        league,
        home: names[0] || '',
        away: names[1] || '',
        time: t(box.querySelector('[class*="BookCloses"]')),
      });
    } else {
      const s = t(n);
      if (s) league = s.split('\n')[0];
    }
  }
  return { url: location.href, fixtures };
}

/** Names of the market-group tabs ("Main Markets", "Player", "Map 1", …). */
function readNavTabs() {
  const t = (e) => ((e && e.innerText) || '').trim();
  const seen = [];
  for (const b of document.querySelectorAll('[class*="MarketGroupNavBarButton"]')) {
    const s = t(b);
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen;
}

/** Click a market-group tab by name. Returns true if one was found. */
function clickNavTab(name) {
  const t = (e) => ((e && e.innerText) || '').trim();
  const b = [...document.querySelectorAll('[class*="MarketGroupNavBarButton"]')]
    .find((x) => t(x).toLowerCase() === String(name).toLowerCase());
  if (!b) return false;
  b.click();
  return true;
}

/** How far the current view has rendered — used to poll for readiness. */
function renderState() {
  const body = document.body ? document.body.innerText : '';
  return {
    groups: document.querySelectorAll('.gl-MarketGroup').length,
    odds: document.querySelectorAll('[class*="_Odds"]').length,
    bodyLen: body.length,
  };
}

/**
 * Every market group in the current view, as label-aligned columns.
 *
 * Shape: { title, labels[], columns: [{ header, cells: [{hcap, odds}] }] }
 * where `cells[i]` belongs to `labels[i]`.
 */
function readGroups() {
  const t = (e) => ((e && e.innerText) || '').trim();

  const groups = [...document.querySelectorAll('.gl-MarketGroup')].map((g) => {
    const title = t(g.querySelector(
      '[class*="MarketGroupWithIconsButton_Text"],[class*="MarketGroupButton_Text"],[class*="GroupButton_Text"]',
    )).split('\n')[0];

    let labels = [];
    const columns = [];

    for (const m of g.querySelectorAll('.gl-Market')) {
      // Every column carries `-columnheader`; only the label column carries
      // `-haslabels`, and its rows are ParticipantLabel elements.
      const kids = [...m.children].filter((c) => !/MarketColumnHeader/.test(String(c.className || '')));
      const isLabelCol = /-haslabels/.test(String(m.className || ''))
        || kids.some((k) => /ParticipantLabel/.test(String(k.className || '')));

      if (isLabelCol) {
        const names = kids.map((k) => t(k.querySelector('[class*="_Name"]')) || t(k)).filter(Boolean);
        if (names.length > labels.length) labels = names;
        continue;
      }

      const header = t(m.querySelector('[class*="MarketColumnHeader"]'));
      // A price cell reads as "1.72", or "2.5\n1.72" when it carries a line.
      const cells = kids.map((k) => {
        const lines = t(k).split('\n').map((s) => s.trim()).filter(Boolean);
        const odds = lines.length ? lines[lines.length - 1] : '';
        const hcap = lines.length > 1 ? lines.slice(0, -1).join(' ') : '';
        return { hcap, odds, name: t(k.querySelector('[class*="_Name"]')) };
      });
      if (cells.some((c) => /\d/.test(c.odds))) columns.push({ header, cells });
    }
    return { title, labels, columns };
  }).filter((g) => g.columns.length);

  // The fixture strapline ("LOL - LCK • Aug 9 1:00 AM • Dplus KIA v KT Rolster")
  // is the only place the start time appears on an event page.
  const body = document.body ? document.body.innerText : '';
  const at = body.search(/LOL\s*-\s*\S/);
  const header = at >= 0
    ? body.slice(at, at + 200).split('\n').map((s) => s.trim()).filter((s) => s && s !== '•').slice(0, 4).join(' | ')
    : '';
  return { url: location.href, header, groups };
}

module.exports = { readCoupon, readNavTabs, clickNavTab, renderState, readGroups };
