---
name: gitea-cli
description: Use when a repo's remote is a Gitea instance rather than GitHub - gh fails with "not a known GitHub host" - and you need to read, create, or edit issues, pull requests, releases, or labels from the command line
---

# Gitea from the command line

`gh` does not work against Gitea. It fails with:

```
none of the git remotes configured for this repository point to a known GitHub host
```

The tool is `tea`. Run it from inside the repo — it discovers the login and the
repo from the remote, so `--repo`/`--login`/`--remote` are almost never needed.
`tea --help` and `tea <entity> --help` cover the command surface. What follows is
only the part that `--help` does not tell you.

## The trap: default output is not the source

`tea issue 6` prints a **reflowed, terminal-wrapped** rendering. It looks like it
could be the raw markdown and is not — it re-wraps lines, splits `**bold**`
across rows, and reformats list markers. Feeding it back into an edit corrupts
the body.

**Always add `-o json` when you need real content.** This applies to any `tea`
read whose output you intend to parse, diff, or write back.

## Quick reference

| Need | Command |
|---|---|
| Raw body of an issue | `tea issue 6 -o json` |
| Anything the subcommands don't expose | `tea api "repos/{owner}/{repo}/issues/6"` |
| Write via the API | `tea api -X PATCH "repos/{owner}/{repo}/issues/6" -F body=@file.md` |
| Open a PR | `tea pulls create --base master --head my-branch -t "title" -d "$(cat body.md)"` |
| Issues (state filter) | `tea issues list --state all` |

`tea api` is the `gh api` equivalent: it handles auth itself, expands `{owner}`
and `{repo}` from repo context, and takes `-X`, `-F key=@file`, `-d @-`, `-o`.

**Do not hand-roll `curl` with a bearer token.** This is the single most
expensive wrong turn: an agent that does not know `tea` authenticates itself goes
hunting for a `GITEA_TOKEN` env var or the OS credential store, finds nothing,
and dead-ends — or trips a credential-extraction guard. Run `tea` from inside the
repo and auth is already solved. If you ever do need the config, it is at
`$XDG_CONFIG_HOME/tea/` or `~/.config/tea/` on Linux/macOS and
`~/AppData/Local/tea/config.yml` on Windows — the Windows path is *not* under
`~/.config/`, which is where people look first.

## Editing an issue or PR body

There is no find-and-replace primitive. Every edit is a **whole-body replace**,
so the only safe shape is read raw → edit a file → write the file back.

```bash
# 1. raw body to a file. jq is the obvious partner for -o json and is often
#    absent (notably on Windows); node needs no install and is always there.
tea issue 6 -o json | node -e "let s='';process.stdin.on('data',d=>s+=d)
  .on('end',()=>require('fs').writeFileSync('body.md',JSON.parse(s).body))"

# 2. edit body.md however you like

# 3. write it back — from the FILE, not through the shell
tea api -X PATCH "repos/{owner}/{repo}/issues/6" -F body=@body.md
```

Step 3 matters. The obvious alternative, `tea issue edit 6 -d "$(cat body.md)"`,
pushes the entire body through shell command substitution — fine for a paragraph,
fragile for a real issue body containing backticks, `$`, or several KB of text.
`-F body=@file` never touches the shell.

**Verify a round trip by comparing like with like.** A JS string `.length` and
`Buffer.byteLength(s,'utf8')` disagree on any body containing em dashes or
arrows; that gap is encoding, not corruption.

## Numbering

Gitea draws issues **and** pull requests from one shared sequence. `tea issues
list` therefore shows gaps where PRs occupy the missing numbers — those issues
are not missing or deleted. `tea pulls list` shows the other half.

## Common mistakes

| Mistake | What happens |
|---|---|
| Reaching for `gh` | Fails immediately; wastes a turn on `gh auth` |
| Hunting for a `GITEA_TOKEN` | `tea` already holds the credential; you will not find one |
| Parsing `tea issue N` output | Silently corrupts the body on write-back |
| Assuming `jq` is installed | Frequently absent; `node -e` always works |
| Body through `"$(cat file)"` | Breaks on backticks/`$`/size; use `-F body=@file` |
| Assuming missing issue numbers | They are PRs |
