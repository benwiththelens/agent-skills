#!/usr/bin/env node
/**
 * jules_merge_gatekeeper.mjs
 * Automated PR audit, test verification, and merge pipeline for Jules-generated PRs.
 *
 * Phase 1: Security & Compliance Audit
 *   - Fetches open PRs from GitHub for configured repos
 *   - Runs high-speed LLM security audit (Gemini Flash direct API → OpenRouter/Kimi fallback)
 *   - Updates PR status in jules-state.json
 *   - Sends Discord DM with context-rich, actionable briefing for NEEDS_HUMAN_REVIEW
 *
 * Phase 2: Branch Integration & Test Verification
 *   - Fetches PR branch in local repo
 *   - Attempts merge into local main with conflict auto-resolution
 *   - Runs repo-specific build and test suites
 *   - Sends PRs back to Jules for rework on failure
 *
 * Phase 3: Auto-Merge & Deploy
 *   - Squash-merges into main, pushes to GitHub, and tags for instant rollback
 *
 * Usage:
 *   node jules_merge_gatekeeper.mjs [--dry-run] [--repo <name>] [--verbose]
 *   node jules_merge_gatekeeper.mjs --integrate [--repo <name>]
 *
 * Cron: every 15 minutes (fallback to event-driven webhook)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync, execSync } from 'child_process';
import { loadState, saveState, getPendingPrs } from './jules_state_manager.mjs';

// ==========================================
// Configuration
// ==========================================
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const WORKSPACE = process.env.WORKSPACE || process.cwd();
const GITHUB_CREDENTIALS_PATH = process.env.GITHUB_CREDENTIALS_PATH || (HOME ? join(HOME, '.openclaw/credentials/github.json') : '');
const GOOGLE_CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || (HOME ? join(HOME, '.openclaw/credentials/google.json') : '');
const OPENROUTER_CREDENTIALS_PATH = process.env.OPENROUTER_CREDENTIALS_PATH || (HOME ? join(HOME, '.openclaw/credentials/openrouter.json') : '');
const DISCORD_USER_ID = process.env.DISCORD_USER_ID || '';

// Load repo merge policies from environment, external JSON config, or default template
let REPO_POLICIES = {
  'owner/example-repo': {
    policy: 'AUTO_MERGE',
    repoPath: join(WORKSPACE, 'example-repo'),
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    maxAutoMergesPerDay: 20,
    requireTests: true,
    requireAudit: true
  }
};

const POLICIES_FILE = process.env.REPO_POLICIES_CONFIG || join(WORKSPACE, 'repo-policies.json');
if (existsSync(POLICIES_FILE)) {
  try {
    REPO_POLICIES = JSON.parse(readFileSync(POLICIES_FILE, 'utf8'));
  } catch (e) {
    console.warn(`[Gatekeeper] Failed to parse repo policies from ${POLICIES_FILE}: ${e.message}`);
  }
}

// Hard human review triggers (strict blast-radius files)
const HUMAN_REVIEW_TRIGGERS = [
  /\.github\/workflows\//,   // CI/CD pipeline modifications
  /\.env(\.|$)/,             // Environment secrets (.env, .env.local, .env.production)
  /\/auth\//i,               // Core authentication modules
  /credentials/i,            // Credential management
  /wrangler\.toml/           // Cloudflare deployment worker routing
];

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const REPO_IDX = args.indexOf('--repo');
const TARGET_REPO = REPO_IDX !== -1 ? args[REPO_IDX + 1] : null;

// ==========================================
// Logging
// ==========================================
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [Gatekeeper] ${msg}`;
  if (data !== undefined) {
    console.log(line, typeof data === 'string' ? data : JSON.stringify(data));
  } else {
    console.log(line);
  }
}

// ==========================================
// GitHub API Client
// ==========================================
let GITHUB_TOKEN = proces…OKEN || '';
if (!GITHUB_TOKEN) {
  try {
    if (GITHUB_CREDENTIALS_PATH && existsSync(GITHUB_CREDENTIALS_PATH)) {
      const creds = JSON.parse(readFileSync(GITHUB_CREDENTIALS_PATH, 'utf8'));
      GITHUB_TOKEN = *** || creds.token || '';
    }
  } catch (e) {
    log('error', `Failed to load GitHub credentials: ${e.message}`);
  }
}

let GOOGLE_API_KEY = proces…_KEY || '';
if (!GOOGLE_API_KEY) {
  try {
    if (GOOGLE_CREDENTIALS_PATH && existsSync(GOOGLE_CREDENTIALS_PATH)) {
      GOOGLE_API_KEY = JSON.p…ATH, 'utf8')).apiKey || '';
    }
  } catch (e) {
    log('warn', `Failed to load Google credentials: ${e.message}`);
  }
}

let OPENROUTER_API_KEY = proces…_KEY || '';
if (!OPENROUTER_API_KEY) {
  try {
    if (OPENROUTER_CREDENTIALS_PATH && existsSync(OPENROUTER_CREDENTIALS_PATH)) {
      OPENROUTER_API_KEY = JSON.p…ATH, 'utf8')).apiKey || '';
    }
  } catch (e) {
    log('warn', `Failed to load OpenRouter credentials: ${e.message}`);
  }
}

async function githubFetch(path, options = {}) {
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required for GitHub API operations');
  }
  const url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Agent-Merge-Gatekeeper',
    ...options.headers
  };

  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`GitHub API Error [HTTP ${response.status}]: ${errorText || response.statusText}`);
  }
  return await response.json();
}

/**
 * Get open PRs for a repo
 */
