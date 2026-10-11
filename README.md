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

<p align="center">Parallel Workers under one Master, multi-model code review and a cleaner terminal for <a href="https://pi.dev">Pi</a>. One install, works out of the box.</p>

<p align="center">
  <a href="https://firecode.si"><img alt="Website" src="https://img.shields.io/badge/website-firecode.si-FF7A0F"></a>
  <a href="https://www.npmjs.com/package/pi-firecode"><img alt="npm" src="https://img.shields.io/npm/v/pi-firecode?color=FF7A0F"></a>
  <a href="https://github.com/Suge8/firecode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Suge8/firecode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><img alt="The Master dispatching three Workers in parallel" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/hero.gif" width="860"></p>

## Install

```bash
pi install npm:pi-firecode
```

Requires Pi 1.1.0 or newer. Start Pi again and FireCode is active.

Before you use it:

- **Models.** The default config assumes you are logged in to Anthropic (Claude), OpenAI Codex and DeepSeek. Worker roles, reviewers, the advisor, the watcher and presets each name a model as `"provider/model/thinking"`. Edit them in `~/.pi/agent/extensions/firecode/config.jsonc` (the Pi agent directory, or `$PI_CODING_AGENT_DIR`) and restart Pi.
- **Which models work.** Workers, reviewers and the watcher run as in-process sessions. They only resolve models from Pi's built-in providers or `models.json`; a model that comes from another extension's provider is not found there.
- **herdr.** FireCode reports the pane's agent state itself. Uninstall herdr's official Pi integration (`herdr integration uninstall pi`) and do not click "install" for Pi in herdr's settings, or the two overwrite each other.
- **Turn parts off.** `"features": { "<name>": false }` in the same file; the names are listed there.
- **Safety.** Workers and reviewers have a `bash` tool that is not sandboxed. The guard on Worker `edit`/`write` (current checkout and the temp directory only) prevents accidents; it is not a security boundary. For isolation, run Pi in a container or a read-only mount.

## First run

1. Start Pi. If `config.jsonc` is missing, FireCode writes the recommended one and uses it at once. Put in the models you can use and restart.
2. Describe a multi-part task. The Master (commander) splits it and starts Workers, listed above the input box. Click one to read its whole run or talk to it.
3. On a complex task the Master sends the result to review before handing it back. Run `/fire-review` yourself at any time.

## Commands

| Command | What it does |
| --- | --- |
| `/fire-master` | Turn Master mode on or off for this session (new sessions start with it on); `/fire-master status` lists the Workers |
| `/fire-review [focus]` | Adversarial review of what this session has done so far |
| `/fire-watch` | Turn the watcher on or off for this session: a cheap model that speaks up only when work drifts (off in new sessions) |
| `/preset` | Switch model, thinking level and tools in one go; `--preset` at startup; the template binds `Alt+1`–`Alt+6` |
| `/quota` | Remaining Codex and Claude subscription quota |
| `/tokens [days]` | Token and cost totals from your session files |
| `/fast` | Toggle OpenAI/xAI fast mode (`Ctrl+Shift+S`) |

Pi's session-rename key (`Ctrl+R` by default) renames the session from the input box. In a Worker's full-run view, `Ctrl+Shift+X` interrupts it.

OpenAI native compaction (`openai.nativeCompaction`, on in the template) uses OpenAI/Codex's own context compaction. The result is an encrypted window that only the same model and base URL can continue from; after you switch models FireCode tells you it cannot be continued. A manual `/compact` is cancelled with an explanation when the window is unavailable; automatic compaction falls back to a normal summary with a warning. To always use normal summaries, set `nativeCompaction` to `false` and restart.

## Review and delivery

Tell the Master what you want. On complex tasks it sends the work to an adversarial review: any number of models you choose look for problems, every problem goes back to be fixed, and the fix is reviewed again. It ends when the review passes, the advisor model stops it after repeated failures, or the round limit is reached; the result card says which. Failures, timeouts and cancellations are reported as such, not as a pass.

<p align="center"><img alt="Round 1 fails, the agent fixes it, round 2 passes" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/review-loop.gif" width="760"></p>

Other reviewers hand you a list of problems. FireCode fixes them and reviews again:

| | Reviewers | What you get |
| --- | --- | --- |
| **FireCode** | Any number of models, reviewing adversarially | **Fixed code, re-reviewed** |
| Claude Code `/code-review` | Several agents, Claude models only | A findings list; `--fix` applies it as-is |
| Codex `/review` | One reviewer on your session's model | A findings list, no code changes |
| Open Code Review (Alibaba) | One model, file by file | A findings list to fix yourself |
| PR-Agent / Qodo | Specialist agents, one model | Comments and suggestions |
| multi-model-review (Pi) | Several model families | One combined verdict |

## Clear Worker status

Every Worker sits above the input box. Click one to read its whole run and talk to it directly. In the main view, each turn folds into one summary line (what it is doing now, then `✓ duration · speed`); thinking, tool calls and Worker results open when you click.

<p align="center"><img alt="A Worker's full run with a follow-up typed into its own input box" src="https://raw.githubusercontent.com/Suge8/firecode/main/design/promo/shot-worker-view.png" width="720"></p>

## An ultra-light core

The Master adds just two small tools, and review and the watcher add none. Here is what the Worker tool definitions cost on every request (name, description and parameters sent to the model, measured 2026-10-12):

| | Worker tools | Characters |
| --- | --- | --- |
| **FireCode** | 2 | **1,713** |
| pi-subagents (0.77.0) | 2–3 | 1,561–4,918 |

How it was measured: the JSON length of each tool's `name`, `description` and `parameters`. FireCode counts `subagents` and `subagents_list` with the template's roles and an English interface (1,022 with a Chinese one). pi-subagents 0.77.0 ([commit 5852aa0](https://github.com/nicobailon/pi-subagents/tree/5852aa08ccd55e8c64dd16e69d1b96a17e92b8aa), 2026-10-11; default settings) registers `subagent` (3,357), `bg_wait` (1,133) and the loader `subagents_enable` (428). The low end is what stays in the request while only the loader and `bg_wait` are active, on models that can take a tool mid-conversation; once delegation is enabled, or by default on other models, it is 4,490–4,918. To reproduce the pi-subagents numbers, load its `index.ts` against a stub `ExtensionAPI` that records `registerTool` calls (tools are registered in `src/extension/index.ts`, `src/extension/tool-activation.ts` and `src/runs/background/wait-tool.ts`) and measure each recorded tool the same way. Tool definitions only: the Master prompt adds about 8,500 characters to the system prompt (the English file is 8,527, the Chinese 6,625) plus one line per role.

[Contributing](.github/CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · MIT © Suge8
