/**
 * jules_state_manager.mjs
 * Unified state management for the Jules pipeline.
 *
 * Provides:
 *   - Advisory file locking to prevent parallel cron collisions
 *   - Atomic state load/save with schema migration
 *   - Rolling state compaction (archives old history to vault)
 *   - Shared helpers used by dispatcher, notifier, and merge gatekeeper
 *
 * State file: jules-state.json (kept lightweight, <50KB target)
 * Archive:    vault/02-ARCHIVE/jules-history/history-[YYYY-MM].json
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';

const WORKSPACE = process.env.WORKSPACE || process.cwd();
const STATE_PATH = process.env.JULES_STATE_PATH || join(WORKSPACE, 'jules-state.json');
const LOCK_PATH = STATE_PATH + '.lock';
const ARCHIVE_DIR = process.env.JULES_ARCHIVE_DIR || join(WORKSPACE, 'vault/02-ARCHIVE/jules-history');
const STATE_SCHEMA_VERSION = 2;

// Compaction thresholds
const HISTORY_ACTIVE_CAP = 30;    // Keep at most 30 completed entries in main state
const STATE_SIZE_TARGET = 50 * 1024; // 50KB target for jules-state.json

// Locking configuration
const LOCK_STALE_MS = 10000;      // 10 seconds — locks older than this are considered stale
const LOCK_RETRY_MS = 3000;       // Max time to spend retrying lock acquisition
const LOCK_RETRY_JITTER_MS = 100; // Random jitter to prevent thundering herd

// ==========================================
// Advisory File Locking
// ==========================================

/**
 * Check if a lock file is stale (older than LOCK_STALE_MS).
 */
function isLockStale(lockPath) {
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));
    const age = Date.now() - (lockData.timestamp || 0);
    return age > LOCK_STALE_MS;
  } catch {
    // If we can't read/parse the lock, treat it as stale
    return true;
  }
}

/**
 * Acquire an advisory lock using a pid/timestamp-based lockfile.
 * Implements stale-lock expiration and retry loop with randomized jitter.
 *
 * @returns {Promise<boolean>} true if lock acquired, false if timeout
 */
export async function acquireLock() {
  const start = Date.now();
  const lockData = {
    pid: process.pid,
    timestamp: Date.now(),
    hostname: hostname()
  };

  while (Date.now() - start < LOCK_RETRY_MS) {
    // Check if lock exists
    if (existsSync(LOCK_PATH)) {
      if (isLockStale(LOCK_PATH)) {
        // Lock is stale — remove it and try to acquire
        try {
          unlinkSync(LOCK_PATH);
        } catch {
          // Another process might have removed it, continue
        }
      } else {
        // Lock is active — wait with jitter and retry
        const jitter = Math.floor(Math.random() * LOCK_RETRY_JITTER_MS);
        await new Promise(r => setTimeout(r, 50 + jitter));
        continue;
      }
    }

    // Try to write lockfile using wx flag (fails if file already exists)
    try {
      writeFileSync(LOCK_PATH, JSON.stringify(lockData, null, 2), { flag: 'wx' });
      return true; // Lock acquired
    } catch {
      // Failed to acquire (race condition) — retry
      const jitter = Math.floor(Math.random() * LOCK_RETRY_JITTER_MS);
      await new Promise(r => setTimeout(r, 50 + jitter));
    }
  }

  // Timeout reached
  console.warn(`[StateManager] Lock acquisition timed out after ${LOCK_RETRY_MS}ms for ${LOCK_PATH}`);
  return false;
}

/**
 * Release the advisory lock.
 */
export function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // Ignore errors on release
  }
}

/**
 * Execute a critical section with advisory locking.
 * Automatically acquires and releases the lock.
 *
 * @param {Function} fn - Async function to execute with lock
 * @returns {Promise<any>} Result of fn()
 */
export async function withStateLock(fn) {
  const acquired = await acquireLock();
  if (!acquired) {
    console.warn('[StateManager] Proceeding without lock due to acquisition timeout');
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      releaseLock();
    }
  }
}

// ==========================================
// Schema
// ==========================================

export function emptyState() {
  return {
    version: STATE_SCHEMA_VERSION,
    sessions: {},
    dispatch: { daily: {}, history: [] },
    prs: {}
  };
}

// ==========================================
// Load / Save
// ==========================================

/**
 * Load state from disk, migrating older schemas forward.
 * Returns a fresh empty state if file is missing or corrupt.
 */
export function loadState() {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (!state.sessions) state.sessions = {};
    if (!state.dispatch) state.dispatch = { daily: {}, history: [] };
    if (!state.dispatch.daily) state.dispatch.daily = {};
    if (!state.dispatch.history) state.dispatch.history = [];
    if (!state.prs) state.prs = {};
    state.version = STATE_SCHEMA_VERSION;
    return state;
  } catch (e) {
    console.warn(`[StateManager] State file corrupt, starting fresh: ${e.message}`);
    return emptyState();
  }
}

/**
 * Save state atomically (tmp + rename).
 * Automatically compacts history before writing.
 */
