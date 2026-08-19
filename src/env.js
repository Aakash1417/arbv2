'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Lightweight, zero-dependency .env loader.
 * Parses KEY=VALUE lines, respects comments and quoted strings.
 */
function loadEnv(envPath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return {};

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const parsed = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();

      // Unquote if wrapped in single or double quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      parsed[key] = val;
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    return parsed;
  } catch (err) {
    console.warn(`[env] Could not load ${envPath}:`, err.message);
    return {};
  }
}

/**
 * Returns structured configuration for the scanner and Telegram notifier.
 */
function getEnvConfig() {
  loadEnv();
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    minRoi: process.env.MIN_ROI !== undefined ? Number(process.env.MIN_ROI) : 0.01,
    bankroll: process.env.BANKROLL !== undefined ? Number(process.env.BANKROLL) : 100,
    hours: process.env.HOURS !== undefined ? Number(process.env.HOURS) : 24,
    sendEmptyReport:
      process.env.SEND_EMPTY_REPORT === 'true' || process.env.SEND_EMPTY_REPORT === '1',
    timezone: process.env.TIMEZONE || 'America/Edmonton',
  };
}

module.exports = { loadEnv, getEnvConfig };
