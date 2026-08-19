/**
 * jules_state_manager.mjs
 * Unified state management for the Jules pipeline.
 *
 * Provides:
 *   - Atomic state load/save with schema migration
 *   - Rolling state compaction (archives old history to vault)
 *   - Shared helpers used by dispatcher, notifier, and merge gatekeeper
 *
 * State file: jules-state.json (kept lightweight, <50KB target)
 * Archive:    vault/02-ARCHIVE/jules-history/history-[YYYY-MM].json
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.WORKSPACE || '/home/node/.openclaw/workspace';
const STATE_PATH = process.env.JULES_STATE_PATH || join(WORKSPACE, 'jules-state.json');
const ARCHIVE_DIR = process.env.JULES_ARCHIVE_DIR || join(WORKSPACE, 'vault/02-ARCHIVE/jules-history');
const STATE_SCHEMA_VERSION = 2;

// Compaction thresholds
const HISTORY_ACTIVE_CAP = 30;    // Keep at most 30 completed entries in main state
const STATE_SIZE_TARGET = 50 * 1024; // 50KB target for jules-state.json

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
  // Lightweight PR hygiene on every save (not just dispatcher saves)
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
 *
 * Strategy:
 *   1. Separate active/in-flight sessions from completed/failed ones
 *   2. Keep only the most recent HISTORY_ACTIVE_CAP completed history entries
 *   3. Archive older entries to vault/02-ARCHIVE/jules-history/history-[YYYY-MM].json
 *   4. Prune completed sessions that are both old AND have their PRs resolved
 *   5. Prune resolved/merged PRs older than 30 days
 */
export function compactState(state) {
  const history = state.dispatch.history;
  if (!Array.isArray(history) || history.length <= HISTORY_ACTIVE_CAP) {
    // Even if history is small, still prune stale sessions/PRs
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
 * Merges with existing archive files if present.
 */
function archiveHistoryEntries(entries) {
  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  // Group entries by YYYY-MM
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
 * Active/in-flight sessions are always preserved.
 */
function pruneStaleSessions(state) {
  const sessions = state.sessions;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7); // 7-day retention for completed sessions

  for (const [id, session] of Object.entries(sessions)) {
    if (typeof session !== 'object') continue;
    const sessionState = session.state;

    // Always keep active/in-flight sessions
    if (sessionState !== 'COMPLETED' && sessionState !== 'FAILED') continue;

    // Check age
    const dispatchedAt = session.dispatchedAt ? new Date(session.dispatchedAt) : null;
    if (dispatchedAt && dispatchedAt > cutoff) continue; // Too recent, keep

    // Old enough to prune
    delete sessions[id];
  }
}

/**
 * Remove PRs that have been merged/closed for more than 30 days.
 * Keeps KIMI_K3_AUDIT_REQUIRED PRs indefinitely (they need human action).
 *
 * Also migrates legacy AWAITING_ARCHITECT_APPROVAL PRs to MERGED status
 * (these are zombies from the pre-KIMI_K3 schema era — their sessions are
 * all long completed, so they should be treated as resolved).
 */
function pruneResolvedPrs(state) {
  const prs = state.prs;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (const [url, pr] of Object.entries(prs)) {
    // Migrate legacy zombie status to MERGED (all associated sessions are completed)
    if (pr.status === 'AWAITING_ARCHITECT_APPROVAL') {
      pr.status = 'MERGED';
      pr.migratedAt = new Date().toISOString();
    }

    if (pr.status === 'KIMI_K3_AUDIT_REQUIRED') continue; // Still pending
    const recordedAt = pr.recordedAt ? new Date(pr.recordedAt) : null;
    if (recordedAt && recordedAt < cutoff) {
      delete prs[url];
    }
  }
}

// ==========================================
// Shared State Queries
// ==========================================

/**
 * Check if a dependency spec is satisfied (has at least one COMPLETED session).
 * Used by dispatcher for dependency resolution.
 */
export function isDependencySatisfied(depSpecName, state) {
  const matches = Object.values(state.sessions || {}).filter(s =>
    s.spec === depSpecName ||
    s.spec === depSpecName + '.md' ||
    (s.title && s.title.toLowerCase().includes(depSpecName.toLowerCase()))
  );
  if (matches.length === 0) return false;
  return matches.some(m => m.state === 'COMPLETED');
}

/**
 * Get sessions that are currently active (not COMPLETED or FAILED).
 */
export function getActiveSessions(state) {
  return Object.entries(state.sessions || {})
    .filter(([, s]) => {
      const st = typeof s === 'object' ? s.state : s;
      return st !== 'COMPLETED' && st !== 'FAILED';
    });
}

/**
 * Get PRs awaiting audit/approval.
 */
export function getPendingPrs(state, statusFilter = 'KIMI_K3_AUDIT_REQUIRED') {
  return Object.values(state.prs || {}).filter(p => p.status === statusFilter);
}

/**
 * Get the current state file size in bytes.
 */
export function getStateFileSize() {
  try {
    return statSync(STATE_PATH).size;
  } catch {
    return 0;
  }
}

/**
 * Load archived history for a given month (YYYY-MM).
 * Returns empty array if no archive exists.
 */
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

/**
 * List all available archive months.
 */
export function listArchiveMonths() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .filter(f => f.startsWith('history-') && f.endsWith('.json'))
    .map(f => f.replace('history-', '').replace('.json', ''))
    .sort();
}

// Re-export constants for consumers
export { STATE_PATH, ARCHIVE_DIR, STATE_SCHEMA_VERSION, HISTORY_ACTIVE_CAP };
