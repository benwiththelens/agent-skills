#!/usr/bin/env node
/**
 * jules_notifier.mjs
 * Next-Gen Jules Session Monitor, Notifier, & Tiered Feedback Orchestrator.
 *
 * Runs periodically (e.g. every 5 minutes via cron).
 * Queries active Jules sessions, detects state changes, broadcasts Discord alerts,
 * stages PRs into jules-state.json for multi-model audit gatekeeping,
 * and triggers an autonomous Tiered Complexity Cascade when Jules requests feedback or plan approval.
 *
 * Tier 1: Gemini Flash Lite triages and resolves routine approvals / simple questions.
 * Tier 2: Deferral to Moonshot Kimi k3 for high-complexity architectural decisions, RLS/auth, or deep logic.
 *
 * Zero external dependencies · Node.js 18+
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import dns from 'dns';
import { getSession, listSessions } from './jules_client.mjs';
import { sendDiscordAlert } from './jules_discord.mjs';
import {
  loadState,
  saveStateRaw,
  withStateLock,
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

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const CREDENTIALS_PATH = process.env.JULES_CREDENTIALS_PATH || (HOME ? join(HOME, '.openclaw/credentials/jules.json') : '');

let config = {};
if (CREDENTIALS_PATH && existsSync(CREDENTIALS_PATH)) {
  try {
    config = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch (e) {
    // ignore
  }
}

const JULES_API_KEY = proces…_KEY || config.apiKey || '';
if (!JULES_API_KEY) {
  console.error('[Jules Notifier] Error: JULES_API_KEY environment variable (or credentials file) is required.');
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
 * Exponential backoff configuration for orchestrator retries
 */
const ORCHESTRATOR_MAX_RETRIES = 5;
const ORCHESTRATOR_BASE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes base backoff
const ORCHESTRATOR_MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour max backoff

function isOrchestratorInBackoff(sessionData) {
  if (!sessionData || typeof sessionData !== 'object') return false;
  if (!sessionData.orchestratorNextRetryAt) return false;
  const nextRetry = new Date(sessionData.orchestratorNextRetryAt).getTime();
  return Date.now() < nextRetry;
}

function recordOrchestratorFailure(sessionData, error) {
  if (!sessionData || typeof sessionData !== 'object') return;
  const retries = (sessionData.orchestratorRetryCount || 0) + 1;
  sessionData.orchestratorRetryCount = retries;
  sessionData.orchestratorLastError = error.message;

  if (retries >= ORCHESTRATOR_MAX_RETRIES) {
    sessionData.orchestratorBlocked = true;
    sessionData.orchestratorNextRetryAt = null;
    console.warn(`[Jules Notifier] Orchestrator max retries (${ORCHESTRATOR_MAX_RETRIES}) reached. Marked as ORCHESTRATOR_BLOCKED.`);
  } else {
    const backoffMs = Math.min(
      ORCHESTRATOR_BASE_BACKOFF_MS * Math.pow(2, retries - 1),
      ORCHESTRATOR_MAX_BACKOFF_MS
    );
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();
    sessionData.orchestratorNextRetryAt = nextRetry;
    console.warn(`[Jules Notifier] Orchestrator retry #${retries} scheduled for ${nextRetry} (backoff: ${backoffMs / 1000}s)`);
  }
}

function resetOrchestratorRetries(sessionData) {
  if (!sessionData || typeof sessionData !== 'object') return;
  sessionData.orchestratorRetryCount = 0;
  sessionData.orchestratorLastError = null;
  sessionData.orchestratorNextRetryAt = null;
  sessionData.orchestratorBlocked = false;
}

/**
 * Spawn an isolated, automated OpenClaw subagent using the Tiered Complexity Cascade:
 *   Tier 1 (Gemini Flash Lite): Triage feedback, handle routine tasks directly
 *   Tier 2 (Kimi k3): Deep reasoning for complex architectural changes, RLS/auth, merge conflicts
 */
