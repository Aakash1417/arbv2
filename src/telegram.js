'use strict';

const { marketLabel, calculatePlatformSizing } = require('./arb');

/**
 * Escapes special HTML characters for Telegram HTML parse mode.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const american = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Formats timestamps in local timezone.
 */
function formatTime(ms, tz = 'America/Edmonton') {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Formats a single arbitrage opportunity into concise, clear text with platform bet sizing and profit info.
 */
function formatArbBlock(arb, tz = 'America/Edmonton', nowMs = Date.now()) {
  const tag =
    arb.type === 'middle'
      ? `MIDDLE ${arb.middleRange[0]}–${arb.middleRange[1]}`
      : arb.shape === 'categorical' && arb.legs.length > 2
        ? `${arb.legs.length}-WAY`
        : 'EXACT';

  const mLabel = escapeHtml(marketLabel(arb));
  const league = escapeHtml(arb.event.league || 'LoL');
  const matchName = escapeHtml(arb.event.name);
  const matchTime = escapeHtml(formatTime(arb.event.startTime, tz));
  const sizing = calculatePlatformSizing(arb, nowMs);

  let out = `<b>${pct(arb.roi)} [${tag}]</b>\n`;
  out += `<b>${league}</b> — ${matchName} (${matchTime})\n`;
  out += `${mLabel}\n`;

  // Legs breakdown (American odds only, clickable book link, platform stakes)
  arb.legs.forEach((l) => {
    const bookStr = l.url
      ? `<a href="${l.url}">${escapeHtml(l.book)}</a>`
      : escapeHtml(l.book);
    const legLabel = escapeHtml(l.label);
    const oddsStr = american(l.american);
    const stakeVal = sizing.legStakes[l.book];
    const stakeStr = stakeVal ? ` — Bet: <b>$${stakeVal.toFixed(2)}</b>` : '';

    out += `• ${legLabel}: <code>${oddsStr}</code> on ${bookStr}${stakeStr}\n`;
  });

  if (arb.type === 'middle' && arb.middleRange) {
    out += `Both legs win between ${arb.middleRange[0]} and ${arb.middleRange[1]}\n`;
  }

  out += `🎯 <b>BET99 Target Win:</b> $${sizing.targetWin.toFixed(2)} | <b>Total Bet:</b> $${sizing.totalStake.toFixed(2)} | <b>Max Profit:</b> $${sizing.maxProfit.toFixed(2)}\n`;

  return out;
}

/**
 * Builds Telegram messages from a scan result.
 */
function formatTelegramMessages(result, opts = {}) {
  const tz = opts.timezone || 'America/Edmonton';
  const nowMs = opts.now || Date.now();
  const arbs = opts.all ? result.allArbs : result.arbs;

  if (!arbs || !arbs.length) {
    return [
      `No arbitrage opportunities found at or above ${(Number(opts.minRoi || 0.01) * 100).toFixed(1)}% ROI.`,
    ];
  }

  const messages = [];
  let currentMsg = `<b>Found ${arbs.length} arbitrage opportunit${arbs.length === 1 ? 'y' : 'ies'}:</b>\n\n`;

  for (let i = 0; i < arbs.length; i++) {
    const block = formatArbBlock(arbs[i], tz, nowMs) + '\n';

    if (currentMsg.length + block.length > 3900) {
      messages.push(currentMsg.trim());
      currentMsg = `<b>Arb Opportunities (Part ${messages.length + 1})</b>\n\n` + block;
    } else {
      currentMsg += block;
    }
  }

  if (currentMsg.trim().length > 0) {
    messages.push(currentMsg.trim());
  }

  return messages;
}

/**
 * Sends a single text message to a Telegram chat using Telegram Bot API.
 */
async function sendTelegramMessage(token, chatId, text, { parseMode = 'HTML', disableWebPagePreview = true } = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is required');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disableWebPagePreview,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`Telegram API Error: ${body.description || res.statusText || res.status}`);
  }
  return body;
}

/**
 * High-level function to dispatch full scan report to Telegram.
 */
async function dispatchTelegramReport(token, chatId, scanResult, opts = {}) {
  const arbs = opts.all ? scanResult.allArbs : scanResult.arbs;
  const hasArbs = arbs && arbs.length > 0;

  if (!hasArbs && !opts.sendEmptyReport) {
    return { sent: false, reason: 'No arbs found and sendEmptyReport is false' };
  }

  const messages = formatTelegramMessages(scanResult, opts);
  const responses = [];

  for (const msg of messages) {
    const res = await sendTelegramMessage(token, chatId, msg, {
      parseMode: 'HTML',
      disableWebPagePreview: true,
    });
    responses.push(res);
  }

  return { sent: true, count: messages.length, responses };
}

module.exports = {
  escapeHtml,
  formatTime,
  formatArbBlock,
  formatTelegramMessages,
  sendTelegramMessage,
  dispatchTelegramReport,
};
