<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-dark.svg">
    <img alt="firecode" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/brand/logo-light.svg" height="72">
  </picture>
</p>

<p align="center">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-2b2b2b?style=for-the-badge"></a>
  <a href="README.zh-CN.md"><img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-FF7A0F?style=for-the-badge"></a>
</p>

<h3 align="center">Install one extension. Uninstall the rest.</h3>

<p align="center">Parallel sub-agents, multi-model code review and a cleaner terminal for <a href="https://pi.dev">Pi</a>. One install, works out of the box.</p>

<p align="center">
  <a href="https://firecode.si"><img alt="Website" src="https://img.shields.io/badge/website-firecode.si-FF7A0F"></a>
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><img alt="The commander dispatching three sub-agents in parallel" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.gif" width="860"></p>

## Why FireCode

- **Works out of the box.** The default config is the recommended one. The UI and the prompts follow your system language; comments in the config file are in English.
- **Sub-agents under control.** Run them in parallel, pick a model per role, switch automatically on failure, step in any time.
- **Hands-off review and delivery.** You don't babysit it. What reaches you has already passed review.
- **An ultra-light core.** Built the Pi way: minimal, so your context stays lean.
- **Low visual load.** Focus on the results that matter. Everything in between folds away until you open it.

## Fully automatic review and delivery

Just tell the commander what you want. On important or hard tasks it starts an adversarial review on its own: any number of models you choose look for problems, every problem goes back to be fixed, and the fix is reviewed again until it passes. What reaches you is code that meets the bar and does what you asked. If it keeps getting stuck, an advisor model decides what to do next. You can also run `/fire-review` yourself at any time.

<p align="center"><img alt="Round 1 fails, the agent fixes it, round 2 passes" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.gif" width="760"></p>

Other reviewers hand you a list of problems. FireCode hands you code that's fixed and re-reviewed:

| | Reviewers | What you get |
| --- | --- | --- |
| **FireCode** | Any number of models, reviewing adversarially | **Fixed code that passed re-review** |
| Claude Code `/code-review` | Several agents, Claude models only | A findings list; `--fix` applies it as-is |
| Codex `/review` | One reviewer on your session's model | A findings list, no code changes |
| Open Code Review (Alibaba) | One model, file by file | A findings list to fix yourself |
| PR-Agent / Qodo | Specialist agents, one model | Comments and suggestions |
| multi-model-review (Pi) | Several model families | One combined verdict |

## Clear sub-agent status

Every sub-agent sits above the input box. Click one to read its whole run and talk to it directly.

<p align="center"><img alt="A sub-agent's full run with a follow-up typed into its own input box" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.png" width="720"></p>

## An ultra-light core

Built the Pi way: sub-agents add just two small tools, and review and the watcher add none. Here is what sub-agent tools cost on every request (tool definitions sent to the model, measured October 2026):

| | Sub-agent tools | Characters |
| --- | --- | --- |
| **FireCode** | 2 | **926** |
| omp | 2 | 3,140 |
| Codex CLI | 5–6 | 4,766–9,378 |
| pi-subagents | 2–3 | 4,703–23,182 |

## Also in the box

`/fire-watch` a cheap model that speaks up only when work drifts · `/preset` switch model, thinking and tools in one go · `/quota` and `/tokens` usage at a glance · `Ctrl+R` rename the session · `Ctrl+Shift+S` OpenAI Fast mode · Works with Claude subscription login

## Install

```bash
pi install npm:pi-firecode
```

Restart Pi (1.1.0+) and it's ready; the config is created on first launch. Turn anything off with `"features": { "<name>": false }` in `~/.pi/agent/extensions/firecode/config.jsonc`.

[Contributing](.github/CONTRIBUTING.md) · MIT © Suge8
