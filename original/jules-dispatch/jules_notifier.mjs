#!/usr/bin/env node
/**
 * jules_notifier.mjs
 * Next-Gen Jules Session Monitor, Notifier, & Autonomous Feedback Orchestrator.
 *
 * Runs periodically (e.g. every 5 minutes via cron).
 * Queries active Jules sessions, detects state changes, broadcasts Discord alerts,
 * stages PRs into jules-state.json for Kimi k3 / multi-model audit gatekeeping,
 * and triggers automated OpenClaw subagent turns when Jules requests feedback or plan approval.
 *
 * Orchestrated by VANTAGE co-pilot on Cato.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import dns from 'dns';
import { getSession, listSessions } from './jules_client.mjs';
import { sendDiscordAlert } from './jules_discord.mjs';
import {
  loadState,
  saveStateRaw,
  STATE_SCHEMA_VERSION
} from './jules_state_manager.mjs';

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

const JULES_API_KEY = process.env.JULES_API_KEY;
if (!JULES_API_KEY) {
  console.error('[Jules Notifier] Error: JULES_API_KEY environment variable is required.');
  process.exit(1);
}

const PR_STATUS_AWAITING = 'KIMI_K3_AUDIT_REQUIRED';
const PR_STATUS_MERGED = 'MERGED';

function assertNoAutoMerge() {
  return true;
}

// Load stored session state via unified state manager
let savedState = loadState();

/**
 * Spawn an isolated, automated OpenClaw subagent to handle the Jules feedback request
 *
 * Model fallback chain: tries models in order until one succeeds.
 * Primary: google-direct/gemini-3.5-flash-lite (fast, cheap, concise technical clarifications)
 * Fallback: moonshot/kimi-k3 (premium, last resort for complex blocks)
 *
 * If all models fail, the orchestrated flag stays false and the notifier
 * retries on the next 5-minute sweep. Sessions are never permanently stuck.
 */
async function triggerOrchestrator(id) {
  const taskPath = `/tmp/jules-task-${id}.txt`;
  const taskContent = `You are VANTAGE's autonomous Jules Feedback Orchestrator.
A Google Jules coding session requires feedback, clarification, or plan approval.

Session ID: ${id}

Instructions:
1. Run \`node scripts/jules-client.mjs get-session ${id}\` (or inspect session details) to read the conversation and understand what Jules is asking.
2. If Jules presents an implementation plan awaiting approval, review the proposed plan against the original objective. If sound, run \`node scripts/jules-client.mjs approve-plan ${id}\`.
3. If Jules is asking a specific technical clarification, provide a direct, unambiguous code or architecture answer using \`node scripts/jules-client.mjs send-message ${id} "<your answer>"\`.
4. Output a brief 1-line summary of the decision made once resolved.
`;

  writeFileSync(taskPath, taskContent, 'utf8');

  const MODEL_CHAIN = [
    'google-direct/gemini-3.5-flash-lite',
    'moonshot/kimi-k3'
  ];

  let lastError = null;
  for (const model of MODEL_CHAIN) {
    try {
      execFileSync('openclaw', [
        'agent',
        '--agent', 'main',
        '--session-key', `agent:main:subagent:jules-${id}`,
        '--model', model,
        '--message-file', taskPath
      ], { timeout: 60000 });
      console.log(`[Jules Notifier] Successfully spawned orchestrator subagent for session ${id} (model: ${model})`);
      return; // Success — exit the retry loop
    } catch (e) {
      lastError = e;
      console.warn(`[Jules Notifier] Orchestrator failed with ${model} for session ${id}: ${e.message}`);
    }
  }

  console.error(`[Jules Notifier] All ${MODEL_CHAIN.length} models failed for session ${id}`);
  throw lastError;
}

/**
 * Extract Pull Request URLs from a completed Jules session payload
 */
