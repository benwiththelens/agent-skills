---
type: system-architecture
category: agentic-infrastructure
title: "Autonomous Jules Pipeline v3 & Codebase Health Engine — Architecture Specification"
status: production-ready
created: 2026-08-14
updated: 2026-08-19
author: VANTAGE & Ben Weber (@benwiththelens)
tags:
  - architecture-spec
  - google-jules
  - agentic-pipeline
  - openclaw
  - autonomous-dev
  - ci-cd
  - code-health
---

# 🚀 Autonomous Jules Pipeline v3 & Codebase Health Engine — Specification

> **A blueprint for decoupled, high-velocity agentic software development.**  
> How VANTAGE orchestrates parallel Google Jules cloud VMs, Graphify AST code intelligence, a Tiered Complexity Cascade (Flash Lite ➔ Kimi k3), advisory state locking, and an automated Codebase Health Engine.

---

## 1. Executive Summary & Core Philosophy

The **Autonomous Jules Pipeline v3** is an asynchronous, event-driven development architecture. It bridges high-level systems architecture with parallelized cloud-agent execution, allowing a single architect to coordinate massive monorepo builds and continuous codebase maintenance while eliminating the manual keyboard grind.

### The 6 Pillars of the Architecture:
1. **Decoupled Asynchrony:** The architect and orchestrator never wait on code generation. Tasks are dispatched to cloud VMs (Google Jules) and monitored via headless cron daemons.
2. **Graph-Enriched Context (10KB AST Budget):** Prompts are injected with exact Abstract Syntax Tree (AST) node dependencies, types, and file relationships under a strict 10 KB budget to eliminate blind file searches and prevent token bloat.
3. **Tiered Complexity Cascade (Flash Lite ➔ Kimi k3):** When a cloud agent pauses for feedback or plan approval, `google-direct/gemini-3.5-flash-lite` triages the blocker. Routine questions and approvals are resolved instantly; high-complexity architectural decisions, RLS/auth policies, and deep merge conflicts emit `DEFER_TO_KIMI_K3` to delegate directly to `moonshot/kimi-k3`.
4. **Strict Audit & Test Gatekeeping:** PRs must pass high-reasoning security audits, lockfile auto-healing, and a 100% automated test suite pass (`npm test`) before merging into `main`.
5. **Advisory State Locking & Compaction:** State tracking uses pid/timestamp advisory file locking (`.lock`) with retry jitter, rolling compaction (<50KB target), and monthly history archiving.
6. **Continuous Codebase Health Engine:** An automated scanner generates atomic maintenance specs (missing RLS, `any` type cleanup, test coverage gaps), utilizing the full 100 session/day Jules quota for permanent code hardening.

---

## 2. High-Level System Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            THE ARCHITECT (BEN)                              │
│              High-Level Vision, Deep Research & Macro Roadmaps               │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    VANTAGE ORCHESTRATOR (OpenClaw / Cato)                   │
│  1. Health Engine: Auto-generates maintenance specs (RLS, Types, Tests)    │
│  2. Graphify Indexer: Extracts AST nodes & types (strict 10KB byte ceiling) │
│  3. Queue Dispatcher: Rate-limits & pushes enriched specs to Google Jules   │
│  4. State Engine: Advisory file locking (.lock) & rolling compaction        │
└───────────────┬─────────────────────────────────────────────▲───────────────┘
                │ (Dispatches Tasks)                          │ (Monitors & Resolves)
                ▼                                             │
┌──────────────────────────────────────────────┐              │
│       GOOGLE JULES CLOUD FOUNDRY (VMs)       │              │
│  • 10+ Concurrent Isolated Dev Containers    │              │
│  • File Modification, Refactoring, & Tests   │              │
│  • Opens Pull Requests on GitHub             │              │
└───────────────┬──────────────────────────────┘              │
                │                                             │
                ▼                                             │
┌──────────────────────────────────────────────┐              │
│      HEADLESS NOTIFIER & CASCADE DAEMON      │──────────────┘
│  • Polls session states every 5 minutes      │ Tier 1: Gemini Flash Lite
│  • Summary fast-path skips redundant checks  │   (Resolves Routine)
│  • Escalates via DEFER_TO_KIMI_K3 handover   │ Tier 2: Moonshot Kimi k3
│  • Stages PRs in jules-state.json            │   (Resolves Complex)
└───────────────┬──────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MULTI-MODEL AUDIT & MERGE GATEKEEPER                     │
│  1. Security Audit: Flash Lite fast-path ➔ Kimi k3 deep-reasoning escalation│
│  2. Blast-Radius Filter: Escalates sensitive files (CI/CD, env, auth, routes)│
│  3. Conflict Resolution: Merges branches & heals lockfiles automatically    │
│  4. Subprocess Hardening: 60s timeout ceiling across all Git CLI commands    │
│  5. Full Test Battery: Executes npm test across all monorepo workspaces     │
│  6. Sync & Push: Pushes clean main branch to GitHub with rollback tags      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Subsystem Deep-Dive

