#!/usr/bin/env node
/**
 * jules-gate.mjs
 * Lightweight zero-LLM trigger gate for OpenClaw cron.
 * Returns { fire: true } ONLY when a Jules session has completed/failed or
 * when new specs need to be generated for the next phase.
 */

import { readFileSync, existsSync } from 'fs';
import { getSession } from './jules-client.mjs';

async function checkGate() {
  const STATE_FILE = '/home/node/.openclaw/workspace/jules-state.json';
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
      if (sessionData.repo === 'gs1-link-engine' || sessionData.title?.includes('GS1') || sessionData.title?.includes('Phase')) {
        try {
          const liveSess = await getSession(id);
          // If a session finished or created a PR that has not been merged/processed yet
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
