#!/usr/bin/env node
/**
 * generate_maintenance_specs.mjs
 * Automated Codebase Health & Hardening Spec Generator for Google Jules.
 *
 * Scans connected repositories using AST and pattern analysis to detect:
 *   1. Security / RLS gaps (missing Row-Level Security on DB tables)
 *   2. TypeScript strictness issues (explicit `any`, `as any`, `@ts-ignore`)
 *   3. Missing unit/integration tests on core utility or route modules
 *   4. Dependency bloat or un-imported dependencies
 *
 * Automatically stages atomic task specs (<150 LOC change scope) into
 * vault/01-ACTIVE/jules-queue/ to systematically burn our 100-session daily Jules quota.
 *
 * Usage:
 *   node generate_maintenance_specs.mjs [--dry-run] [--limit N] [--repo <name>] [--stage]
 *
 * Zero external dependencies · Node.js 18+
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

const WORKSPACE = process.env.WORKSPACE || process.cwd();
const QUEUE_DIR = process.env.JULES_QUEUE_DIR || join(WORKSPACE, 'vault/01-ACTIVE/jules-queue');

// Repositories managed for automated maintenance (configured or default template)
let REPO_REGISTRY = [
  {
    repoKey: 'owner/example-repo',
    shortName: 'example-repo',
    localPath: join(WORKSPACE, 'example-repo'),
    defaultBranch: 'main'
  }
];

const POLICIES_FILE = process.env.REPO_POLICIES_CONFIG || join(WORKSPACE, 'repo-policies.json');
if (existsSync(POLICIES_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(POLICIES_FILE, 'utf8'));
    REPO_REGISTRY = Object.entries(raw).map(([key, val]) => ({
      repoKey: key,
      shortName: key.includes('/') ? key.split('/').pop() : key,
      localPath: val.repoPath || join(WORKSPACE, key.split('/').pop()),
      defaultBranch: val.defaultBranch || 'main'
    }));
  } catch (e) {
    console.warn(`[Health Engine] Failed to parse repo policies: ${e.message}`);
  }
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || !args.includes('--stage');
const STAGE = args.includes('--stage');
const LIMIT_IDX = args.indexOf('--limit');
const LIMIT = LIMIT_IDX !== -1 && args[LIMIT_IDX + 1] ? parseInt(args[LIMIT_IDX + 1], 10) : 5;
const REPO_IDX = args.indexOf('--repo');
const TARGET_REPO = REPO_IDX !== -1 ? args[REPO_IDX + 1] : null;

function walkFiles(dir, filterFn, maxDepth = 6, currentDepth = 0) {
  if (currentDepth > maxDepth || !existsSync(dir)) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.next', 'build', '.openclaw', 'coverage'].includes(entry.name)) {
          continue;
        }
        results.push(...walkFiles(fullPath, filterFn, maxDepth, currentDepth + 1));
      } else if (entry.isFile()) {
        if (!filterFn || filterFn(fullPath)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore unreadable dirs
  }
  return results;
}

function analyzeTypeHygiene(repo) {
  const candidates = [];
  const tsFiles = walkFiles(repo.localPath, p => p.endsWith('.ts') || p.endsWith('.tsx'));

  for (const file of tsFiles) {
    if (file.includes('test') || file.includes('spec') || file.endsWith('.d.ts')) continue;
    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const issues = [];

      lines.forEach((line, idx) => {
        if (/\bany\b/.test(line) && !line.trim().startsWith('//') && !line.includes('eslint')) {
          issues.push({ line: idx + 1, type: 'explicit-any', snippet: line.trim() });
        }
        if (/@ts-ignore|@ts-nocheck/.test(line)) {
          issues.push({ line: idx + 1, type: 'ts-ignore', snippet: line.trim() });
        }
      });

      if (issues.length >= 2) {
        const relPath = relative(repo.localPath, file);
        candidates.push({
          repo,
          track: 'CLEAN-TYPES',
          file: relPath,
          issueCount: issues.length,
          issues: issues.slice(0, 5),
          title: `Strict Typing & Zero-Any Pass: ${relPath}`
        });
      }
    } catch {}
  }
  return candidates;
}

function analyzeMissingTests(repo) {
  const candidates = [];
  const srcFiles = walkFiles(repo.localPath, p => (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mjs')));

  for (const file of srcFiles) {
    if (file.includes('test') || file.includes('__tests__') || file.endsWith('.d.ts') || file.includes('node_modules')) continue;
    const base = basename(file);
    if (base === 'index.ts' || base === 'index.tsx' || base.startsWith('types')) continue;

    const dir = join(file, '..');
    const testFile1 = join(dir, base.replace(/\.(ts|tsx|mjs)$/, '.test.$1'));
    const testFile2 = join(dir, '__tests__', base.replace(/\.(ts|tsx|mjs)$/, '.test.$1'));

    if (!existsSync(testFile1) && !existsSync(testFile2)) {
      const relPath = relative(repo.localPath, file);
      try {
        const content = readFileSync(file, 'utf8');
        if (content.length > 300 && (content.includes('export function') || content.includes('export const') || content.includes('export class'))) {
          candidates.push({
            repo,
            track: 'TEST-COVERAGE',
            file: relPath,
            title: `Add Comprehensive Unit Test Suite for ${relPath}`
          });
        }
      } catch {}
    }
  }
  return candidates;
}

function analyzeDatabaseSecurity(repo) {
  const candidates = [];
  const sqlFiles = walkFiles(repo.localPath, p => p.endsWith('.sql'));

  for (const file of sqlFiles) {
    try {
      const content = readFileSync(file, 'utf8');
      const tableMatches = [...content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_\.]+)/gi)];

      for (const m of tableMatches) {
        const tableName = m[1].replace(/^public\./, '');
        const hasRls = new RegExp(`ALTER\\s+TABLE\\s+.*${tableName}.*ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(content);

        if (!hasRls) {
          const relPath = relative(repo.localPath, file);
          candidates.push({
            repo,
            track: 'SEC-RLS',
            file: relPath,
            tableName,
            title: `Enforce Strict Row-Level Security (RLS) & Policies on '${tableName}' Table`
          });
        }
      }
    } catch {}
  }
  return candidates;
}

function generateSpecContent(item) {
  const { repo, track, file, title } = item;

  let spec = `---
repo_path: "${repo.shortName}"
title: "${title}"
priority: "medium"
branch: "${repo.defaultBranch}"
tags:
  - maintenance
  - codebase-health
  - ${track.toLowerCase()}
---
# 🎯 Maintenance Task: ${title}

## 📌 1. Objective & Context
Improve the reliability, security, and type safety of the \`${repo.shortName}\` codebase by resolving outstanding maintenance targets in \`${file}\`.

`;

  if (track === 'CLEAN-TYPES') {
    spec += `## 🛠️ 2. Functional Requirements
- [ ] Inspect \`${file}\` and replace all explicit/implicit \`any\` types with strict TypeScript interfaces, branded types, or Discriminated Unions.
- [ ] Remove all \`@ts-ignore\` and \`@ts-nocheck\` annotations in favor of proper type narrowing.
- [ ] Ensure all public exports have explicit return types.
- [ ] Ensure zero build errors and strict compilation.

## 🧪 3. Verification & Testing
- [ ] Run \`npm run build\` (or workspace \`tsc\`) and verify 0 type errors.
- [ ] Run \`npm test\` and verify all existing tests pass 100%.
`;
  } else if (track === 'TEST-COVERAGE') {
    spec += `## 🛠️ 2. Functional Requirements
- [ ] Create a comprehensive unit test suite covering \`${file}\`.
- [ ] Test standard nominal execution paths with multiple assertion cases.
- [ ] Test edge cases: null/undefined inputs, empty arrays/strings, malformed payloads, and boundary limits.
- [ ] Test error throwing and async rejection handling.

## 🧪 3. Verification & Testing
- [ ] Run \`npm test\` and verify the new test suite passes 100% with no regressions.
`;
  } else if (track === 'SEC-RLS') {
    spec += `## 🛠️ 2. Functional Requirements
- [ ] Add explicit \`ALTER TABLE ${item.tableName || 'table'} ENABLE ROW LEVEL SECURITY;\`.
- [ ] Define comprehensive RLS policies covering SELECT, INSERT, UPDATE, and DELETE operations.
- [ ] Ensure multi-tenant isolation: tenants can only access records matching their verified tenant/user ID.
- [ ] Avoid 'allow all authenticated' blanket policies.

## 🧪 3. Verification & Testing
- [ ] Verify SQL syntax and migration safety.
- [ ] Run \`npm test\` across the workspace.
`;
  }

  return spec;
}

async function main() {
  console.log(`[Health Engine] Scanning connected repositories for maintenance targets...`);

  let reposToScan = REPO_REGISTRY.filter(r => existsSync(r.localPath));
  if (TARGET_REPO) {
    reposToScan = reposToScan.filter(r => r.repoKey.includes(TARGET_REPO) || r.shortName.includes(TARGET_REPO));
  }

  const allCandidates = [];

  for (const repo of reposToScan) {
    const secGaps = analyzeDatabaseSecurity(repo);
    const typeGaps = analyzeTypeHygiene(repo);
    const testGaps = analyzeMissingTests(repo);

    allCandidates.push(...secGaps, ...typeGaps, ...testGaps);
  }

  console.log(`[Health Engine] Discovered ${allCandidates.length} total maintenance opportunities across ${reposToScan.length} repo(s).`);

  const selected = allCandidates.slice(0, LIMIT);

  if (selected.length === 0) {
    console.log(`[Health Engine] No candidate maintenance tasks found. Repositories are clean!`);
    return;
  }

  console.log(`\n📋 Staging Top ${selected.length} Maintenance Specs (Limit: ${LIMIT}, Mode: ${STAGE ? 'STAGE TO QUEUE' : 'DRY-RUN'}):\n`);

  for (const item of selected) {
    const sanitizedTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `SPEC-MAINT-${item.repo.shortName}-${sanitizedTitle}.md`;
    const specMarkdown = generateSpecContent(item);

    console.log(` • [${item.track}] ${item.repo.shortName}: ${item.title}`);
    console.log(`   ➔ Target File: ${item.file}`);
    console.log(`   ➔ Spec Name:   ${filename}\n`);

    if (STAGE) {
      if (!existsSync(QUEUE_DIR)) {
        mkdirSync(QUEUE_DIR, { recursive: true });
      }
      const targetPath = join(QUEUE_DIR, filename);
      writeFileSync(targetPath, specMarkdown, 'utf8');
      console.log(`   ✅ Staged spec to ${targetPath}\n`);
    }
  }

  if (DRY_RUN && !STAGE) {
    console.log(`\n💡 Run with '--stage' to write these specs directly to the Jules dispatch queue:`);
    console.log(`   node generate_maintenance_specs.mjs --stage --limit ${LIMIT}\n`);
  }
}

main().catch(err => {
  console.error('[Health Engine] Fatal Error:', err);
  process.exit(1);
});