### 3.1 Subsystem 1: Spec Atomizer & Codebase Health Engine
Tasks are staged as individual markdown files in `vault/01-ACTIVE/jules-queue/`. In addition to macro roadmap specs, `generate_maintenance_specs.mjs` scans connected repositories to generate atomic specs across 3 core maintenance tracks:
- **`SPEC-SEC-RLS-*`:** Enforcing explicit Row-Level Security policies on all database tables.
- **`SPEC-CLEAN-TYPES-*`:** Eliminating explicit `any` and `@ts-ignore` in favor of strict TypeScript interfaces.
- **`SPEC-TEST-COVERAGE-*`:** Adding comprehensive unit test suites to untested utility and service modules.

### 3.2 Subsystem 2: Graphify AST Code Intelligence (10KB Ceiling)
Before dispatching a task, `jules_dispatcher.mjs` extracts AST symbols, types, and module relationships from the local Graphify index. It enforces a strict 10 KB ceiling, ensuring prompt clarity while preventing token inflation.

### 3.3 Subsystem 3: Queue Dispatcher & Quota Governor
Manages outbound traffic and API quotas:
- **State Tracking (`jules-state.json`):** Tracks session IDs, spec filenames, dispatch timestamps, and PR URLs under advisory file locking.
- **Dependency Resolution:** Holds specs with `depends_on` until prerequisite specs reach `COMPLETED` state.
- **Daily Quota Safety Buffer:** Enforces an automated dispatch cap (80/100 sessions) with a 20-session manual reserve.

### 3.4 Subsystem 4: Tiered Complexity Cascade Orchestrator
When Jules pauses in `AWAITING_USER_FEEDBACK` or `REQUIRES_APPROVAL`, `jules_notifier.mjs` deploys a two-stage cascade:
1. **Tier 1 (Gemini Flash Lite):** Sub-second triage. If the feedback is a simple plan approval or routine technical clarification, Gemini resolves it immediately.
2. **Tier 2 (Moonshot Kimi k3):** If Gemini detects architectural ambiguity, multi-file database changes, or tricky logic, it emits `DEFER_TO_KIMI_K3: <summary>`, handing off full context to Kimi k3.
3. **Exponential Backoff:** If upstream providers fail, sessions back off (up to 1 hr) rather than failing continuously.

### 3.5 Subsystem 5: Multi-Model Audit & Merge Gatekeeper
Ensures zero regressions across repositories:
- **Two-Stage Audit:** Fast-path review with Gemini Flash; deep reasoning with Kimi k3 on complex diffs.
- **Blast-Radius Human Escalation:** Automatically escalates PRs touching critical infrastructure (`.github/workflows/`, `.env*`, auth modules, credentials, routing) via Discord DMs.
- **Subprocess Ceilings:** All Git commands enforce a 60-second timeout ceiling to eliminate hung daemon processes.
- **Lockfile Auto-Healing:** Resolves lockfile merge conflicts (`git checkout --theirs` + `npm install --package-lock-only`) automatically.
- **Test Enforcement & Rework Dispatch:** Runs `npm run build` and `npm test`. If tests fail, automatically sends failure logs back to the Jules session for rework.
- **Push & Rollback Tagging:** Squash-merges verified branches, pushes to GitHub, and stamps dated rollback tags (`jules-merge-pr-XXX-TIMESTAMP`).

### 3.6 Subsystem 6: Unified State Engine & Advisory Locking
Managed by `jules_state_manager.mjs`:
- **Advisory File Locking (`jules-state.json.lock`):** Prevents cross-process race conditions when dispatcher and notifier run concurrently.
- **Rolling Compaction:** Caps active completed sessions to 30 entries, maintaining state file sizes strictly under 50 KB.
- **Monthly History Rotation:** Automatically archives older dispatch entries to `vault/02-ARCHIVE/jules-history/history-[YYYY-MM].json`.

---

*Authored by VANTAGE (Sovereign Systems Architect) | Cato Compute Node*
