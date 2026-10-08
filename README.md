<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<h3 align="center">The only Pi extension I still run.</h3>

<p align="center">Parallel sub-agents, multi-model code review and a cleaner terminal for <a href="https://pi.dev">Pi</a>. One install, works out of the box.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center"><img alt="The commander dispatching three sub-agents in parallel" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.gif" width="860"></p>

```bash
pi install npm:pi-firecode
```

Restart Pi (1.1.0+) and it's ready. The config is created for you on first launch.

## Why FireCode

I used to stack a dozen Pi extensions. Now this is the only one I keep.

- **Works out of the box.** One install. Sensible defaults, English or Chinese UI.
- **Sub-agents you actually control.** Run them in parallel, give each role its own model, fall back automatically when a provider fails, and open any of them to watch or redirect it.
- **Review that doesn't stop at a report.** Several different models check the work, and every problem goes back to the agent until it's fixed.
- **A light core.** Two small sub-agent tools. Review and the watcher add none.
- **Nothing to read unless you want to.** Every step in between folds away. You see the answer; tool output opens on demand.

## Review that fixes, not just flags

Run `/fire-review` after a change. Different model families review what the agent actually did — the files, the session, the tests they run themselves. Anything they flag goes straight back to the agent to fix, and the next round checks it again. If a fix keeps failing, an advisor model decides whether to push on, narrow the scope or stop.

<p align="center"><img alt="Round 1 fails, the agent fixes it, round 2 passes" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.gif" width="760"></p>

Most open-source reviewers hand you a report and stop there:

| | Reviewers | Fixes what it finds | Re-checks the fix |
| --- | --- | --- | --- |
| **FireCode** | Several model families | Yes, automatically | Yes, until it passes |
| Qwen Code `/review` | Up to 16 agents, one model | Once, with `--fix` | No |
| PR-Agent / Qodo | Specialist agents, one model | On request | No |
| multi-model-review (Pi) | Several model families | No | No |

## Sub-agents you can see

Every sub-agent sits above the input box. Click one to read its whole run and talk to it directly.

<p align="center"><img alt="A sub-agent's full run with a follow-up typed into its own input box" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.png" width="720"></p>

## A light core

Sub-agent tools added to every request (tool definitions sent to the model, measured October 2026). Review and the watcher run in their own sessions and add nothing.

| | Sub-agent tools | Characters |
| --- | --- | --- |
| **FireCode** | 2 | **926** |
| omp | 2 | 3,140 |
| Codex CLI | 5–6 | 4,766–9,378 |
| pi-subagents | 2–3 | 4,703–23,182 |

## Also in the box

`/fire-watch` a cheap model that speaks up only when work drifts · `/preset` switch model, thinking and tools in one go · `/quota` and `/tokens` usage at a glance · `Ctrl+R` rename the session · `Ctrl+Shift+S` OpenAI Fast mode

On a Claude subscription, FireCode adds Claude Code attribution to requests and retries once when your login token rotates.

Turn anything off with `"features": { "<name>": false }` in `~/.pi/agent/extensions/firecode/config.jsonc`.

[Contributing](.github/CONTRIBUTING.md) · MIT © Suge8
