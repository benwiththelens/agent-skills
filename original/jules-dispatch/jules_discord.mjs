#!/usr/bin/env node
/**
 * jules-discord.mjs
 * Shared Discord alerting helper for the Jules pipeline.
 *
 * Used by:
 *   - jules-queue-dispatcher.mjs (per-job dispatch + daily digest notifications)
 *   - jules-notifier.mjs         (per-job session state transition notifications)
 *
 * Delivery strategy:
 *   1. Discord webhook (from ~/.openclaw/credentials/jules.json -> webhookUrl)
 *   2. Fallback: OpenClaw CLI `openclaw message send` to the #jules channel
 *
 * Orchestrated by VANTAGE co-pilot on Cato.
 */

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import dns from 'dns';

// Force IPv4 globally to prevent ENETUNREACH on IPv6-only lookups in containers without IPv6 routes
const originalLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (typeof options === 'number') {
    options = { family: options };
  } else if (!options) {
    options = {};
  }
  options.family = 4;
  return originalLookup(hostname, options, callback);
};

const CREDENTIALS_PATH = '/home/node/.openclaw/credentials/jules.json';
const DISCORD_CHANNEL = '1527898781960507463';

let config = {};
try {
  config = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
} catch (e) {
  console.error(`[Jules Discord] Failed to load credentials from ${CREDENTIALS_PATH}:`, e.message);
}

/**
 * Send a message to the #jules Discord channel.
 * Tries the configured webhook first, falls back to the OpenClaw CLI.
 * Never throws — notification failures are logged and swallowed so they
 * cannot break dispatch/monitoring flows.
 *
 * @param {string} text - Discord-flavored markdown message body
 * @returns {Promise<boolean>} true if delivered via either transport
 */
export async function sendDiscordAlert(text) {
  const webhookUrl = config.webhookUrl;
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text })
      });
      if (!response.ok) {
        throw new Error(`Webhook responded with status ${response.status}`);
      }
      console.log('[Jules Discord] Sent webhook alert.');
      return true;
    } catch (error) {
      console.error('[Jules Discord] Webhook failed, falling back to CLI:', error.message);
    }
  }

  try {
    execFileSync('openclaw', [
      'message',
      'send',
      '--target',
      `channel:${DISCORD_CHANNEL}`,
      '--message',
      text
    ]);
    console.log('[Jules Discord] Sent CLI alert.');
    return true;
  } catch (error) {
    console.error('[Jules Discord] CLI alert failed:', error.message);
    return false;
  }
}
