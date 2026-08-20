'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  escapeHtml,
  formatTime,
  formatArbBlock,
  formatTelegramMessages,
} = require('../src/telegram');
const { loadEnv } = require('../src/env');
const fs = require('fs');
const path = require('path');

test('escapeHtml escapes dangerous HTML characters', () => {
  assert.strictEqual(escapeHtml('Jackey & Love <3 > "win"'), 'Jackey &amp; Love &lt;3 &gt; &quot;win&quot;');
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('formatArbBlock renders exact arb with legs, odds, and links', () => {
  const mockArb = {
    shape: 'line',
    type: 'exact',
    family: 'player_kills',
    scope: 1,
    subject: 'ShowMaker',
    roi: 0.0427,
    impliedSum: 0.959,
    middleRange: null,
    event: {
      league: 'LCK',
      name: 'Dplus KIA vs Hanwha Life',
      startTime: Date.UTC(2026, 7, 20, 2, 0),
    },
    legs: [
      {
        book: 'betway',
        label: 'OVER 3.5',
        odds: 2.6,
        american: 160,
        url: 'https://betway.com/event/123',
      },
      {
        book: 'bet99',
        label: 'UNDER 3.5',
        odds: 1.741,
        american: -135,
        url: 'https://bet99.com/event/456',
      },
    ],
  };

  const formatted = formatArbBlock(mockArb, 'UTC');

  assert.ok(formatted.includes('4.27% [EXACT]'));
  assert.ok(formatted.includes('<b>LCK</b> — Dplus KIA vs Hanwha Life'));
  assert.ok(formatted.includes('ShowMaker Player Total Kills · Map 1'));
  assert.ok(formatted.includes('• OVER 3.5: <code>+160</code> on <a href="https://betway.com/event/123">betway</a> — Bet: <b>$'));
  assert.ok(formatted.includes('• UNDER 3.5: <code>-135</code> on <a href="https://bet99.com/event/456">bet99</a> — Bet: <b>$'));
  assert.ok(formatted.includes('BET99 Target Win:</b> $'));
  assert.ok(formatted.includes('Max Profit:</b> $'));
});

test('formatArbBlock renders middle range info for middle arbs', () => {
  const mockArb = {
    shape: 'line',
    type: 'middle',
    family: 'map_total_kills',
    scope: 1,
    subject: '',
    roi: 0.085,
    impliedSum: 0.92,
    middleRange: [15.5, 17.5],
    event: {
      league: 'LPL',
      name: 'JDG vs BLG',
      startTime: Date.UTC(2026, 7, 20, 10, 0),
    },
    legs: [
      { book: 'betway', label: 'OVER 15.5', odds: 2.1, american: 110, url: '' },
      { book: 'bet99', label: 'UNDER 17.5', odds: 2.1, american: 110, url: '' },
    ],
  };

  const formatted = formatArbBlock(mockArb, 'UTC');
  assert.ok(formatted.includes('MIDDLE 15.5–17.5'));
  assert.ok(formatted.includes('Both legs win between 15.5 and 17.5'));
});

test('formatTelegramMessages returns empty state message when no arbs', () => {
  const emptyResult = {
    scannedAt: Date.now(),
    books: [
      { id: 'betway', active: true, events: 5, quotes: 100 },
      { id: 'bet99', active: true, events: 5, quotes: 100 },
    ],
    stats: { matchedFixtures: 5, comparedMarkets: 40, rawArbs: 0 },
    arbs: [],
  };

  const msgs = formatTelegramMessages(emptyResult, { minRoi: 0.02 });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].includes('No arbitrage opportunities found'));
});

test('loadEnv loads variables correctly from file content', () => {
  const testEnvPath = path.resolve(__dirname, '.test_env');
  fs.writeFileSync(testEnvPath, 'TEST_KEY_1=hello\nTEST_KEY_2="world with spaces"\n# comment\nTEST_KEY_3=123\n');

  try {
    const loaded = loadEnv(testEnvPath);
    assert.strictEqual(loaded.TEST_KEY_1, 'hello');
    assert.strictEqual(loaded.TEST_KEY_2, 'world with spaces');
    assert.strictEqual(loaded.TEST_KEY_3, '123');
  } finally {
    if (fs.existsSync(testEnvPath)) fs.unlinkSync(testEnvPath);
  }
});
