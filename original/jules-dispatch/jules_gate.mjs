#!/usr/bin/env node
/**
 * jules_gate.mjs
 *
 * ⚠️  STATUS: DORMANT — Not registered in any active cron job.
 *
 * This was originally designed as a lightweight zero-LLM trigger gate
 * for OpenClaw cron, returning { fire: true } when a Jules session
 * completed/failed or when new specs needed generation.
 *
 * Its functionality is now fully covered by jules_notifier.mjs which
 * runs every 5 minutes and handles all session state transitions.
 *
 * Retained for reference only. Do not schedule without removing the
 * hardcoded repo filters and reconciling with the notifier's unified
 * state check.
 *
 * @deprecated Superseded by jules_notifier.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { getSession } from './jules_client.mjs';

async function checkGate() {
  const STATE_FILE = process.env.JULES_STATE_PATH || '/home/node/.openclaw/workspace/jules-state.json';
  if (!existsSync(STATE_FILE)) {
    console.log(JSON.stringify({ fire: false, reason: 'No jules-state.json file' }));
    return;
  }

  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const sessions = state.sessions || {};
    let needsAction = false;
    let reason = '';

    for (const [id, sessionData] of Object.entries(sessions)) {
      try {
        const liveSess = await getSession(id);
        if (liveSess.state === 'SUCCEEDED' || liveSess.state === 'COMPLETED' || liveSess.state === 'FAILED') {
          if (!sessionData.processedOvernight) {
            needsAction = true;
            reason = `Session ${id} finished with state ${liveSess.state}`;
            break;
          }
        }
      } catch (e) {
        // Ignore network errors on poll
      }
    }

    if (needsAction) {
      console.log(JSON.stringify({ fire: true, reason }));
    } else {
      console.log(JSON.stringify({ fire: false, reason: 'All active sessions still in progress; zero tokens consumed.' }));
    }
  } catch (err) {
    console.log(JSON.stringify({ fire: false, reason: err.message }));
  }
}

checkGate();