async function triggerOrchestrator(id) {
  const taskPath = join(tmpdir(), `jules-task-${id}.txt`);
  const taskContent = `[Subagent Task]
You are the JULES_ORCHESTRATOR_TIER1. Your job is to triage and resolve a pending feedback request for Google Jules Session: ${id}.

## Tier 1 Responsibilities (Gemini Flash Lite)
1. Run \`node jules_client.mjs list-activities ${id}\` to pull the latest activities.
2. Identify the last agent progress update, plan, or test failure.
3. Compare the current state of the code and files with the user's initial prompt goals.
4. **Routine tasks you handle directly:**
   - Simple plan approvals (logically sound, straightforward steps)
   - Basic code questions (ESLint rules, import errors, simple syntax)
   - Standard configuration issues
   - Straightforward test failures with obvious fixes
5. **Complex tasks you DEFER to Tier 2:**
   - Multi-file architectural refactoring
   - Database schema changes, RLS policies, or auth modifications
   - Complex merge conflict resolution
   - Ambiguous requirements requiring deep reasoning
   - Cryptographic or security-critical logic

## Decision Protocol
- If the task is ROUTINE: Execute the resolution directly using approve-plan or send-message, then exit.
- If the task is COMPLEX: Emit exactly this line as your FINAL output:
  \`DEFER_TO_KIMI_K3: <brief summary of what needs deep reasoning>\`
  Then exit without taking action.

## Execution Commands
- To approve a plan: \`node jules_client.mjs approve-plan ${id}\`
- To send a message: \`node jules_client.mjs send-message ${id} "Your answer"\`

Maintain strict token hygiene. Keep answers concise, direct, and purely technical.`;

  writeFileSync(taskPath, taskContent, 'utf8');

  const TIER1_MODEL = 'google-direct/gemini-3.5-flash-lite';
  const TIER2_MODEL = 'moonshot/kimi-k3';

  let lastError = null;

  // Tier 1: Gemini Flash Lite triage
  try {
    const result = execFileSync('openclaw', [
      'agent',
      '--agent', 'main',
      '--session-key', `agent:main:subagent:jules-t1-${id}`,
      '--model', TIER1_MODEL,
      '--message-file', taskPath
    ], { timeout: 60000, encoding: 'utf8' });

    console.log(`[Jules Notifier] Tier 1 (${TIER1_MODEL}) completed for session ${id}`);

    // Check if Tier 1 deferred to Tier 2
    if (result.includes('DEFER_TO_KIMI_K3')) {
      const deferMatch = result.match(/DEFER_TO_KIMI_K3:\s*(.+)/);
      const deferReason = deferMatch ? deferMatch[1].trim() : 'Complex task requiring deep reasoning';
      console.log(`[Jules Notifier] Tier 1 deferred to Tier 2: ${deferReason}`);

      // Tier 2: Kimi k3 deep reasoning handover
      const tier2TaskPath = join(tmpdir(), `jules-task-t2-${id}.txt`);
      const tier2Content = `[Subagent Task]
You are the JULES_ORCHESTRATOR_TIER2 (Kimi k3). You are receiving a complex task deferred from Tier 1 triage.

## Original Session Context
Session ID: ${id}
Defer Reason: ${deferReason}

## Tier 1 Analysis
${result.slice(0, 2000)}

## Instructions
1. Inspect the session activities and git patch via \`node jules_client.mjs list-activities ${id}\`.
2. Apply deep architectural and security reasoning to resolve the blocker.
3. If approving a plan, run: \`node jules_client.mjs approve-plan ${id}\`.
4. If providing a technical answer, run: \`node jules_client.mjs send-message ${id} "<your detailed technical answer>"\`.
5. Output a concise summary of the decision made.`;

      writeFileSync(tier2TaskPath, tier2Content, 'utf8');

      execFileSync('openclaw', [
        'agent',
        '--agent', 'main',
        '--session-key', `agent:main:subagent:jules-t2-${id}`,
        '--model', TIER2_MODEL,
        '--message-file', tier2TaskPath
      ], { timeout: 120000, encoding: 'utf8' });

      console.log(`[Jules Notifier] Tier 2 (${TIER2_MODEL}) completed for session ${id}`);
    }

    return; // Success
  } catch (e) {
    lastError = e;
    console.warn(`[Jules Notifier] Tier 1 failed for session ${id}: ${e.message}`);

    // Fallback: try Tier 2 directly if Tier 1 crashed
    try {
      console.log(`[Jules Notifier] Attempting direct Tier 2 fallback for session ${id}...`);
      execFileSync('openclaw', [
        'agent',
        '--agent', 'main',
        '--session-key', `agent:main:subagent:jules-direct-t2-${id}`,
        '--model', TIER2_MODEL,
        '--message-file', taskPath
      ], { timeout: 120000, encoding: 'utf8' });
      console.log(`[Jules Notifier] Direct Tier 2 fallback succeeded for session ${id}`);
      return;
    } catch (t2Err) {
      console.error(`[Jules Notifier] Direct Tier 2 fallback also failed for session ${id}:`, t2Err.message);
      lastError = t2Err;
    }
  }

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

function extractLastJulesMessage(session) {
  if (!session.activities || !Array.isArray(session.activities)) return '';
  for (let i = session.activities.length - 1; i >= 0; i--) {
    const act = session.activities[i];
    if (act.agentMessage?.content) return act.agentMessage.content;
    if (act.userMessage?.content) return `(User asked: ${act.userMessage.content})`;
  }
  return '';
}

function handleSessionUpdate(session, lastState) {
  const state = session.state;
  const id = session.name ? session.name.split('/').pop() : session.id;
  const title = session.title || 'Untitled Task';
  const repoName = session.sourceContext?.githubRepo?.repo || session.sourceContext?.source || 'Repository';

  if (state === 'COMPLETED') {
    const prs = extractPullRequests(session);
    for (const pr of prs) {
      if (pr.url && !savedState.prs[pr.url]) {
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

  if (state !== lastState) {
    if (state === 'COMPLETED') {
      const prs = extractPullRequests(session);
      let alertText = `✅ **[Jules Session Completed Successfully!]**\n`;
      alertText += `> **Repo:** \`${repoName}\`\n`;
      alertText += `> **ID:** \`${id}\`\n`;

      if (prs.length > 0) {
        alertText += `\n🚀 **Pull Request(s) Staged for Audit Gatekeeper:**\n`;
        for (const pr of prs) {
          alertText += `> 🔗 ${pr.url}\n`;
          alertText += `> **Title:** *${pr.title}*\n`;
          alertText += `> **Status:** \`${savedState.prs[pr.url]?.status || 'AUDIT_REQUIRED'}\`\n`;
        }
      }
      sendDiscordAlert(alertText);
    } else if (state === 'FAILED') {
      let alertText = `⚠️ **[Jules Session Failed]**\n`;
      alertText += `> **Repo:** \`${repoName}\`\n`;
      alertText += `> **ID:** \`${id}\`\n`;
      alertText += `> **Task:** *${title}*\n`;
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
      alertText += `🤖 *Tiered Orchestrator (Flash Lite ➔ Kimi k3) triggered to resolve blocker.*`;
      sendDiscordAlert(alertText);
    }
  }
}

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
      const summaryState = s.state;

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

      const fullSession = await getSession(s.id);
      const stateChanged = fullSession.state !== lastSeenState;
      const alreadyOrchestrated = stateChanged ? false : (cached && typeof cached === 'object' ? cached.orchestrated : false);

      handleSessionUpdate(fullSession, lastSeenState);

      let nowOrchestrated = alreadyOrchestrated;
      const sessionData = cached && typeof cached === 'object' ? cached : {};

      if ((fullSession.state === 'AWAITING_USER_FEEDBACK' || fullSession.state === 'REQUIRES_APPROVAL') && !alreadyOrchestrated) {
        if (isOrchestratorInBackoff(sessionData)) {
          console.log(`[Jules Notifier] Session ${s.id} is in orchestrator backoff until ${sessionData.orchestratorNextRetryAt} — skipping this sweep`);
        } else if (sessionData.orchestratorBlocked) {
          console.warn(`[Jules Notifier] Session ${s.id} is ORCHESTRATOR_BLOCKED — requires manual intervention`);
        } else {
          console.log(`[Jules Notifier] Jules session ${s.id} entered ${fullSession.state}. Triggering Tiered Orchestrator...`);
          try {
            await triggerOrchestrator(s.id);
            nowOrchestrated = true;
            resetOrchestratorRetries(sessionData);
          } catch (orchErr) {
            console.error(`[Jules Notifier] Orchestrator failed for session ${s.id}:`, orchErr.message);
            nowOrchestrated = false;
            recordOrchestratorFailure(sessionData, orchErr);
          }
        }
      }

      updatedSessionsMap[s.id] = {
        ...sessionData,
        state: fullSession.state,
        title: fullSession.title || sessionData.title,
        repo: fullSession.sourceContext?.githubRepo?.repo || sessionData.repo,
        orchestrated: nowOrchestrated
      };
    } catch (e) {
      console.error(`[Jules Notifier] Error processing session ${s.id}:`, e.message);
      if (savedState.sessions[s.id]) {
        updatedSessionsMap[s.id] = savedState.sessions[s.id];
      }
    }
  }

  await withStateLock(async () => {
    savedState.sessions = updatedSessionsMap;
    saveStateRaw(savedState);
    console.log(`[Jules Notifier] Checked and updated state file successfully. (${apiCallsSaved} redundant API calls skipped)`);
  });

  // Auto-trigger gatekeeper if any PRs are pending audit
  const pendingPrs = Object.values(savedState.prs || {}).filter(p => p.status === 'KIMI_K3_AUDIT_REQUIRED');
  if (pendingPrs.length > 0) {
    console.log(`[Jules Notifier] ${pendingPrs.length} PR(s) pending audit — triggering merge gatekeeper pass...`);
    try {
      execFileSync('node', ['jules_merge_gatekeeper.mjs'], { timeout: 300000, stdio: 'inherit' });
    } catch (gateErr) {
      console.error('[Jules Notifier] Gatekeeper execution error:', gateErr.message);
    }
  }
}

checkJulesSessions().catch(err => {
  console.error('[Jules Notifier] Fatal unhandled error:', err);
  process.exit(1);
});
