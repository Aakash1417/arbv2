'use strict';

const fs = require('fs');
const path = require('path');
const { marketLabel, calculatePlatformSizing } = require('./arb');

const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/arbs.db');

let DatabaseSync;

try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    DatabaseSync = class extends BetterSqlite3 {
      constructor(filename) {
        super(filename);
      }
    };
  } catch (e2) {
    // Fallback file-backed database for Node < 22 environments without native sqlite
    DatabaseSync = class FileDatabaseSync {
      constructor(dbPath) {
        this.dbPath = dbPath;
        this.data = { arbs: [], nextId: 1 };
        this._load();
      }

      _load() {
        if (fs.existsSync(this.dbPath)) {
          try {
            const raw = fs.readFileSync(this.dbPath, 'utf8');
            if (raw.trim().startsWith('{')) {
              this.data = JSON.parse(raw);
            }
          } catch {}
        }
      }

      _save() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
      }

      exec() {
        // Schema initialization (in-memory for fallback)
      }

      prepare(sql) {
        const self = this;
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (normalized.includes('SELECT id, sent_to_telegram_at FROM arbs WHERE signature =')) {
          return {
            get(signature) {
              self._load();
              const found = self.data.arbs.find((r) => r.signature === signature);
              if (!found) return undefined;
              return { id: found.id, sent_to_telegram_at: found.sent_to_telegram_at };
            },
          };
        }

        if (normalized.includes('INSERT INTO arbs')) {
          return {
            run(
              signature,
              event_name,
              league,
              start_time,
              family,
              scope,
              subject,
              market_label,
              roi,
              target_win,
              max_profit,
              total_stake,
              legs_json,
              created_at,
              sent_to_telegram_at
            ) {
              self._load();
              const existing = self.data.arbs.find((r) => r.signature === signature);
              if (existing) {
                throw new Error('UNIQUE constraint failed: arbs.signature');
              }
              const newRow = {
                id: self.data.nextId++,
                signature,
                event_name,
                league,
                start_time,
                family,
                scope,
                subject,
                market_label,
                roi,
                target_win,
                max_profit,
                total_stake,
                legs_json,
                created_at,
                sent_to_telegram_at,
              };
              self.data.arbs.push(newRow);
              self._save();
              return { changes: 1, lastInsertRowid: newRow.id };
            },
          };
        }

        if (normalized.includes('UPDATE arbs SET sent_to_telegram_at =')) {
          return {
            run(sent_to_telegram_at, signature) {
              self._load();
              let updated = 0;
              for (const r of self.data.arbs) {
                if (r.signature === signature) {
                  r.sent_to_telegram_at = sent_to_telegram_at;
                  updated++;
                }
              }
              if (updated > 0) self._save();
              return { changes: updated };
            },
          };
        }

        if (normalized.includes('SELECT * FROM arbs ORDER BY id DESC')) {
          return {
            all() {
              self._load();
              return self.data.arbs.slice().sort((a, b) => b.id - a.id);
            },
          };
        }

        throw new Error(`Unsupported SQL statement in fallback DB: ${sql}`);
      }

      close() {
        this._save();
      }
    };
  }
}

/**
 * Ensures the directory for the DB file exists.
 */
