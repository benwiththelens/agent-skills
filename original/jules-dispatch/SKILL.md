---
name: jules-dispatch
description: Queue-based async dispatcher for Google Jules — drop Markdown task specs into a folder, and a zero-dependency Node script dispatches them to Jules sessions with rate limiting, state tracking, and a strict no-auto-merge PR policy.
author: "Ben Weber (@benwiththelens) & VANTAGE"
license: MIT
---

# Jules Dispatch & Notifier

A lean, self-contained automation suite for [Google Jules](https://jules.google.com),
Google's asynchronous coding agent. Write a Markdown **task spec**, drop it in a
queue folder, and run the dispatcher — it validates the spec, resolves the target
GitHub repo against your connected Jules sources, creates a session, tracks state,
and archives the processed spec. The accompanying **notifier & orchestrator** continuously
monitors active sessions, alerts Discord on state transitions (`AWAITING_USER_FEEDBACK`, `REQUIRES_APPROVAL`, `COMPLETED`),
and triggers automated subagent turns to resolve pending questions or plan approvals. No frameworks, no npm dependencies, no lock-in.

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
3. **No auto-merge, ever.** Sessions are created with `AUTO_CREATE_PR` so Jules
   opens a pull request for review, but there is intentionally **no merge or
   automerge code path** in this tool. Every PR requires human review on GitHub.
4. **Atomic state writes.** The ledger is written via temp-file + rename, so a
   crash mid-run can't corrupt your dispatch history.
5. **Failed dispatches stay queued.** If the API errors on a spec, it's left in
   the queue for the next sweep — nothing is silently dropped.

## Agent Integration Guidance

- **One spec per task.** Small, well-scoped specs beat monolithic ones.
- **Run with `--limit 1`** from an agent loop so a human (or the agent) can
  confirm each dispatch before the next one fires.
- **Use `--dry-run` first** when wiring up a new repo — it validates the
  frontmatter and confirms the repo resolves to a connected Jules source.

---
*Portability: any machine with Node 18+ · config via env vars · zero npm dependencies*
