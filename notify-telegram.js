#!/usr/bin/env node
'use strict';

/**
 * LoL Arbitrage Scanner - Telegram Dispatcher
 *
 * Runs a scan pass and dispatches results directly to Telegram.
 *
 * Usage:
 *   node notify-telegram.js                  # Scan once using .env config and send to Telegram
 *   node notify-telegram.js --dry-run        # Test formatting without sending to Telegram
 *   node notify-telegram.js --loop 3600      # Run scan and notify every 3600 seconds (1 hour)
 *   node notify-telegram.js --min-roi 2      # Alert on >=2% ROI
 *   node notify-telegram.js --send-empty     # Send a notification even if 0 arbs found
 */

const fs = require('fs');
const { scan } = require('./src/scan');
const { getEnvConfig } = require('./src/env');
const { formatTelegramMessages, dispatchTelegramReport } = require('./src/telegram');
const { DEFAULT_KEYS } = require('./src/leagues');

function parseArgs(argv) {
  const env = getEnvConfig();
  const o = {
    token: env.telegramBotToken,
    chatId: env.telegramChatId,
    minRoi: env.minRoi,
    bankroll: env.bankroll,
    hours: env.hours,
    sendEmptyReport: env.sendEmptyReport,
    timezone: env.timezone,
    leagues: DEFAULT_KEYS,
    crossBookOnly: true,
    families: null,
    books: null,
    json: null,
    all: false,
    verbose: false,
    dryRun: false,
    loop: 0,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--token': o.token = next(); break;
      case '--chat-id': o.chatId = next(); break;
      case '--min-roi': o.minRoi = Number(next()) / 100; break;
      case '--bankroll': o.bankroll = Number(next()); break;
      case '--hours': o.hours = Number(next()); break;
      case '--leagues': o.leagues = next().split(',').map((s) => s.trim().toUpperCase()); break;
      case '--books': o.books = next().split(',').map((s) => s.trim()); break;
      case '--players': o.families = ['player_kills']; break;
      case '--json': o.json = next(); break;
      case '--send-empty': o.sendEmptyReport = true; break;
      case '--no-empty': o.sendEmptyReport = false; break;
      case '--dry-run': o.dryRun = true; break;
      case '--loop': o.loop = Number(next() || 3600); break;
      case '--all': o.all = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }

  return o;
}

const HELP = `
LoL Arbitrage Scanner — Telegram Notifier

Usage:
  node notify-telegram.js [options]

Options:
  --dry-run               Format messages and print to stdout without sending to Telegram
  --loop [seconds]        Run continuously every N seconds (default: 3600 for hourly)
  --min-roi [percent]     Minimum ROI edge percentage (default: from .env or 1)
  --bankroll [amount]     Total stake sizing for calculation (default: 100)
  --hours [N]             Scan events within next N hours (default: 24)
  --send-empty            Send a summary even when 0 opportunities are found
  --no-empty              Do NOT send message if 0 opportunities are found
  --token [token]         Telegram Bot Token (override .env)
  --chat-id [id]          Telegram Chat ID (override .env)
  --leagues [list]        Comma-separated leagues (e.g. LPL,LCK)
  --players               Player props only
  -v, --verbose           Show detailed scan progress
  -h, --help              Show this help message
`;

async function runOnce(opts) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Starting arbitrage scan...`);

  const warnings = [];
  const result = await scan({
    ...opts,
    onWarn: (w) => {
      warnings.push(w);
      if (opts.verbose) console.warn(`  [warn] ${w}`);
    },
  });

  const arbsCount = (opts.all ? result.allArbs : result.arbs).length;
  console.log(
    `[${ts}] Scan completed: ${result.stats.matchedFixtures} matched fixtures, ` +
    `${result.stats.comparedMarkets} compared markets, ${arbsCount} opportunities found.`
  );

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(result, null, 2));
  }

  if (opts.dryRun) {
    console.log('\n--- [DRY RUN] Telegram Messages Preview ---');
    const msgs = formatTelegramMessages(result, opts);
    msgs.forEach((m, idx) => {
      console.log(`\n=== Message ${idx + 1}/${msgs.length} (${m.length} chars) ===\n${m}`);
    });
    console.log('\n--- End of Dry Run Preview ---\n');
    return;
  }

  if (!opts.token || !opts.chatId) {
    console.error(
      '\n[ERROR] Telegram credentials not configured.\n' +
      'Please create a .env file with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID,\n' +
      'or pass --token and --chat-id.\n' +
      'See .env.example for details.\n'
    );
    if (!opts.loop) process.exit(1);
    return;
  }

  try {
    const res = await dispatchTelegramReport(opts.token, opts.chatId, result, opts);
    if (res.sent) {
      console.log(`[${ts}] Successfully sent ${res.count} message(s) to Telegram chat ${opts.chatId}.`);
    } else {
      console.log(`[${ts}] Telegram alert skipped: ${res.reason}.`);
    }
  } catch (err) {
    console.error(`[${ts}] Failed to dispatch Telegram report:`, err.message);
  }
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message, '\n', HELP);
    process.exit(1);
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (!opts.loop) {
    await runOnce(opts);
    return;
  }

  console.log(`Starting notifier loop every ${opts.loop} seconds (Ctrl+C to stop)...`);
  while (true) {
    try {
      await runOnce(opts);
    } catch (err) {
      console.error('Scan iteration error:', err.message);
    }
    console.log(`Sleeping for ${opts.loop}s until next scan...`);
    await new Promise((resolve) => setTimeout(resolve, opts.loop * 1000));
  }
})();