export function saveState(state) {
  compactState(state);
  state.version = STATE_SCHEMA_VERSION;
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

/**
 * Save state without compaction (for notifier hot path where
 * compaction already happened or isn't needed).
 *
 * Still runs lightweight PR pruning (zombie migration + stale PR cleanup)
 * since the notifier is the most frequent writer and PR hygiene
 * shouldn't depend solely on the dispatcher running.
 */
export function saveStateRaw(state) {
  pruneResolvedPrs(state);
  state.version = STATE_SCHEMA_VERSION;
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ==========================================
// Rolling State Compaction
// ==========================================

/**
 * Compact state to keep jules-state.json lightweight.
 */
export function compactState(state) {
  const history = state.dispatch.history;
  if (!Array.isArray(history) || history.length <= HISTORY_ACTIVE_CAP) {
    pruneStaleSessions(state);
    pruneResolvedPrs(state);
    return;
  }

  // Split history: entries to archive vs entries to keep
  const toArchive = history.slice(0, history.length - HISTORY_ACTIVE_CAP);
  const toKeep = history.slice(-HISTORY_ACTIVE_CAP);

  if (toArchive.length > 0) {
    archiveHistoryEntries(toArchive);
    state.dispatch.history = toKeep;
  }

  pruneStaleSessions(state);
  pruneResolvedPrs(state);
}

/**
 * Archive history entries grouped by year-month into
 * vault/02-ARCHIVE/jules-history/history-[YYYY-MM].json files.
 */
function archiveHistoryEntries(entries) {
  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const byMonth = {};
  for (const entry of entries) {
    const dateStr = entry.dispatchedAt || entry.day || new Date().toISOString();
    const month = dateStr.slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(entry);
  }

  for (const [month, monthEntries] of Object.entries(byMonth)) {
    const archivePath = join(ARCHIVE_DIR, `history-${month}.json`);
    let existing = [];
    if (existsSync(archivePath)) {
      try {
        existing = JSON.parse(readFileSync(archivePath, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
    }
    const merged = [...existing, ...monthEntries];
    writeFileSync(archivePath, JSON.stringify(merged, null, 2), 'utf8');
  }
}

/**
 * Remove completed/failed sessions from state when they are old
 * and their associated history entry has been archived.
 */
function pruneStaleSessions(state) {
  const sessions = state.sessions;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7); // 7-day retention for completed sessions

  for (const [id, session] of Object.entries(sessions)) {
    if (typeof session !== 'object') continue;
    const sessionState = session.state;

    if (sessionState !== 'COMPLETED' && sessionState !== 'FAILED') continue;

    const dispatchedAt = session.dispatchedAt ? new Date(session.dispatchedAt) : null;
    if (dispatchedAt && dispatchedAt > cutoff) continue;

    delete sessions[id];
  }
}

/**
 * Remove PRs that have been merged/closed for more than 30 days.
 */
function pruneResolvedPrs(state) {
  const prs = state.prs;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (const [url, pr] of Object.entries(prs)) {
    if (pr.status === 'AWAITING_ARCHITECT_APPROVAL') {
      pr.status = 'MERGED';
      pr.migratedAt = new Date().toISOString();
    }

    if (pr.status === 'KIMI_K3_AUDIT_REQUIRED') continue;
    const recordedAt = pr.recordedAt ? new Date(pr.recordedAt) : null;
    if (recordedAt && recordedAt < cutoff) {
      delete prs[url];
    }
  }
}

// ==========================================
// Shared State Queries
// ==========================================

export function isDependencySatisfied(depSpecName, state) {
  const matches = Object.values(state.sessions || {}).filter(s =>
    s.spec === depSpecName ||
    s.spec === depSpecName + '.md' ||
    (s.title && s.title.toLowerCase().includes(depSpecName.toLowerCase()))
  );
  if (matches.length === 0) return false;
  return matches.some(m => m.state === 'COMPLETED');
}

export function getActiveSessions(state) {
  return Object.entries(state.sessions || {})
    .filter(([, s]) => {
      const st = typeof s === 'object' ? s.state : s;
      return st !== 'COMPLETED' && st !== 'FAILED';
    });
}

export function getPendingPrs(state, statusFilter = 'KIMI_K3_AUDIT_REQUIRED') {
  return Object.values(state.prs || {}).filter(p => p.status === statusFilter);
}

export function getStateFileSize() {
  try {
    return statSync(STATE_PATH).size;
  } catch {
    return 0;
  }
}

export function loadArchivedHistory(month) {
  const archivePath = join(ARCHIVE_DIR, `history-${month}.json`);
  if (!existsSync(archivePath)) return [];
  try {
    const data = JSON.parse(readFileSync(archivePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function listArchiveMonths() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .filter(f => f.startsWith('history-') && f.endsWith('.json'))
    .map(f => f.replace('history-', '').replace('.json', ''))
    .sort();
}

// Re-export constants for consumers
export { STATE_PATH, LOCK_PATH, ARCHIVE_DIR, STATE_SCHEMA_VERSION, HISTORY_ACTIVE_CAP };