async function getOpenPrs(repo) {
  const [owner, repoName] = repo.split('/');
  return await githubFetch(`/repos/${owner}/${repoName}/pulls?state=open&per_page=50`);
}

/**
 * Get PR diff (prefers local git diff when repoPath exists, falls back to GitHub API)
 */
async function getPrDiff(repo, prNumber, prBranch, repoPath) {
  if (repoPath && existsSync(repoPath) && prBranch) {
    try {
      execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });
      const localDiff = execSync(`git diff origin/main...origin/${prBranch}`, {
        cwd: repoPath,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
      });
      if (localDiff && localDiff.trim().length > 0) {
        return localDiff;
      }
    } catch (e) {
      log('warn', `Local git diff failed for PR #${prNumber} in ${repo}: ${e.message}. Falling back to GitHub API.`);
    }
  }

  const [owner, repoName] = repo.split('/');
  const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3.diff',
      'User-Agent': 'Agent-Merge-Gatekeeper'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch PR diff from GitHub: ${response.status}`);
  return await response.text();
}

/**
 * Extract files changed directly from unified diff
 */
function extractFilesFromDiff(diff) {
  const files = [];
  const seen = new Set();
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m && !seen.has(m[2])) {
      seen.add(m[2]);
      files.push({ filename: m[2], status: 'modified' });
    }
  }
  return files;
}

// ==========================================
// Discord DM
// ==========================================
async function sendDiscordDM(text) {
  if (!DISCORD_USER_ID) {
    log('info', 'No DISCORD_USER_ID configured; skipping DM alert');
    return false;
  }
  try {
    execFileSync('openclaw', [
      'message',
      'send',
      '--target',
      `user:${DISCORD_USER_ID}`,
      '--message',
      text
    ]);
    log('info', 'Sent Discord DM alert');
    return true;
  } catch (error) {
    log('error', `DM failed: ${error.message}`);
    return false;
  }
}

// ==========================================
// LLM Direct Audit
// ==========================================

/**
 * Check if PR diff contains human review triggers
 */
function checkHumanReviewTriggers(files) {
  const triggered = [];
  for (const file of files) {
    const filename = file.filename || file;
    for (const pattern of HUMAN_REVIEW_TRIGGERS) {
      if (pattern.test(filename)) {
        triggered.push({ file: filename, pattern: pattern.toString() });
        break;
      }
    }
  }
  return triggered;
}

/**
 * Construct an actionable, context-rich escalation briefing
 */
function generateEscalationBriefing({ repoName, prNumber, prTitle, prUrl, reason, triggers, files, auditResult }) {
  let explanation = reason;
  if (triggers && triggers.length > 0) {
    explanation = `Sensitive infrastructure/security files modified:\n` + triggers.map(t => `• \`${t.file}\` (rule: \`${t.pattern}\`)`).join('\n');
  }

  const changedFileList = files.slice(0, 8).map(f => `• \`${f.filename || f}\``).join('\n') + (files.length > 8 ? `\n• ... and ${files.length - 8} more files` : '');

  return `🚨 **Jules PR Escalation — Action Required**
> **Repo:** \`${repoName}\`
> **PR:** #${prNumber} — ${prTitle}
> **Verdict:** \`${auditResult?.verdict || 'NEEDS_HUMAN_REVIEW'}\`
> **Link:** ${prUrl}

📋 **Why This Needs Human Review:**
${explanation}

📁 **Files Changed:**
${changedFileList}

💡 **Actionable Next Steps:**
1. **Approve & Merge:** If intentional, merge directly on GitHub: ${prUrl}
2. **Request Revision:** Dispatch feedback to the Jules session.
3. **Reject/Close:** If this approach is flawed, close the PR on GitHub.`;
}

