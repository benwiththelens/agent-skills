---
name: jules-dispatch
description: Autonomous Jules Pipeline v2 — queue-based async dispatcher for Google Jules with Graphify AST enrichment, rate-limit safety buffers, autonomous feedback resolution, and Kimi k3 / multi-model audit gatekeeping.
author: "Ben Weber (@benwiththelens) & VANTAGE"
license: MIT
---

# Jules Dispatch & Notifier — Autonomous Pipeline v2

A lean, self-contained automation suite for [Google Jules](https://jules.google.com),
Google's asynchronous coding agent. Write a Markdown **task spec**, drop it in a
queue folder, and run the dispatcher — it validates the spec, resolves the target
GitHub repo against your connected Jules sources, enriches the prompt with
**Graphify AST code intelligence**, creates a session, tracks state, and archives
the processed spec. The accompanying **notifier & orchestrator** continuously
monitors active sessions, alerts Discord on state transitions (`AWAITING_USER_FEEDBACK`,
`REQUIRES_APPROVAL`, `COMPLETED`), and triggers automated subagent turns to resolve
pending questions or plan approvals. No frameworks, no npm dependencies, no lock-in.

## v2 Architecture Highlights

| Feature | Description |
| :--- | :--- |
| **Graphify AST Enrichment** | Automatically injects exact Abstract Syntax Tree (AST) node dependencies, types, and file relationships into prompts. |
| **Rate-Limit Safety Buffers** | Enforces a daily automated cap (80/100) with a 20-session manual reserve buffer to prevent quota exhaustion. |
| **Autonomous Feedback Resolution** | When Jules pauses for feedback or plan approval, an OpenClaw subagent inspects the git patch, resolves the blocker, and approves execution. |
| **Kimi k3 / Multi-Model Audit Gatekeeping** | PRs are never blindly trusted. High-reasoning models (`moonshot/kimi-k3`, `gemini-3.7-flash`) audit diffs for security, compliance, and logic before merge. |

## Requirements

- Node.js 18+ (uses native `fetch`)
- A Jules API key with at least one connected GitHub source
- A directory to serve as the queue (any path — defaults to `./jules-queue`)

## Configuration

All configuration is via environment variables — nothing is hardcoded:

| Variable             | Required | Default                                | Purpose                          |
| -------------------- | -------- | -------------------------------------- | -------------------------------- |
| `JULES_API_KEY`      | ✅       | —                                      | Jules API key                    |
| `JULES_API_ENDPOINT` |          | `https://jules.googleapis.com/v1alpha` | API base URL                     |
| `JULES_QUEUE_DIR`    |          | `./jules-queue`                        | Folder watched for `SPEC-*.md`   |
| `JULES_STATE_PATH`   |          | `./jules-state.json`                   | Dispatch ledger / rate counters  |
| `JULES_DAILY_LIMIT`  |          | `80`                                   | Automated dispatches per day cap |

## Task Spec Format

Specs are plain Markdown with a small YAML frontmatter block:

```markdown
---
repo: my-cool-project        # required — GitHub repo name connected to Jules
title: Fix flaky login test  # optional — defaults to filename
priority: high               # optional — critical|high|medium|low (default medium)
branch: main                 # optional — defaults to repo's default branch
depends_on: SPEC-P9-core-types # optional — upstream dependency spec(s)
---
# 🎯 Task Spec: Fix flaky login test

## 📌 Objective & Context
The login integration test intermittently fails in CI…

## 🛠️ Functional Requirements
- [ ] Reproduce the flake locally
- [ ] Identify the race condition in `src/auth/session.js`
- [ ] Add a regression test
```

Any Markdown below the frontmatter becomes the Jules prompt — be specific about
file paths, acceptance criteria, and edge cases.

## Usage

```bash
# Dispatch everything pending in the queue
JULES_API_KEY=... node jules_dispatcher.mjs

# Run session state notifier & orchestrator sweep
node jules_notifier.mjs

# CLI interactions with Jules sessions
node jules_client.mjs list-sessions
node jules_client.mjs get-session <sessionId>
node jules_client.mjs send-message <sessionId> "response"
node jules_client.mjs approve-plan <sessionId>

# Test run — validates specs & source resolution without calling the API
node jules_dispatcher.mjs --dry-run

# Dispatch at most one spec (great for cron/agent loops)
node jules_dispatcher.mjs --limit 1

# Print today's dispatch digest from the state ledger
node jules_dispatcher.mjs --digest
```

## Behavior Notes

1. **Priority ordering.** Specs dispatch in priority order
   (`critical → high → medium → low`), then oldest-first within a tier.
2. **Daily rate limit.** The dispatcher tracks a per-day counter in the state
   file and halts at `JULES_DAILY_LIMIT` — remaining specs stay queued.
3. **Dependency gating.** Specs with `depends_on` are held until upstream
   specs reach `COMPLETED` state.
4. **Graphify enrichment.** The dispatcher queries the local Graphify AST
   index (`.graphify_analysis.json`) and appends the exact dependency subgraph
   to the prompt payload.
5. **No auto-merge, ever.** Sessions are created with `AUTO_CREATE_PR` so Jules
   opens a pull request for review, but there is intentionally **no merge or
   automerge code path** in this tool. Every PR requires human review on GitHub.
6. **Atomic state writes.** The ledger is written via temp-file + rename, so a
   crash mid-run can't corrupt your dispatch history.
7. **Failed dispatches stay queued.** If the API errors on a spec, it's left in
   the queue for the next sweep — nothing is silently dropped.

## Agent Integration Guidance

- **One spec per task.** Small, well-scoped specs beat monolithic ones.
- **Run with `--limit 1`** from an agent loop so a human (or the agent) can
  confirm each dispatch before the next one fires.
- **Use `--dry-run` first** when wiring up a new repo — it validates the
  frontmatter and confirms the repo resolves to a connected Jules source.

---
*Portability: any machine with Node 18+ · config via env vars · zero npm dependencies*
