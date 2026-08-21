'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  getDb,
  getArbSignature,
  processNewArbs,
  markArbsSentToTelegram,
  getAllDbArbs,
} = require('../src/db');

const TEST_DB_PATH = path.resolve(__dirname, '.test_arbs.db');

function cleanup() {
  if (fs.existsSync(TEST_DB_PATH)) {
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch {}
  }
}

test('getArbSignature creates unique signature per arb details', () => {
  const mockArb1 = {
    event: { league: 'LCK', name: 'T1 vs Gen.G', startTime: 1700000000000 },
    family: 'player_kills',
    scope: 1,
    subject: 'Faker',
    type: 'exact',
    legs: [
      { book: 'betway', label: 'OVER 3.5', odds: 2.1, american: 110 },
      { book: 'bet99', label: 'UNDER 3.5', odds: 2.0, american: 100 },
    ],
  };

  const mockArb2 = {
    event: { league: 'LCK', name: 'T1 vs Gen.G', startTime: 1700000000000 },
    family: 'player_kills',
    scope: 1,
    subject: 'Faker',
    type: 'exact',
    legs: [
      { book: 'betway', label: 'OVER 3.5', odds: 2.1, american: 110 },
      { book: 'bet99', label: 'UNDER 3.5', odds: 2.0, american: 100 },
    ],
  };

  const mockArb3 = {
    event: { league: 'LCK', name: 'T1 vs Gen.G', startTime: 1700000000000 },
    family: 'player_kills',
    scope: 1,
    subject: 'Chovy',
    type: 'exact',
    legs: [
      { book: 'betway', label: 'OVER 3.5', odds: 2.1, american: 110 },
      { book: 'bet99', label: 'UNDER 3.5', odds: 2.0, american: 100 },
    ],
  };

  const sig1 = getArbSignature(mockArb1);
  const sig2 = getArbSignature(mockArb2);
  const sig3 = getArbSignature(mockArb3);

  assert.strictEqual(sig1, sig2);
  assert.notStrictEqual(sig1, sig3);
});

test('processNewArbs inserts new arbs and filters duplicates', () => {
  cleanup();
  try {
    const mockArbs = [
      {
        event: { league: 'LCK', name: 'KT vs T1', startTime: 1700000000000 },
        family: 'player_kills',
        scope: 1,
        subject: 'Bdd',
        type: 'exact',
        roi: 0.05,
        legs: [
          { book: 'betway', label: 'OVER 3.5', odds: 2.75, american: 175 },
          { book: 'bet99', label: 'UNDER 3.5', odds: 1.741, american: -135 },
        ],
      },
      {
        event: { league: 'LPL', name: 'TT vs EDG', startTime: 1700000000000 },
        family: 'player_kills',
        scope: 1,
        subject: 'Junhao',
        type: 'exact',
        roi: 0.03,
        legs: [
          { book: 'betway', label: 'UNDER 3.5', odds: 2.1, american: 110 },
          { book: 'bet99', label: 'OVER 3.5', odds: 2.05, american: 105 },
        ],
      },
    ];

    // Pass 1: 2 new arbs
    const res1 = processNewArbs(mockArbs, { dbPath: TEST_DB_PATH });
    assert.strictEqual(res1.newCount, 2);
    assert.strictEqual(res1.existingCount, 0);

    // Pass 2: exact same arbs -> 0 new arbs
    const res2 = processNewArbs(mockArbs, { dbPath: TEST_DB_PATH });
    assert.strictEqual(res2.newCount, 0);
    assert.strictEqual(res2.existingCount, 2);

    // Verify stored rows
    const stored = getAllDbArbs(TEST_DB_PATH);
    assert.strictEqual(stored.length, 2);
    assert.strictEqual(stored[0].event_name, 'TT vs EDG');
    assert.strictEqual(stored[1].event_name, 'KT vs T1');
  } finally {
    cleanup();
  }
});
