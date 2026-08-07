'use strict';

/**
 * Minimal client for Ozoon's sports feed.
 *
 * One WebSocket carries everything. The protocol is plain text:
 *
 *   send:  SUBSCRIBE|A|<path>?<params>
 *   recv:  <json header>|<json body>
 *
 * Responses are bracketed by catch-up delimiters, so a batch of subscriptions
 * can share a single connection and be considered complete once every
 * `*_catchup_start` has seen its matching `*_catchup_end`.
 */

const { randomUUID } = require('crypto');

const ENDPOINT = 'wss://services.ozoon.eu/services/sports/subscription';
const ORIGIN = 'https://www.ozoon.eu';

/** League of Legends competition node. */
const LOL_COMPETITION = '117310';

const competitionPath = (id = LOL_COMPETITION) =>
  `/competitions/${id}?marketFilterId=def&wsOnly=true&catchupDelimiter=true&eventsLimit=5000&preMatchOnly=true&delta=true`;

/** Event links are their site path with '/' swapped for '$'. */
const eventPath = (link) =>
  `/eventByLink/${String(link).replace(/\//g, '$')}?catchupEventDelimiter=true&delta=true`;

/** Split one frame into its JSON header and body. */
function parseFrame(raw) {
  const text = String(raw);
  const cut = text.indexOf('|');
  if (cut < 0) {
    try { return { header: JSON.parse(text), body: null }; } catch { return null; }
  }
  try {
    return {
      header: JSON.parse(text.slice(0, cut)),
      body: JSON.parse(text.slice(cut + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * Open one connection, fire every subscription, and gather frames until the
 * feed goes quiet or the deadline passes.
 *
 * `settleMs` is the real terminator: catch-up delimiters tell us when a
 * subscription is done, but a path that matches nothing replies with an
 * immediate start/end pair and no body, so waiting for silence is what makes
 * a partly-bad batch still return everything that did arrive.
 */
function collectFrames(paths, { settleMs = 2500, timeoutMs = 45000, onWarn } = {}) {
  return new Promise((resolve) => {
    const frames = [];
    let ws;
    try {
      ws = new WebSocket(`${ENDPOINT}/${randomUUID()}?language=en&lnGrp=2`, {
        headers: { origin: ORIGIN },
      });
    } catch (err) {
      onWarn?.(`ozoon: socket failed — ${err.message}`);
      return resolve(frames);
    }

    let settleTimer = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(frames);
    };

    const bump = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settleMs);
    };

    const hardTimer = setTimeout(() => {
      onWarn?.(`ozoon: feed still open after ${timeoutMs}ms, using what arrived`);
      finish();
    }, timeoutMs);

    ws.addEventListener('open', () => {
      for (const p of paths) ws.send(`SUBSCRIBE|A|${p}`);
      bump();
    });
    ws.addEventListener('message', (e) => {
      const f = parseFrame(e.data);
      if (f) frames.push(f);
      bump();
    });
    ws.addEventListener('error', () => {
      onWarn?.('ozoon: socket error');
      finish();
    });
    ws.addEventListener('close', finish);
  });
}

module.exports = {
  ENDPOINT,
  LOL_COMPETITION,
  competitionPath,
  eventPath,
  parseFrame,
  collectFrames,
};
