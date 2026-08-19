#!/usr/bin/env node
/**
 * jules_client.mjs
 * Programmatic REST client and CLI interface for the Google Jules API.
 * Zero external dependencies · Node.js 18+
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import dns from 'dns';

// Force IPv4 globally to prevent ENETUNREACH on IPv6-only lookups in containers without IPv6 routes
const originalLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
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

// Load credentials from env var or credentials file
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CREDENTIALS_PATH = process.env.JULES_CREDENTIALS_PATH || (HOME ? join(HOME, '.openclaw/credentials/jules.json') : '');

let config = {};
if (CREDENTIALS_PATH && existsSync(CREDENTIALS_PATH)) {
  try {
    config = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch (e) {
    console.error(`[Jules Client] Failed to load credentials from ${CREDENTIALS_PATH}:`, e.message);
  }
}

const API_KEY = process.env.JULES_API_KEY || config.apiKey || '';
const ENDPOINT = process.env.JULES_API_ENDPOINT || config.endpoint || 'https://jules.googleapis.com/v1alpha';

if (!API_KEY) {
  console.error('[Jules Client] Error: JULES_API_KEY environment variable is required.');
  process.exit(1);
}

/**
 * Standard fetch helper for Jules REST API
 */
async function julesFetch(path, options = {}) {
  const url = `${ENDPOINT}/${path}`;
  const headers = {
    'X-Goog-Api-Key': API_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Jules API Error [HTTP ${response.status}]: ${errorText || response.statusText}`);
  }

  // Handle empty responses gracefully (like sendMessage)
  if (response.status === 204) {
    return { ok: true };
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }
  return await response.text();
}

/**
 * List connected sources (e.g. GitHub repos connected to Jules app)
 */
export async function listSources() {
  return await julesFetch('sources');
}

/**
 * Create a new Jules development session
 * @param {string|object} sourceOrOpts - e.g. "sources/github/owner/repo" or { source, prompt, ... }
 * @param {string} [prompt] - Instructions/goal for the session
 * @param {object} [opts] - Optional overrides (startingBranch, automationMode, title, requirePlanApproval)
 */
export async function createSession(sourceOrOpts, prompt, opts = {}) {
  let payload;
  if (typeof sourceOrOpts === 'object' && sourceOrOpts !== null) {
    const p = sourceOrOpts;
    payload = {
      prompt: p.prompt,
      sourceContext: {
        source: p.source,
        githubRepoContext: {
          startingBranch: p.startingBranch || 'main'
        }
      },
      title: p.title || 'Automated Session',
      automationMode: p.automationMode || (p.autoCreatePr !== false ? 'AUTO_CREATE_PR' : 'AUTOMATION_MODE_UNSPECIFIED'),
      requirePlanApproval: p.requirePlanApproval !== undefined ? p.requirePlanApproval : false
    };
  } else {
    payload = {
      prompt,
      sourceContext: {
        source: sourceOrOpts,
        githubRepoContext: {
          startingBranch: opts.startingBranch || 'main'
        }
      },
      title: opts.title || 'Automated Session',
      automationMode: opts.automationMode || 'AUTO_CREATE_PR',
      requirePlanApproval: opts.requirePlanApproval !== undefined ? opts.requirePlanApproval : false
    };
  }

  return await julesFetch('sessions', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * Get a single session's current status/data
 */
export async function getSession(sessionId) {
  const id = sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`;
  return await julesFetch(id);
}

/**
 * List all sessions
 */
export async function listSessions(pageSizeOrOpts = 10) {
  const pageSize = typeof pageSizeOrOpts === 'object' ? (pageSizeOrOpts.pageSize || 10) : pageSizeOrOpts;
  return await julesFetch(`sessions?pageSize=${pageSize}`);
}

/**
 * Send a message/prompt update to an ongoing session
 */
export async function sendMessage(sessionId, prompt) {
  const id = sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`;
  return await julesFetch(`${id}:sendMessage`, {
    method: 'POST',
    body: JSON.stringify({ prompt })
  });
}

/**
 * Programmatically approve a generated plan
 */
export async function approvePlan(sessionId) {
  const id = sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`;
  return await julesFetch(`${id}:approvePlan`, {
    method: 'POST'
  });
}

/**
 * List activities for a specific session (to track progress, logs, and patches)
 */
export async function listActivities(sessionId, pageSize = 30) {
  const id = sessionId.startsWith('sessions/') ? sessionId : `sessions/${sessionId}`;
  return await julesFetch(`${id}/activities?pageSize=${pageSize}`);
}

// ==========================================
// CLI Execution Layer
// ==========================================
async function runCLI() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`
🤖 JULES API COMMAND LINE INTERFACE
Usage:
  node jules_client.mjs <command> [args]

Commands:
  list-sources                                    List connected GitHub repos/sources
  list-sessions [pageSize]                        List recent Jules sessions
  get-session <sessionId>                         Get detailed state of a specific session
  create-session <source> <prompt> [opts-json]    Start a new Jules coding task
  send-message <sessionId> <prompt>               Send input/feedback to a running session
  approve-plan <sessionId>                        Explicitly approve a pending execution plan
  list-activities <sessionId> [pageSize]          Retrieve active session logs and artifacts
    `);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'list-sources': {
        const res = await listSources();
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'list-sessions': {
        const pageSize = args[1] ? parseInt(args[1], 10) : 10;
        const res = await listSessions(pageSize);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'get-session': {
        const sessionId = args[1];
        if (!sessionId) throw new Error('Missing sessionId parameter');
        const res = await getSession(sessionId);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'create-session': {
        const source = args[1];
        const prompt = args[2];
        const optsJson = args[3] ? JSON.parse(args[3]) : {};
        if (!source || !prompt) throw new Error('Usage: create-session <source> <prompt> [opts-json]');
        const res = await createSession(source, prompt, optsJson);
        console.log('Session Created Successfully:');
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'send-message': {
        const sessionId = args[1];
        const prompt = args[2];
        if (!sessionId || !prompt) throw new Error('Usage: send-message <sessionId> <prompt>');
        const res = await sendMessage(sessionId, prompt);
        console.log('Message Dispatched:', JSON.stringify(res));
        break;
      }
      case 'approve-plan': {
        const sessionId = args[1];
        if (!sessionId) throw new Error('Usage: approve-plan <sessionId>');
        const res = await approvePlan(sessionId);
        console.log('Plan Approved:', JSON.stringify(res));
        break;
      }
      case 'list-activities': {
        const sessionId = args[1];
        const pageSize = args[2] ? parseInt(args[2], 10) : 30;
        if (!sessionId) throw new Error('Usage: list-activities <sessionId> [pageSize]');
        const res = await listActivities(sessionId, pageSize);
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${command}. Run "node jules_client.mjs help" for details.`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Execution Failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (process.argv[1] && (process.argv[1].endsWith('jules_client.mjs') || process.argv[1].endsWith('jules-client.mjs'))) {
  runCLI();
}
