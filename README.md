<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<p align="center">
  Multi-agent orchestration and adversarial code review for <a href="https://pi.dev">Pi</a> — light, persistent, and calm in the terminal.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img alt="FireCode dispatching three sub-agents in parallel" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.gif" width="860">
</p>

## Quick start

```bash
pi install npm:pi-firecode
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/firecode"
curl -fsSL https://unpkg.com/pi-firecode/config.example.jsonc -o "$agent_dir/extensions/firecode/config.jsonc"
```

Restart Pi (1.1.0 or newer). The template is the maintainer's full setup — swap every `"provider/model/thinking"` atom for models you are logged in to. Upgrade later with `pi update`.

## Why FireCode

**Review that closes the loop.** `/fire-review` runs several models in parallel against your change. Any FAIL goes straight back to the agent to fix, the next round only re-checks what was flagged, an advisor model steps in after repeated failures to continue, narrow, or stop, and a hard round limit keeps it bounded. Progress is checkpointed into the session, so a reload resumes the review instead of losing it.

**Sub-agents that don't get lost.** The commander (`/fire-master`) hands work to role-based sub-agents — each role picks its own model and thinking level, plus a fallback chain that takes over in the same session when a provider fails. Results are written to the session before delivery and re-delivered after a reload. Every sub-agent is listed above the input box; click one to read its full transcript and talk to it directly.

**Light by design.** Delegation is two tools whose definitions total 926 characters. Sub-agents run in-process as Pi SDK sessions — no daemons, no orphans when Pi exits. The npm package is a single 121 kB bundle.

**A calm terminal.** Status lives in the input box border. Each request folds into one summary line — duration, speed, the last few interim replies — followed by the final answer. Click a summary or press `Ctrl+O` for every tool call.

## How it compares

Checked against public docs and source in October 2026.

| | FireCode | Claude Code | Codex CLI | omp | pi-subagents |
| --- | --- | --- | --- | --- | --- |
| Review → fix → re-review loop | Multi-model, advisor, round limit | One pass (`--fix` applies once) | Single reviewer, no fixes | Parallel reviewers, no fix loop | Prompt template, up to 3 rounds |
| Fallback model chain for sub-agents | Yes | Yes | Not found | Yes | No |
| Sub-agent results after a reload | Persisted and re-delivered | Transcripts persist | Resumable, best-effort delivery | Revivable, undelivered results dropped | Background runs keep going |
| Read and steer each sub-agent | Yes | Yes | Yes | Yes | Yes |
| Delegation tool definitions | 926 chars | — | — | 3,140 chars | — |

## Features

| Feature | Entry | What it does |
| --- | --- | --- |
| Commander | `/fire-master` (on by default) | Delegates to role-based sub-agents in parallel; live list above the input box |
| Adversarial review | `/fire-review` | Multi-model review with automatic fix rounds and advisor arbitration |
| Watcher | `/fire-watch` | A cheap model checks each turn and speaks up only when the work drifts |
| Input-box status | automatic | Progress, timer, review rounds, title, model and context usage in the border |
| Turn folding | automatic, `Ctrl+O` | One summary line per request, full detail on demand |
| Presets | `/preset`, your key bindings | Switch model, thinking level, tools and extra instructions together |
| Usage | `/quota`, `/tokens` | Claude and Codex subscription quota; local token and cost totals |
| Claude subscription | automatic | Claude Code attribution; retries once on a 401 caused by token rotation |
| OpenAI request layer | `Ctrl+F` | Verbosity, Fast mode, optional native context compaction |

Turn any feature off with `"features": { "<name>": false }` in the config. The UI text is in Chinese.

## Development

Needs [Bun](https://bun.sh/) and a pi-mono checkout — see [CONTRIBUTING](.github/CONTRIBUTING.md).

```bash
bun test
bun run typecheck
bun run build && pi -e .
```

Architecture, invariants and terms live in `AGENTS.md`, the per-module `AGENTS.md` files and `WORDS.md`.

MIT © Suge8
