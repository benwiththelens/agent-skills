#!/usr/bin/env node
/**
 * jules_dispatcher.mjs
 * --------------------
 * Queue-based async dispatcher for Google Jules — zero npm dependencies.
 *
 * Reads Markdown task specs from a queue directory, dispatches them to the
 * Jules API as coding sessions, tracks state + daily rate limits, and
 * archives processed specs.
 *
 * STRICT NO-AUTO-MERGE POLICY:
 *   Jules sessions may open Pull Requests (AUTO_CREATE_PR), but PRs are
 *   NEVER auto-merged. There is intentionally no merge/automerge code path
 *   in this file. Every PR requires human review & approval on GitHub.
 *
 * Configuration (environment variables):
 *   JULES_API_KEY        (required) Jules API key
 *   JULES_API_ENDPOINT   default: https://jules.googleapis.com/v1alpha
 *   JULES_QUEUE_DIR      default: ./jules-queue
 *   JULES_STATE_PATH     default: ./jules-state.json
 *   JULES_DAILY_LIMIT    default: 80  (automated dispatches per day)
 *
 * Usage:
 *   node jules_dispatcher.mjs [--dry-run] [--limit N] [--verbose]
 *   node jules_dispatcher.mjs --digest
 *
 * License: MIT
 */

import {
  readFileSync, writeFileSync, readdirSync, existsSync,
  mkdirSync, renameSync, statSync
} from 'node:fs';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_KEY = process.env.JULES_API_KEY || '';
const ENDPOINT = (process.env.JULES_API_ENDPOINT || 'https://jules.googleapis.com/v1alpha').replace(/\/$/, '');
const QUEUE_DIR = process.env.JULES_QUEUE_DIR || join(process.cwd(), 'jules-queue');
const PROCESSED_DIR = join(QUEUE_DIR, 'processed');
const STATE_PATH = process.env.JULES_STATE_PATH || join(process.cwd(), 'jules-state.json');
const DAILY_LIMIT = parseInt(process.env.JULES_DAILY_LIMIT || '80', 10);
const HISTORY_CAP = 200;

// Hard circuit breaker — must never be set to true. PRs opened by Jules
// always require human review before merging.
const PR_AUTO_MERGE_ENABLED = false;
const PR_STATUS_AWAITING = 'AWAITING_HUMAN_APPROVAL';

function assertNoAutoMerge() {
  if (PR_AUTO_MERGE_ENABLED !== false) {
    throw new Error('POLICY VIOLATION: Jules PR auto-merge is permanently disabled.');
  }
}

// ---------------------------------------------------------------------------
// CLI flags & logging
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const DIGEST_MODE = args.includes('--digest');
const LIMIT_IDX = args.indexOf('--limit');
const RUN_LIMIT = LIMIT_IDX !== -1 ? parseInt(args[LIMIT_IDX + 1], 10) : Infinity;

function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [JulesDispatcher] ${msg}`;
  console.log(data !== undefined ? `${line} ${typeof data === 'string' ? data : JSON.stringify(data)}` : line);
}

// ---------------------------------------------------------------------------
// Jules REST API client (minimal, native fetch)
// ---------------------------------------------------------------------------
async function julesFetch(path, options = {}) {
  const res = await fetch(`${ENDPOINT}/${path}`, {
    ...options,
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jules API ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function listSources() {
  const sources = [];
  let pageToken = '';
  do {
    const res = await julesFetch(`sources?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
    sources.push(...(res.sources || []));
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return sources;
}

async function createSession(source, prompt, { title, startingBranch, automationMode = 'AUTO_CREATE_PR', requirePlanApproval = false } = {}) {
  return julesFetch('sessions', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      sourceContext: { source, githubRepoContext: { startingBranch } },
      title,
      automationMode,
      requirePlanApproval
    })
  });
}