/**
 * Run direct high-speed LLM security audit
 */
async function callLlmAudit(prompt) {
  // 1. Primary: Direct Google Gemini 2.5 Flash API
  if (GOOGLE_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=***}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text, model: 'gemini-2.5-flash' };
      }
    } catch (e) {
      log('warn', `Direct Gemini call failed: ${e.message}`);
    }
  }

  // 2. Fallback: OpenRouter (Moonshot / Claude)
  if (OPENROUTER_API_KEY) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return { text, model: 'openrouter/gemini-2.5-flash' };
      }
    } catch (e) {
      log('warn', `OpenRouter fallback failed: ${e.message}`);
    }
  }

  throw new Error('All direct LLM providers failed');
}

/**
 * Run security audit on PR diff using direct high-speed LLM API
 */
async function runAudit(pr, diff, files) {
  const repo = pr.repo;
  const prNumber = pr.number;
  const title = pr.title;

  // Check for hard human review triggers first
  const triggers = checkHumanReviewTriggers(files);
  if (triggers.length > 0) {
    log('info', `PR #${prNumber} has human review triggers: ${triggers.map(t => t.file).join(', ')}`);
    return {
      verdict: 'NEEDS_HUMAN_REVIEW',
      reason: `Changes to critical files: ${triggers.map(t => t.file).join(', ')}`,
      triggers
    };
  }

  // Build audit prompt
  const prompt = `You are a strict security and code quality gatekeeper reviewing a pull request for the ${repo} repository.

## PR Title
${title}

## Files Changed
${files.map(f => `- ${f.filename || f} (${f.status || 'modified'})`).join('\n')}

## PR Diff
\`\`\`diff
${diff.slice(0, 10000)} ${diff.length > 10000 ? '\n... (truncated)' : ''}
\`\`\`

## Audit Checklist
1. **Security:** Any XSS, SQL injection, auth bypass, secret leaks, or arbitrary execution vulnerabilities?
2. **Architecture & Dependencies:** Are any unexpected external dependencies introduced that bloat or conflict with existing stack?
3. **Logic:** Are there obvious infinite loops, broken math calculations, or fatal runtime exceptions?
4. **Code Cleanliness:** Is it real functional code without placeholder hallucinations?

## Response Format
Return EXACTLY ONE of the following as the FIRST line:
APPROVED: <1-sentence clear reason why it is safe to merge>
REJECTED: <specific bug, vulnerability, or issue found>
NEEDS_HUMAN_REVIEW: <concrete reason human inspection is required>

Keep total output concise and under 100 words.`;

  try {
    const { text, model } = await callLlmAudit(prompt);
    const rawOutput = text.trim();
    const lines = rawOutput.split('\n').map(l => l.trim()).filter(Boolean);
    
    const verdictLine = lines.find(l => /^(\*{0,2})(APPROVED|REJECTED|NEEDS_HUMAN_REVIEW)/i.test(l));

    if (verdictLine) {
      const match = verdictLine.match(/^(\*{0,2})(APPROVED|REJECTED|NEEDS_HUMAN_REVIEW)[:*]?\s*(.*)/i);
      const verdict = match[2].toUpperCase();
      const reason = match[3] || rawOutput;
      log('info', `Audit verdict from ${model}: ${verdict} — ${reason.slice(0, 100)}`);
      return { verdict, reason: `${verdict}: ${reason}`, model };
    }

    log('warn', `Could not parse structured verdict from ${model}, treating as NEEDS_HUMAN_REVIEW: ${rawOutput.slice(0, 150)}`);
    return { verdict: 'NEEDS_HUMAN_REVIEW', reason: rawOutput, model };
  } catch (e) {
    log('error', `Audit failed for PR #${prNumber}: ${e.message}`);
    return {
      verdict: 'NEEDS_HUMAN_REVIEW',
      reason: `Audit system error: ${e.message}. Manual review required.`,
      error: e.message
    };
  }
}