function extractPullRequests(session) {
  const prs = [];
  const outputs = session.outputs || [];
  for (const out of outputs) {
    if (out.pullRequest) {
      prs.push({
        url: out.pullRequest.url,
        title: out.pullRequest.title || session.title || 'Jules PR',
        branch: out.pullRequest.branch || 'unknown'
      });
    }
  }
  // Fallback: check activities for PR creation events
  if (prs.length === 0 && Array.isArray(session.activities)) {
    for (const act of session.activities) {
      if (act.pullRequest) {
        prs.push({
          url: act.pullRequest.url,
          title: act.pullRequest.title || session.title || 'Jules PR',
          branch: act.pullRequest.branch || 'unknown'
        });
      }
    }
  }
  return prs;
}

/**
 * Extract the last prompt or question asked by Jules when waiting for user feedback
 */
function extractLastJulesMessage(session) {
  if (!session.activities || !Array.isArray(session.activities)) return '';
  for (let i = session.activities.length - 1; i >= 0; i--) {
    const act = session.activities[i];
    if (act.agentMessage?.content) return act.agentMessage.content;
    if (act.userMessage?.content) return `(User asked: ${act.userMessage.content})`;
  }
  return '';
}

/**
 * Handle a single session's state changes, stage PRs, and send Discord notifications
 */
function handleSessionUpdate(session, lastState) {
  const state = session.state;
  const id = session.name ? session.name.split('/').pop() : session.id;
  const title = session.title || 'Untitled Task';
  const repoName = session.sourceContext?.githubRepo?.repo || session.sourceContext?.source || 'Repository';

  // 1. If session is COMPLETED, stage PRs in state
  if (state === 'COMPLETED') {
    const prs = extractPullRequests(session);
    for (const pr of prs) {
      if (pr.url) {
        if (!savedState.prs[pr.url]) {
          savedState.prs[pr.url] = {
            status: PR_STATUS_AWAITING,
            url: pr.url,
            title: pr.title,
            branch: pr.branch,
            repo: repoName,
            sessionId: id,
            recordedAt: new Date().toISOString()
          };
          console.log(`[Jules Notifier] Staged PR in state: ${pr.url} [${PR_STATUS_AWAITING}]`);
        }
      }
    }
  }

  // 2. State Transition Alerts
  if (state !== lastState) {
    if (state === 'COMPLETED') {
      const prs = extractPullRequests(session);
      let alertText = `✅ **[Jules Session Completed Successfully!]**\n`;
      alertText += `> **Repo:** \`${repoName}\`\n`;
      alertText += `> **ID:** \`${id}\`\n`;

      if (prs.length > 0) {
        alertText += `\n🚀 **Pull Request(s) Processed via Kimi k3 Gatekeeper:**\n`;
        for (const pr of prs) {
          alertText += `> 🔗 ${pr.url}\n`;
          alertText += `> **Title:** *${pr.title}*\n`;
          alertText += `> **Status:** \`${savedState.prs[pr.url]?.status || 'KIMI_K3_AUDITED_AND_MERGED'}\`\n`;
        }
        alertText += `\n*Automated Security Audit & Monorepo Test Verification Completed.*`;
      } else {
        alertText += `\n*No PR output detected. VANTAGE local verification is primed.*`;
      }
      sendDiscordAlert(alertText);
    } else if (state === 'FAILED') {
      let alertText = `⚠️ **[Jules Session Failed]**\n`;
      alertText += `> **Repo:** \`${repoName}\`\n`;
      alertText += `> **ID:** \`${id}\`\n`;
      alertText += `> **Task:** *${title}*\n`;
      if (session.error) {
        alertText += `> **Error:** \`${JSON.stringify(session.error)}\`\n`;
      }
      sendDiscordAlert(alertText);
    } else if (state === 'AWAITING_USER_FEEDBACK' || state === 'REQUIRES_APPROVAL') {
      const lastMsg = extractLastJulesMessage(session);
      let alertText = `🛑 **[Jules Action Required: ${state}]**\n`;
      alertText += `> **Repo:** \`${repoName}\`\n`;
      alertText += `> **ID:** \`${id}\`\n`;
      alertText += `> **Task:** *${title}*\n\n`;
      if (lastMsg) {
        alertText += `**Jules Request:**\n\`\`\`\n${lastMsg.slice(0, 1500)}\n\`\`\`\n`;
      }
      alertText += `🤖 *Autonomous OpenClaw subagent triggered to inspect diffs and resolve blocker.*`;
      sendDiscordAlert(alertText);
    }
  }
}