/** Map of lowercase repo name -> { name, defaultBranch } for connected sources. */
async function resolveSourceMap() {
  const map = new Map();
  for (const s of await listSources()) {
    const repo = s.githubRepo?.repo || s.name.split('/').pop();
    const defaultBranch = s.githubRepo?.defaultBranch?.displayName || 'main';
    if (repo) map.set(repo.toLowerCase(), { name: s.name, defaultBranch });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Task spec parsing (zero-dependency frontmatter)
// ---------------------------------------------------------------------------
function parseSpecMetadata(raw) {
  const meta = {};
  const lines = raw.split('\n');

  if (lines[0] && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l === '---') break;
      const m = l.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (m) meta[m[1].toLowerCase().trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } else {
    // Bare header scan (first 30 lines): `key: value` + first H1 as title
    for (let i = 0; i < Math.min(lines.length, 30); i++) {
      const l = lines[i].trim();
      if (l.startsWith('#')) {
        if (!meta.title) meta.title = l.replace(/^#+\s*/, '').trim();
        continue;
      }
      const m = l.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (m && ['repo_path', 'repo', 'title', 'priority', 'branch'].includes(m[1].toLowerCase())) {
        meta[m[1].toLowerCase().trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  if (meta.repo && !meta.repo_path) meta.repo_path = meta.repo;
  return meta;
}

/** Strip frontmatter so the Jules prompt contains only the task body. */
function stripFrontmatter(raw) {
  const lines = raw.split('\n');
  if (lines[0] && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n').trim();
    }
  }
  return raw.trim();
}

function priorityRank(p) {
  const v = (p || 'medium').toLowerCase();
  if (['critical', 'urgent', 'p0'].includes(v)) return 0;
  if (['high', 'p1'].includes(v)) return 1;
  if (['medium', 'normal', 'p2'].includes(v)) return 2;
  if (['low', 'p3'].includes(v)) return 3;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 2 : n;
}

// ---------------------------------------------------------------------------
// State ledger
// ---------------------------------------------------------------------------
function todayKey() {
  // Local calendar day (YYYY-MM-DD) for the daily counter
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyState() {
  return { version: 1, sessions: {}, dispatch: { daily: {}, history: [] } };
}

function loadState() {
  if (!existsSync(STATE_PATH)) return emptyState();
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    state.sessions ||= {};
    state.dispatch ||= { daily: {}, history: [] };
    state.dispatch.daily ||= {};
    state.dispatch.history ||= [];
    return state;
  } catch (e) {
    log('warn', `State file unreadable, starting fresh ledger: ${e.message}`);
    return emptyState();
  }
}

function saveState(state) {
  if (state.dispatch.history.length > HISTORY_CAP) {
    state.dispatch.history = state.dispatch.history.slice(-HISTORY_CAP);
  }
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH); // atomic on POSIX
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------
function printDigest() {
  const state = loadState();
  const today = todayKey();
  const used = state.dispatch.daily[today] || 0;
  const todays = state.dispatch.history.filter(h => h.day === today);

  console.log(`📋 Jules Dispatch Digest — ${today}`);
  console.log(`   Dispatched today: ${todays.length} session(s)`);
  for (const h of todays.slice(-10)) {
    console.log(`     • ${h.repo} — ${h.title || h.spec} (session ${h.sessionId})`);
  }
  console.log(`   Rate limit: ${used}/${DAILY_LIMIT} used (${Math.max(0, DAILY_LIMIT - used)} remaining)`);
  const queued = existsSync(QUEUE_DIR)
    ? readdirSync(QUEUE_DIR).filter(f => f.endsWith('.md') && statSync(join(QUEUE_DIR, f)).isFile()).length
    : 0;
  console.log(`   Pending in queue: ${queued}`);
  console.log(`\n   Auto-merge is disabled. All Jules PRs require human review before merging.`);
}

// ---------------------------------------------------------------------------
// Main dispatch flow
// ---------------------------------------------------------------------------
async function main() {
  assertNoAutoMerge();

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  node jules_dispatcher.mjs [--dry-run] [--limit N] [--verbose]
  node jules_dispatcher.mjs --digest

Environment:
  JULES_API_KEY        (required) Jules API key
  JULES_API_ENDPOINT   default: https://jules.googleapis.com/v1alpha
  JULES_QUEUE_DIR      default: ./jules-queue
  JULES_STATE_PATH     default: ./jules-state.json
  JULES_DAILY_LIMIT    default: 80`);
    return;
  }

  if (DIGEST_MODE) {
    printDigest();
    return;
  }

  if (!DRY_RUN && !API_KEY) {
    log('error', 'JULES_API_KEY is not set. Export it and retry (or use --dry-run to validate specs offline).');
    process.exit(1);
  }

  log('info', `Queue sweep${DRY_RUN ? ' (DRY RUN)' : ''} — dir: ${QUEUE_DIR}, limit: ${RUN_LIMIT === Infinity ? 'none' : RUN_LIMIT}, daily cap: ${DAILY_LIMIT}`);

  for (const dir of [QUEUE_DIR, PROCESSED_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log('info', `Created missing directory: ${dir}`);
    }
  }

  // Collect + validate pending specs
  const specs = readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.md') && statSync(join(QUEUE_DIR, f)).isFile())
    .map(f => {
      const full = join(QUEUE_DIR, f);
      const raw = readFileSync(full, 'utf8');
      return { file: f, path: full, raw, meta: parseSpecMetadata(raw), mtime: statSync(full).mtimeMs };
    })
    .filter(s => {
      if (!s.meta.repo_path) {
        log('warn', `Skipping '${s.file}' — missing required 'repo' frontmatter field`);
        return false;
      }
      return true;
    })
    .sort((a, b) => priorityRank(a.meta.priority) - priorityRank(b.meta.priority) || a.mtime - b.mtime);

  if (specs.length === 0) {
    log('info', 'Queue is empty. Nothing to dispatch.');
    return;
  }
  log('info', `Found ${specs.length} pending spec(s): ${specs.map(s => s.file).join(', ')}`);

  // Rate limit gate
  const state = loadState();
  const today = todayKey();
  let dispatchedToday = state.dispatch.daily[today] || 0;
  if (dispatchedToday >= DAILY_LIMIT) {
    log('warn', `Daily limit reached (${dispatchedToday}/${DAILY_LIMIT}). Remaining specs stay queued.`);
    return;
  }

  // Resolve connected Jules sources (skipped entirely in dry-run without a key)
  let sourceMap = new Map();
  if (API_KEY) {
    try {
      sourceMap = await resolveSourceMap();
      log('info', `Resolved ${sourceMap.size} connected Jules source(s)`);
      if (VERBOSE) log('debug', `Sources: ${[...sourceMap.keys()].join(', ')}`);
    } catch (e) {
      log('error', `Failed to list Jules sources: ${e.message}`);
      process.exit(1);
    }
  } else {
    log('info', 'No API key — dry-run validation only (source resolution skipped).');
  }

  let dispatched = 0;
  for (const spec of specs) {
    if (dispatched >= RUN_LIMIT) {
      log('info', `Run limit reached (--limit ${RUN_LIMIT}). Stopping.`);
      break;
    }
    if (dispatchedToday >= DAILY_LIMIT) {
      log('warn', `Daily limit hit mid-run (${dispatchedToday}/${DAILY_LIMIT}). Remaining specs stay queued.`);
      break;
    }

    const { repo_path, title, priority, branch } = spec.meta;
    const sourceObj = sourceMap.get(repo_path.toLowerCase());
    if (API_KEY && !sourceObj) {
      log('error', `No Jules source matches repo '${repo_path}' for '${spec.file}' — leaving in queue`);
      continue;
    }

    const source = sourceObj?.name || `(unresolved:${repo_path})`;
    const targetBranch = branch || sourceObj?.defaultBranch || 'main';
    const prompt = stripFrontmatter(spec.raw);
    const sessionTitle = title || basename(spec.file, '.md');

    log('info', `Dispatching '${spec.file}' → ${source} [priority=${priority || 'medium'}, branch=${targetBranch}]`);
    if (VERBOSE) log('debug', `Prompt preview: ${prompt.slice(0, 300)}`);

    if (DRY_RUN) {
      log('info', `[DRY RUN] Would create session '${sessionTitle}' on ${source}`);
      dispatched++;
      continue;
    }

    try {
      // AUTO_CREATE_PR opens a PR for review only. Merging is ALWAYS manual —
      // there is no auto-merge code path in this tool.
      const session = await createSession(source, prompt, {
        title: sessionTitle,
        startingBranch: targetBranch,
        automationMode: 'AUTO_CREATE_PR',
        requirePlanApproval: false
      });

      const sessionId = (session.name || '').replace('sessions/', '') || session.id || 'unknown';
      dispatched++;
      dispatchedToday++;

      state.dispatch.daily[today] = dispatchedToday;
      state.dispatch.history.push({
        spec: spec.file, repo: repo_path, source, sessionId,
        title: sessionTitle, priority: priority || 'medium',
        day: today, dispatchedAt: new Date().toISOString()
      });
      state.sessions[sessionId] = {
        state: 'QUEUED', spec: spec.file, repo: repo_path,
        title: sessionTitle, prPolicy: PR_STATUS_AWAITING,
        dispatchedAt: new Date().toISOString()
      };
      saveState(state);

      renameSync(spec.path, join(PROCESSED_DIR, spec.file));
      log('info', `✅ Session ${sessionId} created for '${spec.file}' → archived to processed/`);

      // Gentle pacing between API writes
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      log('error', `Dispatch failed for '${spec.file}': ${e.message} — leaving in queue`);
    }
  }

  log('info', `Sweep complete. Dispatched: ${dispatched}. Daily total: ${dispatchedToday}/${DAILY_LIMIT}. Remaining in queue: ${specs.length - dispatched}.`);
}

main().catch(e => {
  log('error', `Fatal dispatcher failure: ${e.message}`);
  process.exit(1);
});