// ==========================================
// Phase 2: Branch Integration & Test Verification
// ==========================================

/**
 * Send PR back to Jules for rework
 */
async function sendBackToJules(sessionId, prUrl, feedback, state) {
  const { sendMessage } = await import('./jules_client.mjs');
  
  const message = `🔧 **PR Rework Requested**

The automated gatekeeper reviewed your PR and found issues that need to be addressed:

${feedback}

Please fix these issues and update the PR branch. Do not open a new PR.`;

  try {
    await sendMessage(sessionId, message);
    log('info', `Sent rework request to Jules session ${sessionId}`);

    // Update PR status in state
    if (state.prs[prUrl]) {
      state.prs[prUrl].status = 'REWORK_REQUESTED';
      state.prs[prUrl].reworkFeedback = feedback;
      state.prs[prUrl].reworkedAt = new Date().toISOString();
      saveState(state);
    }
  } catch (e) {
    log('error', `Failed to send rework message to Jules session ${sessionId}: ${e.message}`);
  }
}

/**
 * Clean up local branch after merge
 */
function cleanupLocalBranch(repoPath, branchName) {
  try {
    execSync(`git branch -D ${branchName}`, { cwd: repoPath, stdio: 'pipe' });
    log('info', `Deleted local branch ${branchName}`);
  } catch (e) {
    // Branch may not exist locally, ignore
  }
}

/**
 * Process approved PRs: fetch, merge, test, and push
 */