function ensureDbDir(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Initializes and returns a DatabaseSync instance with schema.
 */
function getDb(dbPath = DEFAULT_DB_PATH) {
  ensureDbDir(dbPath);
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS arbs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT UNIQUE NOT NULL,
      event_name TEXT,
      league TEXT,
      start_time INTEGER,
      family TEXT,
      scope INTEGER,
      subject TEXT,
      market_label TEXT,
      roi REAL,
      target_win REAL,
      max_profit REAL,
      total_stake REAL,
      legs_json TEXT,
      created_at INTEGER,
      sent_to_telegram_at INTEGER
    );
  `);

  return db;
}

/**
 * Computes a unique signature hash/string for an arbitrage opportunity.
 */
function getArbSignature(arb) {
  const eventKey = arb.event
    ? `${arb.event.league || 'LoL'}|${arb.event.name}|${arb.event.startTime}`
    : 'unknown_event';
  const family = arb.family || 'unknown_family';
  const scope = arb.scope ?? 0;
  const subject = arb.subject || '';
  const type = arb.type || 'exact';
  const middleStr = arb.middleRange ? arb.middleRange.join('-') : '';

  const legSig = (arb.legs || [])
    .map((l) => `${l.book}:${l.label}:${l.odds}:${l.american}`)
    .sort()
    .join('|');

  return `${eventKey}::${family}::${scope}::${subject}::${type}::${middleStr}::${legSig}`;
}

/**
 * Inspects a list of arbs, inserts new ones into SQLite DB, and returns only the new arbs.
 * @param {Array} arbs
 * @param {object} opts
 * @returns {Array} newArbs - list of arbs that were not previously in the DB
 */
function processNewArbs(arbs, opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const nowMs = opts.now || Date.now();
  const db = getDb(dbPath);

  const checkStmt = db.prepare('SELECT id, sent_to_telegram_at FROM arbs WHERE signature = ?');
  const insertStmt = db.prepare(`
    INSERT INTO arbs (
      signature, event_name, league, start_time, family, scope, subject,
      market_label, roi, target_win, max_profit, total_stake, legs_json, created_at, sent_to_telegram_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const newArbs = [];
  let existingCount = 0;

  for (const arb of arbs) {
    const sig = getArbSignature(arb);
    const existing = checkStmt.get(sig);

    if (existing) {
      existingCount++;
      continue;
    }

    const sizing = arb.platformSizing || calculatePlatformSizing(arb, nowMs);
    const mLabel = marketLabel(arb);
    const legsJson = JSON.stringify(arb.legs || []);

    const sentAt = opts.markSent ? nowMs : null;

    try {
      insertStmt.run(
        sig,
        arb.event?.name || '',
        arb.event?.league || '',
        arb.event?.startTime || 0,
        arb.family || '',
        arb.scope ?? 0,
        arb.subject || '',
        mLabel,
        arb.roi || 0,
        sizing.targetWin || 0,
        sizing.maxProfit || 0,
        sizing.totalStake || 0,
        legsJson,
        nowMs,
        sentAt
      );

      newArbs.push({ ...arb, signature: sig });
    } catch (err) {
      // If signature constraint race occurred
      if (String(err).includes('UNIQUE constraint failed')) {
        existingCount++;
      } else {
        throw err;
      }
    }
  }

  db.close();

  return {
    newArbs,
    totalScanned: arbs.length,
    newCount: newArbs.length,
    existingCount,
  };
}

/**
 * Updates sent_to_telegram_at timestamp for a list of arb signatures.
 */
function markArbsSentToTelegram(signatures, opts = {}) {
  if (!signatures || !signatures.length) return;
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const nowMs = opts.now || Date.now();
  const db = getDb(dbPath);

  const updateStmt = db.prepare('UPDATE arbs SET sent_to_telegram_at = ? WHERE signature = ?');

  for (const sig of signatures) {
    updateStmt.run(nowMs, sig);
  }

  db.close();
}

/**
 * Queries all recorded arbs from SQLite DB.
 */
function getAllDbArbs(dbPath = DEFAULT_DB_PATH) {
  const db = getDb(dbPath);
  const rows = db.prepare('SELECT * FROM arbs ORDER BY id DESC').all();
  db.close();
  return rows.map((r) => ({
    ...r,
    legs: r.legs_json ? JSON.parse(r.legs_json) : [],
  }));
}

module.exports = {
  getDb,
  getArbSignature,
  processNewArbs,
  markArbsSentToTelegram,
  getAllDbArbs,
  DEFAULT_DB_PATH,
};
