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

<p align="center"><img alt="Give it a task: sub-agents work in parallel, each result is reviewed, the rejected one is fixed, and the commander reviews the merged work before it reaches you" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/flow.gif" width="480"></p>

## Why FireCode

- **Works out of the box.** The recommended config is written on first launch; swap in the models you are logged in to. The UI and the prompts follow your system language.
- **Sub-agents under control.** Run them in parallel, give each role an ordered model chain, switch automatically on failure, step in any time.
- **Hands-off review.** Complex work is reviewed and sent back to be fixed until it passes. You see how each review ended.
- **An ultra-light core.** Built the Pi way: minimal, so your context stays lean.
- **Low visual load.** Focus on the results that matter. Everything in between folds away until you open it.

## Fully automatic review and delivery

Just tell the commander what you want. On complex tasks it starts an adversarial review on its own: up to five models you choose look for problems, every problem goes back to be fixed, and the fix is reviewed again. It stops when the review passes, an advisor model calls it after repeated failures, or the rounds run out. You can also run `/fire-review` yourself at any time.

<p align="center"><img alt="Round 1 fails, the agent fixes it, round 2 passes" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.gif" width="760"></p>

Other reviewers mostly hand you a list of problems. FireCode keeps fixing and re-reviewing:

| | Reviewers | What you get |
| --- | --- | --- |
| **FireCode** | Up to five models, reviewing adversarially | **Fixed code, re-reviewed** |
| Claude Code `/code-review` | One sub-agent of your session | A findings list; `--fix` applies it |
| Codex `/review` | One reviewer on your session's model | A summary of the issues |
| Open Code Review (Alibaba) | One model, a sub-agent per file group | Line comments to fix yourself |
| Qodo | Specialist agents plus a judge | Ranked findings; can apply a fix |
| PR-Agent (open source) | One model call per tool | Comments and code suggestions |
| multi-model-review (Pi) | Several model families | One combined verdict |

<sub>Checked against each product's docs on 2026-10-12.</sub>

## Clear sub-agent status

Every sub-agent sits above the input box. Click one to read its whole run and talk to it directly.

<p align="center"><img alt="The commander dispatching three sub-agents in parallel" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.gif" width="760"></p>

<p align="center"><img alt="A sub-agent's full run with a follow-up typed into its own input box" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.png" width="720"></p>

## An ultra-light core

Built the Pi way: sub-agents add just two small tools, and review and the watcher add none. Here is what sub-agent tools cost on every request:

| | Sub-agent tools | Characters |
| --- | --- | --- |
| **FireCode** | 2 | **1,715** |
| pi-subagents (0.77.0) | 2–3 | 1,561–4,918 |
| omp (18.10.1) | 2 | 3,369 |
| Codex CLI (0.162.1) | 5–6 | 5,045–9,641 |

<sub>Tool definitions sent to the model (name, description and parameters), default settings. FireCode measured 2026-10-31; others 2026-10-12.</sub>

## Also in the box

`/fire-watch` a cheap model that speaks up only when work drifts · `/preset` switch model, thinking and tools in one go · `/quota` and `/tokens` usage at a glance · `Ctrl+R` rename the session · `Ctrl+Shift+S` OpenAI fast mode · OpenAI native compaction · Works with Claude subscription login · Claude screenshots upload once instead of every turn

## Install

```bash
pi install npm:pi-firecode
```

Restart Pi (1.4.0+) and it's ready. The config is created on first launch at `~/.pi/agent/extensions/firecode/config.jsonc`: put in the models you use, and turn anything off with `"features": { "<name>": false }`.

- Using herdr? Run `herdr integration uninstall pi` first; FireCode reports the pane state itself.
- Sub-agents and reviewers can run `bash` without a sandbox. Run Pi in a container if you need isolation.

[Contributing](.github/CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · MIT © Suge8
