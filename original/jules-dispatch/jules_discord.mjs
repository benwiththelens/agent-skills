#!/usr/bin/env node
/**
 * jules_discord.mjs
 * Shared Discord alerting helper for the Jules pipeline.
 *
 * Delivery strategy:
 *   1. Direct Discord webhook (DISCORD_WEBHOOK_URL or ~/.openclaw/credentials/jules.json -> webhookUrl)
 *   2. Fallback: OpenClaw CLI `openclaw message send` to DISCORD_CHANNEL_ID
 *
 * Zero external dependencies · Node.js 18+
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
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

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CREDENTIALS_PATH = process.env.JULES_CREDENTIALS_PATH || (HOME ? join(HOME, '.openclaw/credentials/jules.json') : '');

let config = {};
if (CREDENTIALS_PATH && existsSync(CREDENTIALS_PATH)) {
  try {
    config = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch (e) {
    console.error(`[Jules Discord] Failed to load credentials from ${CREDENTIALS_PATH}:`, e.message);
  }
}

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || config.webhookUrl || '';
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_ID || config.discordChannelId || '';

/**
 * Send a message to Discord.
 * Tries the configured webhook first, falls back to the OpenClaw CLI.
 * Never throws — notification failures are logged and swallowed so they
 * cannot break dispatch/monitoring flows.
 *
 * @param {string} text - Discord-flavored markdown message body
 * @returns {Promise<boolean>} true if delivered via either transport
 */
export async function sendDiscordAlert(text) {
  if (WEBHOOK_URL) {
    try {
      const response = await fetch(WEBHOOK_URL, {
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

  if (DISCORD_CHANNEL) {
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

  // No webhook or channel configured
  return false;
}