async function processApprovedPrs(repoName, policy, state) {
  const repoPath = policy.repoPath;
  if (!repoPath || !existsSync(repoPath)) {
    log('warn', `Local repo path not found for ${repoName}: ${repoPath}. Skipping integration.`);
    return { integrated: 0, failed: 0 };
  }

  // Find approved PRs in state for this repo
  const approvedPrs = Object.values(state.prs || {}).filter(
    p => p.repo === repoName && p.status === 'KIMI_AUDIT_APPROVED'
  );

  if (approvedPrs.length === 0) {
    log('info', `No approved PRs to integrate for ${repoName}`);
    return { integrated: 0, failed: 0 };
  }

  let integrated = 0;
  let failed = 0;

  for (const pr of approvedPrs) {
    const prNumber = pr.url.split('/').pop();
    const prBranch = pr.branch;

    log('info', `Integrating PR #${prNumber} (${prBranch}) into ${repoName}...`);

    try {
      // 1. Fetch latest main and PR branch
      execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });
      execSync('git checkout main', { cwd: repoPath, stdio: 'pipe' });
      execSync('git pull origin main', { cwd: repoPath, stdio: 'pipe' });

      // 2. Attempt merge
      try {
        execSync(`git merge origin/${prBranch} --no-edit`, {
          cwd: repoPath,
          stdio: 'pipe'
        });
        log('info', `Merged origin/${prBranch} into main cleanly`);
      } catch (mergeErr) {
        log('warn', `Merge conflict detected for PR #${prNumber}: ${mergeErr.message}`);

        // Try lockfile conflict resolution
        const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' });
        const hasLockfileConflict = status.includes('package-lock.json') || status.includes('yarn.lock') || status.includes('pnpm-lock.yaml');

        if (hasLockfileConflict) {
          log('info', 'Attempting lockfile conflict auto-resolution...');
          try {
            execSync('git checkout --theirs package-lock.json', { cwd: repoPath, stdio: 'pipe' });
            execSync('npm install --package-lock-only', { cwd: repoPath, stdio: 'pipe' });
            execSync('git add package-lock.json', { cwd: repoPath, stdio: 'pipe' });
            execSync('git commit --no-edit', { cwd: repoPath, stdio: 'pipe' });
            log('info', 'Lockfile conflict resolved successfully');
          } catch (lockErr) {
            log('error', `Lockfile resolution failed: ${lockErr.message}`);
            execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' });
            throw new Error(`Merge conflict in lockfile could not be resolved automatically`);
          }
        } else {
          execSync('git merge --abort', { cwd: repoPath, stdio: 'pipe' });
          throw new Error(`Merge conflict requires manual resolution`);
        }
      }

      // 3. Run build command (if configured)
      if (policy.buildCommand) {
        log('info', `Running build: ${policy.buildCommand}`);
        try {
          execSync(policy.buildCommand, {
            cwd: repoPath,
            stdio: 'pipe',
            timeout: 300000 // 5-minute timeout
          });
          log('info', 'Build passed successfully');
        } catch (buildErr) {
          log('error', `Build failed: ${buildErr.message}`);
          execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'pipe' });

          // Send back to Jules for rework
          if (pr.sessionId) {
            await sendBackToJules(
              pr.sessionId,
              pr.url,
              `The build failed after merging your branch:\n\`\`\`\n${buildErr.stdout || buildErr.message}\n\`\`\``,
              state
            );
          }
          failed++;
          continue;
        }
      }

      // 4. Run test command (if configured)
      if (policy.requireTests && policy.testCommand) {
        log('info', `Running tests: ${policy.testCommand}`);
        try {
          execSync(policy.testCommand, {
            cwd: repoPath,
            stdio: 'pipe',
            timeout: 300000 // 5-minute timeout
          });
          log('info', 'All tests passed successfully');
        } catch (testErr) {
          log('error', `Tests failed: ${testErr.message}`);
          execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'pipe' });

          // Send back to Jules for rework
          if (pr.sessionId) {
            await sendBackToJules(
              pr.sessionId,
              pr.url,
              `Tests failed after merging your branch:\n\`\`\`\n${testErr.stdout || testErr.message}\n\`\`\``,
              state
            );
          }
          failed++;
          continue;
        }
      }

      // 5. Phase 3: Push to GitHub and tag for rollback
      if (!DRY_RUN) {
        log('info', 'Pushing clean main to origin...');
        execSync('git push origin main', { cwd: repoPath, stdio: 'pipe' });

        // Tag commit for rollback
        const tag = `jules-merge-pr-${prNumber}-${Date.now()}`;
        execSync(`git tag ${tag}`, { cwd: repoPath, stdio: 'pipe' });
        execSync(`git push origin ${tag}`, { cwd: repoPath, stdio: 'pipe' });
        log('info', `Created rollback tag: ${tag}`);

        // Clean up remote branch on GitHub
        try {
          const [owner, repo] = repoName.split('/');
          await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/${prBranch}`, {
            method: 'DELETE'
          });
          log('info', `Deleted remote branch ${prBranch}`);
        } catch (delErr) {
          log('warn', `Failed to delete remote branch ${prBranch}: ${delErr.message}`);
        }

        // Clean up local branch
        cleanupLocalBranch(repoPath, prBranch);

        // Update state
        pr.status = 'MERGED';
        pr.mergedAt = new Date().toISOString();
        pr.rollbackTag = tag;
        saveState(state);

        log('info', `✅ PR #${prNumber} successfully merged and pushed!`);
        integrated++;
      } else {
        log('info', `[DRY-RUN] Would push main and tag for PR #${prNumber}`);
        execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'pipe' });
        integrated++;
      }
    } catch (e) {
      log('error', `Failed to integrate PR #${prNumber}: ${e.message}`);
      try {
        execSync('git reset --hard origin/main', { cwd: repoPath, stdio: 'pipe' });
      } catch {}
      failed++;
    }
  }

  return { integrated, failed };
}

// ==========================================
// Phase 1: Audit Pipeline
// ==========================================

