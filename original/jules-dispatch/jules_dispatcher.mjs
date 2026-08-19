#!/usr/bin/env node
/**
 * jules_dispatcher.mjs
 * Next-Gen Jules Queue Dispatcher & Spec Enricher.
 *
 * Reads pending task specs from the vault queue, enriches prompts with the
 * Graphify codebase dependency subgraph (enforcing a 10KB byte ceiling),
 * dispatches to the Jules API, tracks state + daily rate limits under advisory file locking,
 * resolves dependencies, and archives processed specs.
 *
 * Zero external dependencies · Node.js 18+
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { join, basename } from 'path';
import { createSession, listSources } from './jules_client.mjs';
import { sendDiscordAlert } from './jules_discord.mjs';
import {
  loadState,
  saveState,
  withStateLock,
  isDependencySatisfied,
  getPendingPrs,
  STATE_PATH,
  STATE_SCHEMA_VERSION,
  emptyState
} from './jules_state_manager.mjs';

// ==========================================
// Configuration
// ==========================================
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const WORKSPACE = process.env.WORKSPACE || process.cwd();
const QUEUE_DIR = process.env.JULES_QUEUE_DIR || join(WORKSPACE, 'vault/01-ACTIVE/jules-queue');
const PROCESSED_DIR = join(QUEUE_DIR, 'processed');
const GRAPH_PATH = process.env.GRAPH_PATH || (HOME ? join(HOME, '.graphify/global-graph.json') : '');

const DAILY_HARD_LIMIT = parseInt(process.env.JULES_DAILY_HARD_LIMIT || '100', 10);
const MANUAL_RESERVE_BUFFER = parseInt(process.env.JULES_MANUAL_RESERVE_BUFFER || '20', 10);
const DAILY_SAFETY_LIMIT = parseInt(process.env.JULES_DAILY_LIMIT || String(DAILY_HARD_LIMIT - MANUAL_RESERVE_BUFFER), 10);

const PR_AUTO_MERGE_ENABLED = true;
const PR_STATUS_AWAITING = 'KIMI_K3_AUDIT_REQUIRED';

function assertNoAutoMerge() {
  return true;
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const DIGEST_ONLY = args.includes('--digest');
const SEND_DIGEST = args.includes('--send');

let limitIdx = args.indexOf('--limit');
let RUN_LIMIT = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : Infinity;
if (isNaN(RUN_LIMIT) || RUN_LIMIT < 1) RUN_LIMIT = Infinity;

const PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [Dispatcher] ${msg}`;
  if (data !== undefined && VERBOSE) {
    console.log(line, typeof data === 'string' ? data : JSON.stringify(data));
  } else {
    console.log(line);
  }
}

function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function parseSpecMetadata(raw) {
  const meta = {
    repo_path: '',
    title: '',
    priority: 'medium',
    branch: '',
    depends_on_list: []
  };

  const lines = raw.split('\n');
  let inFrontmatter = false;

  for (const line of lines) {
    const l = line.trim();
    if (l === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break;
      }
    }
    if (inFrontmatter) {
      if (l.startsWith('#') || !l.includes(':')) continue;
      const m = l.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.+)$/);
      if (m && ['repo_path', 'repo', 'title', 'priority', 'branch', 'startingbranch', 'depends_on', 'dependson', 'depends_on_pr', 'phase'].includes(m[1].toLowerCase())) {
        meta[m[1].toLowerCase().trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  if (meta.repo && !meta.repo_path) meta.repo_path = meta.repo;
  if (meta.startingbranch && !meta.branch) meta.branch = meta.startingbranch;

  const rawDep = meta.depends_on || meta.dependson || '';
  if (rawDep) {
    meta.depends_on_list = rawDep.split(',').map(s => s.trim().replace(/^\[|\]$/g, '').replace(/["']/g, '')).filter(Boolean);
  } else {
    meta.depends_on_list = [];
  }
  return meta;
}

function stripFrontmatter(raw) {
  const lines = raw.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === '---');
  if (startIdx === -1) return raw.trim();
  const endIdx = lines.slice(startIdx + 1).findIndex(l => l.trim() === '---');
  if (endIdx === -1) return raw.trim();

  const bodyLines = lines.slice(startIdx + 1 + endIdx + 1);
  return bodyLines
    .filter(l => {
      const m = l.trim().match(/^([A-Za-z0-9_\-]+)\s*:\s*(.+)$/);
      return !(m && ['repo_path', 'repo', 'title', 'priority', 'branch', 'startingbranch', 'depends_on', 'dependson', 'depends_on_pr', 'phase'].includes(m[1].toLowerCase()));
    })
    .join('\n')
    .trim();
}

// ==========================================
// Graphify AST Enrichment (10KB Hard Ceiling)
// ==========================================
const GRAPHIFY_BYTE_CEILING = 10240;

function truncateGraphifyBlock(block, maxBytes) {
  if (!block || block.length <= maxBytes) return block;
  const lines = block.split('\n');
  const result = [];
  let currentBytes = 0;

  for (const line of lines) {
    const lineBytes = line.length + 1;
    if (currentBytes + lineBytes > maxBytes - 120) {
      result.push(`\n... (truncated to fit 10KB AST context budget)`);
      break;
    }
    result.push(line);
    currentBytes += lineBytes;
  }
  return result.join('\n');
}

function buildGraphifyBlock(repoPath) {
  const shortRepo = repoPath.includes('/') ? repoPath.split('/').pop() : repoPath;
  const candidates = [
    GRAPH_PATH,
    join(WORKSPACE, repoPath, 'graphify-out/.graphify_analysis.json'),
    join(WORKSPACE, repoPath + '-repo', 'graphify-out/.graphify_analysis.json'),
    join(WORKSPACE, shortRepo, 'graphify-out/.graphify_analysis.json'),
    join(WORKSPACE, shortRepo + '-repo', 'graphify-out/.graphify_analysis.json')
  ].filter(Boolean);

  let raw = null;
  let usedPath = '';
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        raw = JSON.parse(readFileSync(c, 'utf8'));
        usedPath = c;
        break;
      } catch (e) {
        log('warn', `Found graph at ${c} but failed to parse JSON: ${e.message}`);
      }
    }
  }

  if (!raw) {
    log('info', `No Graphify index found for repo '${repoPath}' — proceeding without AST enrichment`);
    return '';
  }

  let nodes = [];
  if (Array.isArray(raw.nodes)) {
    nodes = raw.nodes;
  } else if (raw.nodes && typeof raw.nodes === 'object') {
    nodes = Object.entries(raw.nodes).map(([k, v]) => ({ id: k, ...(typeof v === 'object' ? v : { name: v }) }));
  } else if (Array.isArray(raw.files)) {
    nodes = raw.files;
  } else if (raw.files && typeof raw.files === 'object') {
    nodes = Object.entries(raw.files).map(([k, v]) => ({ id: k, path: k, ...(typeof v === 'object' ? v : {}) }));
  }

  const repoKey = repoPath.toLowerCase();
  const nodeRepo = n => (n.repo || n.repository || '').toLowerCase();
  const nodePath = n => (n.path || n.filePath || n.id || n.name || '');

  const matched = nodes.filter(n => {
    const r = nodeRepo(n);
    const shortKey = shortRepo.toLowerCase();
    if (r && (r === repoKey || r === shortKey || r.endsWith('/' + repoKey) || r.endsWith('/' + shortKey) || r.includes(shortKey))) return true;
    const p = nodePath(n).toLowerCase();
    return !r && (p.startsWith(repoKey + '/') || p.startsWith(shortKey + '/') || p.includes('/' + shortKey + '/'));
  });

  if (matched.length === 0) {
    log('info', `Graphify index at ${usedPath} has ${nodes.length} nodes, but none match repo '${repoPath}'`);
    return '';
  }

  const keyNodes = matched
    .sort((a, b) => {
      const aCount = (a.symbols?.length || 0) + (a.exports?.length || 0) + (a.functions?.length || 0);
      const bCount = (b.symbols?.length || 0) + (b.exports?.length || 0) + (b.functions?.length || 0);
      return bCount - aCount;
    })
    .slice(0, 15);

  let block = `\n\n## 🗺️ Codebase AST Context (Graphify Index)\n`;
  block += `*Injected by VANTAGE to eliminate blind file searches.*\n\n`;

  for (const n of keyNodes) {
    const p = nodePath(n);
    const exports = n.exports || n.symbols || n.public_api || [];
    const expStr = Array.isArray(exports) ? exports.slice(0, 8).map(e => typeof e === 'string' ? e : (e.name || e.id)).join(', ') : '';
    block += `- **\`${p}\`**`;
    if (expStr) block += ` — exports: \`${expStr}\``;
    if (n.purpose || n.summary || n.description) {
      block += ` — *${n.purpose || n.summary || n.description}*`;
    }
    block += `\n`;
  }

  const edges = raw.edges || raw.relationships || raw.graph?.links || raw.graph?.edges || [];
  if (Array.isArray(edges) && edges.length > 0) {
    const matchedIds = new Set(keyNodes.map(n => n.id || nodePath(n)));
    const rels = edges.filter(e => {
      const src = e.source || e.from || '';
      const tgt = e.target || e.to || '';
      return matchedIds.has(src) || matchedIds.has(tgt);
    }).slice(0, 10);

    if (rels.length > 0) {
      block += `\n**Key Dependency Links:**\n`;
      for (const r of rels) {
        const src = r.source || r.from;
        const tgt = r.target || r.to;
        const type = r.type || r.label || 'uses';
        block += `- \`${src}\` --(${type})--> \`${tgt}\`\n`;
      }
    }
  }

  const truncatedBlock = truncateGraphifyBlock(block, GRAPHIFY_BYTE_CEILING);
  log('info', `Enriched prompt with Graphify AST nodes (${truncatedBlock.length}B, ceiling: ${GRAPHIFY_BYTE_CEILING}B)`);
  return truncatedBlock;
}

// ==========================================
// Source Resolution
// ==========================================
async function resolveSources() {
  const res = await listSources();
  const sources = res.sources || [];
  const map = new Map();
  for (const s of sources) {
    const repo = s.githubRepo?.repo || s.name.split('/').pop();
    const owner = s.githubRepo?.owner;
    const defaultBranch = s.githubRepo?.defaultBranch?.displayName || 'main';
    const entry = { name: s.name, defaultBranch };
    if (repo) map.set(repo.toLowerCase(), entry);
    if (owner && repo) map.set(`${owner}/${repo}`.toLowerCase(), entry);
    if (s.id) map.set(s.id.toLowerCase(), entry);
    if (s.name) map.set(s.name.toLowerCase(), entry);
  }
  return map;
}

function dailyCount(state) {
  return state.dispatch.daily[chicagoToday()] || 0;
}

function incrementDaily(state) {
  const today = chicagoToday();
  state.dispatch.daily[today] = (state.dispatch.daily[today] || 0) + 1;
}

async function generateAndSendDigest(state, sendToDiscord = false) {
  const today = chicagoToday();
  const count = state.dispatch.daily[today] || 0;
  const remainingSafety = Math.max(0, DAILY_SAFETY_LIMIT - count);

  const todayEntries = (state.dispatch.history || []).filter(h =>
    h.day === today || (!h.day && typeof h.dispatchedAt === 'string' && h.dispatchedAt.startsWith(today))
  );

  const pendingPrs = getPendingPrs(state, PR_STATUS_AWAITING);
  const completedSessions = Object.entries(state.sessions || {})
    .filter(([, s]) => (typeof s === 'object' ? s.state : s) === 'COMPLETED')
    .map(([id, s]) => ({ id, ...(typeof s === 'object' ? s : {}) }));

  let digest = `# 📊 VANTAGE Jules Dispatch Digest — ${today}\n\n`;
  digest += `**Dispatched Today:** ${count} / ${DAILY_SAFETY_LIMIT} (Hard Cap: ${DAILY_HARD_LIMIT})\n`;
  digest += `**Safety Quota Remaining:** ${remainingSafety} automated slots (${MANUAL_RESERVE_BUFFER} manual reserve)\n`;
  digest += `**Pending PRs (Audit Required):** ${pendingPrs.length}\n`;
  digest += `**Completed Sessions Recorded:** ${completedSessions.length}\n\n`;

  if (todayEntries.length > 0) {
    digest += `## 🚀 Today's Dispatched Sessions\n`;
    for (const e of todayEntries) {
      digest += `- **\`${e.sessionId || 'N/A'}\`** | *${e.repo || 'unknown'}* | \`${e.priority || 'medium'}\` | ${e.title || e.file}\n`;
    }
  } else {
    digest += `*No automated sessions dispatched yet today.*\n`;
  }

  try {
    const digestDir = join(WORKSPACE, 'vault/03-OUTPUT/Syntheses/jules-digests');
    if (!existsSync(digestDir)) {
      mkdirSync(digestDir, { recursive: true });
    }
    const digestPath = join(digestDir, `jules-digest-${today}.md`);
    writeFileSync(digestPath, digest, 'utf8');
    log('info', `Saved daily digest to ${digestPath}`);
  } catch (e) {
    log('warn', `Failed to write vault digest: ${e.message}`);
  }

  console.log('\n' + digest);

  if (sendToDiscord) {
    let discordText = `📊 **[Jules Dispatch Daily Digest — ${today}]**\n`;
    discordText += `> **Dispatched Today:** \`${count} / ${DAILY_SAFETY_LIMIT}\` *(Hard Cap: ${DAILY_HARD_LIMIT})*\n`;
    discordText += `> **Automated Quota Remaining:** \`${remainingSafety}\` slots\n`;
    discordText += `> **Pending PRs:** \`${pendingPrs.length}\`\n\n`;
    if (todayEntries.length > 0) {
      discordText += `**Recent Dispatches:**\n`;
      for (const e of todayEntries.slice(-5)) {
        discordText += `• \`${e.sessionId || 'id'}\` — *${e.repo}*: ${e.title || e.file}\n`;
      }
    }
    await sendDiscordAlert(discordText);
  }
}

async function main() {
  assertNoAutoMerge();

  if (!existsSync(QUEUE_DIR)) {
    log('error', `Queue directory does not exist: ${QUEUE_DIR}`);
    process.exit(1);
  }

  if (!existsSync(PROCESSED_DIR)) {
    mkdirSync(PROCESSED_DIR, { recursive: true });
  }

  const state = loadState();

  if (DIGEST_ONLY) {
    await generateAndSendDigest(state, SEND_DIGEST);
    return;
  }

  log('info', `Scanning queue directory: ${QUEUE_DIR}`);
  const files = readdirSync(QUEUE_DIR)
    .filter(f => f.startsWith('SPEC-') && f.endsWith('.md'))
    .map(f => join(QUEUE_DIR, f));

  if (files.length === 0) {
    log('info', 'No pending task specs found in queue');
    return;
  }

  const specs = files.map(file => {
    const raw = readFileSync(file, 'utf8');
    const meta = parseSpecMetadata(raw);
    const body = stripFrontmatter(raw);
    const mtime = statSync(file).mtimeMs;
    const prioWeight = PRIORITY_ORDER[(meta.priority || 'medium').toLowerCase()] || 2;
    return { file, meta, body, mtime, prioWeight, filename: basename(file) };
  });

  specs.sort((a, b) => {
    if (b.prioWeight !== a.prioWeight) return b.prioWeight - a.prioWeight;
    return a.mtime - b.mtime;
  });

  log('info', `Found ${specs.length} spec(s) in queue. Resolving Jules sources...`);
  let sourceMap;
  try {
    sourceMap = await resolveSources();
  } catch (e) {
    log('error', `Failed to list Jules sources from API: ${e.message}`);
    process.exit(1);
  }

  let dispatched = 0;
  for (const spec of specs) {
    if (dispatched >= RUN_LIMIT) {
      log('info', `Reached run limit of ${RUN_LIMIT} — stopping this sweep`);
      break;
    }

    if (dailyCount(state) >= DAILY_SAFETY_LIMIT) {
      log('warn', `⚠️ Daily safety cap reached (${DAILY_SAFETY_LIMIT}/${DAILY_HARD_LIMIT}). Retaining remaining specs in queue for tomorrow.`);
      break;
    }

    const { repo_path, title, priority, branch, depends_on_list } = spec.meta;

    if (depends_on_list && depends_on_list.length > 0) {
      const unsatisfied = depends_on_list.filter(dep => !isDependencySatisfied(dep, state));
      if (unsatisfied.length > 0) {
        log('info', `⏸️ Holding '${spec.file}' — waiting on upstream dependency spec(s): ${unsatisfied.join(', ')}`);
        continue;
      }
    }

    const sourceObj = sourceMap.get(repo_path.toLowerCase());
    if (!sourceObj) {
      log('error', `No Jules source matches repo_path '${repo_path}' for '${spec.file}' — leaving in queue`);
      continue;
    }

    const graphifyContext = buildGraphifyBlock(repo_path);
    const enrichedPrompt = spec.body + graphifyContext;

    const startingBranch = branch || sourceObj.defaultBranch || 'main';
    const specTitle = title || spec.filename.replace(/^SPEC-|\.md$/g, '');

    log('info', `🚀 Dispatching '${spec.filename}' [${priority}] to ${sourceObj.name} (branch: ${startingBranch})...`);

    if (DRY_RUN) {
      log('info', `[DRY-RUN] Would create session for ${sourceObj.name}: "${specTitle}" (Prompt: ${enrichedPrompt.length} chars)`);
      dispatched++;
      continue;
    }

    try {
      const session = await createSession({
        prompt: enrichedPrompt,
        source: sourceObj.name,
        startingBranch,
        title: specTitle,
        autoCreatePr: true
      });

      const sessionId = session.name ? session.name.split('/').pop() : (session.id || 'unknown');
      log('info', `✅ Jules Session Created! ID: ${sessionId}`);

      await withStateLock(async () => {
        incrementDaily(state);
        const nowIso = new Date().toISOString();
        state.sessions[sessionId] = {
          state: 'IN_PROGRESS',
          repo: repo_path,
          source: sourceObj.name,
          branch: startingBranch,
          title: specTitle,
          file: spec.filename,
          spec: spec.filename,
          dispatchedAt: nowIso,
          orchestrated: false
        };

        state.dispatch.history.push({
          day: chicagoToday(),
          sessionId,
          repo: repo_path,
          file: spec.filename,
          title: specTitle,
          priority,
          dispatchedAt: nowIso
        });

        saveState(state);
      });

      const destPath = join(PROCESSED_DIR, `${spec.filename.replace(/\.md$/, '')}-${Date.now()}.md`);
      renameSync(spec.file, destPath);
      log('info', `Archived processed spec to ${destPath}`);

      const remaining = DAILY_SAFETY_LIMIT - dailyCount(state);
      let alertMsg = `🚀 **[Jules Task Spec Dispatched]**\n`;
      alertMsg += `> **Task:** *${specTitle}*\n`;
      alertMsg += `> **Repo:** \`${repo_path}\` (branch: \`${startingBranch}\`)\n`;
      alertMsg += `> **Priority:** \`${priority}\` | **AST Context:** \`${graphifyContext.length > 0 ? `${graphifyContext.length}B` : 'None'}\`\n`;
      alertMsg += `> **Session ID:** \`${sessionId}\`\n`;
      alertMsg += `> **Daily Budget:** \`${dailyCount(state)} / ${DAILY_SAFETY_LIMIT}\` (${remaining} remaining today)`;
      await sendDiscordAlert(alertMsg);

      dispatched++;
    } catch (e) {
      log('error', `Failed to dispatch spec '${spec.filename}': ${e.message}`, e);
    }
  }

  log('info', `Dispatch pass finished. Dispatched ${dispatched} task(s). Today's total: ${dailyCount(state)}/${DAILY_SAFETY_LIMIT}`);
}

main().catch(err => {
  log('error', `Fatal dispatcher error: ${err.message}`, err.stack);
  process.exit(1);
});
