---
name: obsidian-skills
description: "Vault health, link normalization, json-canvas graph creation, and defuddle note formatting."
metadata:
  author: "Steph Ango / Obsidian Team"
  original_source: "https://github.com/kepano/obsidian-skills"
  license: "MIT"
  curated_by: "benwiththelens"
  version: "1.0.0"
---

# Obsidian Skills

A collection of agent skills for working with Obsidian vaults. These skills follow the [Agent Skills specification](https://agentskills.io/specification) so they can be used by any skills-compatible agent, including Claude Code, Codex, OpenCode, and OpenClaw.

## Included Skills

| Skill | Description |
|-------|-------------|
| `obsidian-markdown` | Create and edit [Obsidian Flavored Markdown](https://help.obsidian.md/obsidian-flavored-markdown) (`.md`) with wikilinks, embeds, callouts, properties, and other Obsidian-specific syntax. |
| `obsidian-bases` | Create and edit [Obsidian Bases](https://help.obsidian.md/bases/syntax) (`.base`) with views, filters, formulas, and summaries. |
| `json-canvas` | Create and edit [JSON Canvas](https://jsoncanvas.org/) files (`.canvas`) with nodes, edges, groups, and connections — used for building visual knowledge graphs of vault content. |
| `obsidian-cli` | Interact with Obsidian vaults via the [Obsidian CLI](https://help.obsidian.md/cli), including plugin and theme development, vault health checks, and link normalization. |
| `defuddle` | Extract clean markdown from web pages using [Defuddle](https://github.com/kepano/defuddle), removing clutter to save tokens when clipping pages into notes. |

## Usage Guide

- **Vault health & maintenance:** use `obsidian-cli` for scripted vault operations (listing notes, checking links, batch edits) and `obsidian-vault-maintainer`-style workflows for linting structure.
- **Link normalization:** when renaming or reorganizing notes, use `obsidian-markdown` conventions so wikilinks, aliases, and embeds stay valid.
- **Graph creation:** use `json-canvas` to generate `.canvas` files that map relationships between notes — one node per note, edges for links, groups for topics.
- **Clean web clipping:** use `defuddle` to strip nav, ads, and boilerplate from a URL before saving the content as a vault note.

## Installation (upstream)

```bash
# npx skills
npx skills add https://github.com/kepano/obsidian-skills

# OpenCode
git clone https://github.com/kepano/obsidian-skills.git ~/.opencode/skills/obsidian-skills

# Claude Code: copy repo contents into a .claude folder at the vault root
```

In this workspace, the individual skills are installed under `~/.openclaw/skills/obsidian-skills/skills/<skill-name>/SKILL.md` and are auto-discovered by OpenClaw.