async function processRepo(repoName, policy, state) {
  log('info', `Scanning PRs for ${repoName} (policy: ${policy.policy})...`);

  let openPrs = [];
  try {
    openPrs = await getOpenPrs(repoName);
  } catch (e) {
    log('error', `Failed to fetch PRs for ${repoName}: ${e.message}`);
    return { processed: 0, approved: 0, rejected: 0, needsHuman: 0 };
  }

  log('info', `Found ${openPrs.length} open PR(s) in ${repoName}`);

  // Filter to PRs that need auditing
  const prsToAudit = openPrs.filter(pr => {
    const prState = state.prs[pr.html_url];
    // Audit if new or in KIMI_K3_AUDIT_REQUIRED state
    return !prState || prState.status === 'KIMI_K3_AUDIT_REQUIRED';
  });

  if (prsToAudit.length === 0) {
    log('info', `No new PRs requiring audit in ${repoName}`);
    return { processed: 0, approved: 0, rejected: 0, needsHuman: 0 };
  }

  let approved = 0;
  let rejected = 0;
  let needsHuman = 0;

  for (const pr of prsToAudit) {
    const prNumber = pr.number;
    const prTitle = pr.title;
    const prUrl = pr.html_url;
    const prBranch = pr.head.ref;

    log('info', `Auditing PR #${prNumber}: "${prTitle}" (${prBranch})...`);

    try {
      // 1. Fetch diff
      const diff = await getPrDiff(repoName, prNumber, prBranch, policy.repoPath);
      const files = extractFilesFromDiff(diff);

      log('info', `PR #${prNumber} has ${files.length} changed file(s), diff size: ${diff.length} chars`);

      // 2. Run LLM audit
      const auditResult = await runAudit(
        { repo: repoName, number: prNumber, title: prTitle },
        diff,
        files
      );

      // 3. Update state
      if (!state.prs[prUrl]) {
        state.prs[prUrl] = {
          url: prUrl,
          title: prTitle,
          branch: prBranch,
          repo: repoName,
          recordedAt: new Date().toISOString()
        };
      }

      state.prs[prUrl].auditResult = auditResult;
      state.prs[prUrl].auditedAt = new Date().toISOString();

      if (auditResult.verdict === 'APPROVED') {
        state.prs[prUrl].status = 'KIMI_AUDIT_APPROVED';
        approved++;
        log('info', `✅ PR #${prNumber} APPROVED: ${auditResult.reason}`);
      } else if (auditResult.verdict === 'REJECTED') {
        state.prs[prUrl].status = 'KIMI_AUDIT_REJECTED';
        rejected++;
        log('warn', `❌ PR #${prNumber} REJECTED: ${auditResult.reason}`);

        // Send back to Jules if sessionId is known
        const sessionId = state.prs[prUrl].sessionId;
        if (sessionId) {
          await sendBackToJules(sessionId, prUrl, auditResult.reason, state);
        }
      } else {
        // NEEDS_HUMAN_REVIEW
        state.prs[prUrl].status = 'NEEDS_HUMAN_REVIEW';
        needsHuman++;
        log('warn', `🚨 PR #${prNumber} NEEDS_HUMAN_REVIEW: ${auditResult.reason}`);

        // Generate and send actionable context-rich escalation briefing
        const escalationBriefing = generateEscalationBriefing({
          repoName,
          prNumber,
          prTitle,
          prUrl,
          reason: auditResult.reason,
          triggers: auditResult.triggers || [],
          files,
          auditResult
        });

        await sendDiscordDM(escalationBriefing);
      }

      // Rate limiting: 1-second delay between PR audits
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      log('error', `Failed to audit PR #${prNumber}: ${e.message}`);
      needsHuman++;
    }
  }

  return { processed: prsToAudit.length, approved, rejected, needsHuman };
}

async function main() {
  log('info', `Starting merge gatekeeper${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Load state
  const state = loadState();

  // Add repoPolicies to state if not present
  if (!state.repoPolicies) {
    state.repoPolicies = {};
    for (const [repo, policy] of Object.entries(REPO_POLICIES)) {
      state.repoPolicies[repo] = {
        policy: policy.policy,
        maxAutoMergesPerDay: policy.maxAutoMergesPerDay,
        requireTests: policy.requireTests,
        requireAudit: policy.requireAudit,
        note: policy.note
      };
    }
    saveState(state);
    log('info', 'Initialized repoPolicies in state');
  }

  // Process each repo
  const results = {};
  for (const [repoName, policy] of Object.entries(REPO_POLICIES)) {
    if (policy.policy === 'HUMAN_REVIEW') {
      log('info', `Skipping ${repoName} (HUMAN_REVIEW policy)`);
      continue;
    }

    // Phase 1: Audit
    const result = await processRepo(repoName, policy, state);
    results[repoName] = result;

    // Phase 2 & 3: Integration, Testing & Merge (only for repos with local paths)
    if (policy.repoPath && existsSync(policy.repoPath)) {
      const integrationResult = await processApprovedPrs(repoName, policy, state);
      results[repoName] = { ...result, ...integrationResult };
    }

    // Save state after each repo
    saveState(state);
  }

  log('info', 'Merge gatekeeper run complete', results);
}

main().catch(err => {
  log('error', `Gatekeeper crashed: ${err.message}`, err.stack);
  process.exit(1);
});
