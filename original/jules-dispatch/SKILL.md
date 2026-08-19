---
name: jules-dispatch
description: Autonomous Jules Pipeline v3 — queue-based async dispatcher for Google Jules with Tiered Complexity Cascade (Gemini Flash Lite ➔ Kimi k3), advisory state locking, Graphify AST 10KB context ceilings, automated Codebase Health Engine, and multi-model audit & test gatekeeping.
author: "Ben Weber (@benwiththelens) & VANTAGE"
license: MIT
---

# Jules Dispatch & Notifier — Autonomous Pipeline v3

A lean, self-contained automation suite for [Google Jules](https://jules.google.com),
Google's asynchronous coding agent. Write a Markdown **task spec**, drop it in a
queue folder, and run the dispatcher — it validates the spec, resolves the target
GitHub repo against your connected Jules sources, enriches the prompt with
**Graphify AST code intelligence** (budgeted under a 10KB ceiling), creates a session,
resolves upstream dependencies, tracks state with **advisory file locking**, and archives
the processed spec.

The accompanying **notifier & feedback orchestrator** continuously monitors active
sessions, alerts Discord on state transitions (`AWAITING_USER_FEEDBACK`, `REQUIRES_APPROVAL`,
`COMPLETED`, `FAILED`), and triggers a **Tiered Complexity Cascade**:
- **Tier 1 (Gemini Flash Lite):** Triages feedback and resolves routine approvals and questions instantly at near-zero token cost.
- **Tier 2 (Moonshot Kimi k3):** Receives structured `DEFER_TO_KIMI_K3` handovers for high-complexity architectural decisions, RLS/auth policies, or tricky merge conflicts.

The **merge gatekeeper** audits inbound PR diffs with high-reasoning LLMs, resolves
local merge conflicts (including lockfile healing), enforces full monorepo test
batteries (`npm test`), auto-merges verified changes, and tags commits for instant rollback.

The **Codebase Health Engine (`generate_maintenance_specs.mjs`)** scans repositories
via AST analysis to automatically generate and stage atomic maintenance specs (missing RLS,
`any` type cleanup, test coverage gaps), utilizing the full 100 session/day Jules quota.

## Architecture Highlights

| Component | Role |
| :--- | :--- |
| **`jules_dispatcher.mjs`** | Queue dispatcher with priority ordering, `depends_on` gating, Graphify AST 10KB budgeting, daily quota governor, and vault digest archiving. |
| **`jules_notifier.mjs`** | Session monitor with summary-state fast-path polling and **Tier 1 (Flash Lite) ➔ Tier 2 (Kimi k3) Complexity Cascade** with exponential retry backoff. |
| **`jules_merge_gatekeeper.mjs`** | 3-phase gatekeeper with 60s git subprocess timeouts: LLM security audit, branch merge & test suite verification, auto-merge with rollback tags, and blast-radius human review escalation. |
| **`jules_state_manager.mjs`** | Unified atomic state engine with **advisory file locking (`.lock`)**, rolling compaction (<50KB target), monthly history archiving, and dependency satisfaction queries. |
| **`generate_maintenance_specs.mjs`** | Automated codebase health and janitor spec generator for RLS security, zero-`any` strictness, test coverage gaps, and dependency pruning. |
| **`jules_client.mjs`** | Zero-dependency CLI and API wrapper for session creation, messaging, listing, and plan approval. |
| **`jules_discord.mjs`** | Shared webhook and CLI Discord notification transport. |

## Requirements

- Node.js 18+ (uses native `fetch`)
- A Jules API key with at least one connected GitHub source
- Optional: `GITHUB_TOKEN` and `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` for the merge gatekeeper

## Configuration

All configuration is supported via environment variables or credential files:

| Variable | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `JULES_API_KEY` | ✅ | — | Google Jules API key |
| `JULES_API_ENDPOINT` | | `https://jules.googleapis.com/v1alpha` | API base URL |
| `JULES_QUEUE_DIR` | | `./vault/01-ACTIVE/jules-queue` | Folder watched for `SPEC-*.md` |
| `JULES_STATE_PATH` | | `./jules-state.json` | Dispatch ledger & session tracker |
| `JULES_DAILY_LIMIT` | | `80` | Automated dispatches per day cap (20 reserve) |
| `GITHUB_TOKEN` | (Gatekeeper) | `~/.openclaw/credentials/github.json` | GitHub API access for PR diffs & merges |
| `GOOGLE_API_KEY` | (Gatekeeper) | `~/.openclaw/credentials/google.json` | Gemini Flash direct API for security audits |
| `OPENROUTER_API_KEY` | (Gatekeeper) | `~/.openclaw/credentials/openrouter.json` | Fallback LLM audit provider |

## Task Spec Format

Specs are plain Markdown with a YAML frontmatter block:

```markdown
---
repo_path: "my-cool-project" # required — GitHub repo name connected to Jules
title: "Phase 3: Core Types & Router" # optional — defaults to filename
priority: "high"             # optional — critical|high|medium|low (default medium)
branch: "main"               # optional — defaults to repo's default branch
depends_on: "SPEC-P2-schema" # optional — upstream prerequisite spec(s)
tags:
  - jules-spec
  - phase-3
---
# 🎯 Task Spec: Phase 3: Core Types & Router

## 📌 1. Objective & Context
Implement core TypeScript definitions and router handler for the v2 API...

## 🛠️ 2. Functional Requirements
- [ ] Implement `src/types/router.ts`
- [ ] Add route matching tests in `tests/router.test.ts`
- [ ] Ensure 100% test pass rate

## 🧪 3. Verification & Testing
- [ ] Run `npm test` and assert all 24 tests pass.
```

## Usage & CLI Commands

```bash
# 1. Generate and stage automated codebase maintenance specs
node generate_maintenance_specs.mjs --stage --limit 5

# 2. Dispatch pending specs from the queue
JULES_API_KEY=*** node jules_dispatcher.mjs

# Dry-run validation (checks frontmatter, dependencies, and source mapping without calling API)
node jules_dispatcher.mjs --dry-run

# Dispatch at most 1 spec (ideal for cron or agent loops)
node jules_dispatcher.mjs --limit 1

# Output today's dispatch digest & archive to vault
node jules_dispatcher.mjs --digest --send

# 3. Run session monitor sweep & auto-resolve feedback via Tiered Cascade
node jules_notifier.mjs

# 4. Run automated PR security audit, test verification, & merge gatekeeper
node jules_merge_gatekeeper.mjs
node jules_merge_gatekeeper.mjs --dry-run --repo "owner/repo"

# 5. CLI client interactions
node jules_client.mjs list-sessions
node jules_client.mjs get-session <sessionId>
node jules_client.mjs send-message <sessionId> "Technical answer"
node jules_client.mjs approve-plan <sessionId>
```

---
*Zero external npm dependencies · Fully portable Node.js 18+ · Multi-model verified*