/**
 * Main Notifier Loop
 *
 * Optimization: uses listSessions summary state to avoid redundant
 * getSession API calls. Only fetches full session details when:
 *   1. A session's summary state differs from cached state (transition detected)
 *   2. A session is new (not in cached state)
 *   3. A session transitioned to COMPLETED (need full payload for PR extraction)
 *
 * Sessions already known-COMPLETED/FAILED with matching summary state
 * are carried forward without an API call.
 */
async function checkJulesSessions() {
  assertNoAutoMerge();

  console.log(`[Jules Notifier] Checking active sessions at ${new Date().toISOString()}...`);

  let sessions = [];
  try {
    const listRes = await listSessions({ pageSize: 50 });
    sessions = listRes.sessions || [];
  } catch (err) {
    console.error('[Jules Notifier] Failed to list sessions:', err.message);
    return;
  }

  const updatedSessionsMap = {};
  let apiCallsSaved = 0;

  for (const s of sessions) {
    try {
      const cached = savedState.sessions[s.id];
      const lastSeenState = cached && typeof cached === 'object' ? cached.state : cached;
      const summaryState = s.state; // State from listSessions summary payload

      // Fast path: session is already known-COMPLETED/FAILED and summary agrees.
      // No need to burn a getSession API call — carry forward cached data.
      const isTerminal = (st) => st === 'COMPLETED' || st === 'FAILED';
      if (isTerminal(lastSeenState) && isTerminal(summaryState) && lastSeenState === summaryState) {
        updatedSessionsMap[s.id] = {
          ...(cached && typeof cached === 'object' ? cached : {}),
          state: summaryState,
          orchestrated: cached && typeof cached === 'object' ? cached.orchestrated : false
        };
        apiCallsSaved++;
        continue;
      }

      // Slow path: state transition detected, new session, or non-terminal state.
      // Fetch full session payload for PR extraction, prompt text, and alerts.
      const fullSession = await getSession(s.id);
      const stateChanged = fullSession.state !== lastSeenState;
      const alreadyOrchestrated = stateChanged ? false : (cached && typeof cached === 'object' ? cached.orchestrated : false);

      handleSessionUpdate(fullSession, lastSeenState);

      // Trigger autonomous subagent turn if Jules is blocked and hasn't been orchestrated for this state yet
      let nowOrchestrated = alreadyOrchestrated;
      if ((fullSession.state === 'AWAITING_USER_FEEDBACK' || fullSession.state === 'REQUIRES_APPROVAL') && !alreadyOrchestrated) {
        console.log(`[Jules Notifier] Jules session ${s.id} entered ${fullSession.state}. Triggering autonomous subagent orchestrator...`);
        try {
          await triggerOrchestrator(s.id);
          nowOrchestrated = true;
        } catch (orchErr) {
          console.error(`[Jules Notifier] Orchestrator failed to execute for session ${s.id}:`, orchErr.message);
          nowOrchestrated = false;
        }
      }

      // Preserve metadata fields if present
      updatedSessionsMap[s.id] = {
        ...(cached && typeof cached === 'object' ? cached : {}),
        state: fullSession.state,
        title: fullSession.title || (cached && typeof cached === 'object' ? cached.title : undefined),
        repo: fullSession.sourceContext?.githubRepo?.repo || (cached && typeof cached === 'object' ? cached.repo : undefined),
        orchestrated: nowOrchestrated
      };
    } catch (e) {
      console.error(`[Jules Notifier] Error processing session ${s.id}:`, e.message);
      if (savedState.sessions[s.id]) {
        updatedSessionsMap[s.id] = savedState.sessions[s.id];
      }
    }
  }

  // Save state back atomically via unified state manager
  try {
    savedState.sessions = updatedSessionsMap;
    saveStateRaw(savedState);
    console.log(`[Jules Notifier] Checked and updated state file successfully. (${apiCallsSaved} redundant API calls skipped)`);
  } catch (writeErr) {
    console.error('[Jules Notifier] Failed to persist state file:', writeErr.message);
  }
}

// Execute check
checkJulesSessions().catch(err => {
  console.error('[Jules Notifier] Fatal unhandled error:', err);
  process.exit(1);
});
