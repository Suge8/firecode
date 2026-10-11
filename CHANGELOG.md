# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers do not strictly follow Semantic Versioning: a breaking change can ship in any release and is marked **Breaking**.

## [Unreleased]

## [1.3.0] - 2026-10-12

### Added

- In a Worker's full-run view, `Ctrl+Shift+X` interrupts the Worker.
- A Worker under review can be interrupted (by the Master, or with `Ctrl+Shift+X` in its view): the review is cancelled, the Worker returns to idle with its review obligation kept, and the Master is told the review was interrupted. It can then be reviewed again.
- `/fire-review --cancel` cancels the whole running review, even while the advisor is being consulted; it also works when the review config is broken.
- Turning Master mode off while Workers are running asks for confirmation first.
- A Worker interrupted before its first reply can be resumed directly.
- The Master is told when an extension inside a Worker's session fails.
- Delivery of Master events that fails is retried with a growing delay instead of being dropped.
- The watcher stops with a notice when the provider returns an error; an extension error in the watcher session is reported once and does not stop it.
- A new watcher suggestion replaces one that has not been delivered yet.

### Changed

- **Breaking:** `/tool-status` is removed.
- FireCode no longer re-registers `read`, `bash`, `edit` and `write`. It only restyles the rows of `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`, so Pi's own tool descriptions and the `shellPath`, `shellCommandPrefix` and image-resize settings apply again.
- Tool durations come from Pi, so they also show after resume and in the Worker view.
- In Pi's regular display mode, a summary line that has scrolled out of view is drawn still instead of animating.
- The average speed of a turn is computed from each reply's own duration.
- **Breaking:** presets saved in old sessions are void after reopening them; preset records are now version 2.
- `/preset (none)` restores the model, thinking level and tools from before the preset; a preset without `tools` returns to the tool set from before the preset.
- Switching model by hand voids the active preset and restores its tool set without touching the model.
- `--preset` is applied only at startup.
- `/tokens` reads session files in chunks, so very large sessions are no longer undercounted and use far less memory; unreadable files are reported, and the argument must be a plain number of days.
- **Breaking:** the Worker pool file is version 10; an older one is discarded with a notice, and the file is deleted when the pool is empty.
- `tail` returns what happened after the last outside input, with errors first.
- Workers start with the project trust of their target directory: extensions of an untrusted project are not loaded.
- The watcher session is isolated: it loads none of your extensions, skills or prompt templates.
- While you run `/compact` by hand or switch branches with a summary in `/tree`, Master events, watcher suggestions and review feedback wait until it settles before they are delivered, instead of being appended without waking anyone (after a `/tree` switch they would also have been left on the abandoned branch).
- Events that only inform no longer wake the Master; during a turn they are appended at its end.
- **Breaking:** the review checkpoint is version 7; a review still in progress when you upgrade is discarded.
- During a review the editor lets Pi's application keys and extension shortcuts through; only typing and submit are blocked.
- OpenAI native compaction now goes through Pi's public stream API instead of FireCode's own Responses serialization.
- Diagnostics from the OpenAI and Claude adapters are bilingual and prefixed with `FireCode`.
- Config files may have trailing commas and a BOM; an unreadable file is reported as one problem; the `openai` section is validated with the rest, so unknown fields are reported.
- **Breaking:** `review.tools` must not contain `write` or `edit`; the config is rejected otherwise.

### Removed

- The Master action `disposition` and the `/skill:tdd` allowlist.

### Fixed

- After FireCode is updated while a Master session is open, sub-agents keep running the same FireCode version as the Master instead of loading the new code from disk. Before, a review started in such a session could finish but be reported as "checkpoint format is invalid" or "did not start". Reload the Master session to pick up a FireCode update for both.
- Resuming an old session no longer starts a model turn for no reason.
- `ack` cancels the pending resume reminder, and a Worker you have looked at is still released after 10 minutes.
- After Esc, a turn that only runs a review no longer shows a false "interrupted" mark.
- The warm glow after a turn settles no longer freezes halfway.
- A session that starts while a turn is already running is counted as busy from the start.
- A wake-up delivery can be aborted, so a Master you turned off no longer delivers old events afterwards.
- A malformed review vote that starts with FAIL counts as a failure, and its original text goes back as feedback.
- Decorated verdict lines (bold, headings, trailing punctuation) are read the same way everywhere.
- When the advisor is unavailable, the review skips it, keeps repairing and still posts its card.
- A review timeout card is posted even while the executing model is busy.
- What the Master reads as the outcome of a review now follows how it ended: passed, advisor stopped it, rounds used up, failure, cancelled or timed out.
- OpenAI native compaction no longer gives up replaying history that contains text without a phase, grammar-constrained tools or foreign call ids.
- A manual `/compact` is cancelled with an explanation when the compacted window cannot be used; automatic compaction falls back to a normal summary and warns.
- The Claude Code request headers are added only under Claude subscription credentials; API-key users are no longer presented as Claude Code.
- The fast-mode toggle replaces only the top-level `openai` key, so a comment containing `"openai": {` is no longer edited by mistake, and turning it off writes `false`.

## [1.2.1] - 2026-10-09

### Changed

- `/fire-review` fix requests and the closing summary are now delivered like Master events: each shows as one folded review line in the process view, and the fix round keeps FireCode's system prompt sections instead of dropping them and appending the Master prompt again afterwards. A review that was still in progress when you upgrade is discarded; start it again.

## [1.2.0] - 2026-10-09

### Added

- Other extensions in the same process can subscribe to the `firecode:subagents` event channel for the sub-agent roster: role, model, state, what each is doing in one line, and run start/settle times. It is the same projection as the activity list (see `master/AGENTS.md`).

### Changed

- `/tokens` scans session files without freezing the interface and only parses lines that carry usage, so it returns faster on large session histories.
- The Claude subscription adapter checks the installed Claude Code version once per process, and only when the adapter is enabled.

### Fixed

- OpenAI native compaction no longer silently drops earlier history when the kept messages include turns from other providers (for example Claude or xAI); the compacted window is replayed as expected. When it truly cannot be replayed — after switching to a provider without native compaction, or after turning `nativeCompaction` off — FireCode shows a warning once instead of losing the history silently.

## [1.1.0] - 2026-10-09

### Added

- The system prompt includes today's date, in the main session and in subagents. Pi removed the date upstream to keep the prompt cache stable; here it is its own prompt section, so a new day appends a one-line update instead of rewriting the cached conversation.

### Changed

- Master's prompt and preset instructions are added as system prompt sections instead of replacing the whole system prompt. When SYSTEM.md, skills, AGENTS.md or tools change mid-session, Pi now appends an update instead of rewriting the cached conversation, so the prompt cache and earlier thinking are kept.

## [1.0.4] - 2026-10-09

### Changed

- Master's final review and `/fire-review` no longer expect test-first acceptance tests. They check that every acceptance criterion has a result from a check run in the task, and flag unit or integration tests that only restate the implementation. This follows the implement skill, which now verifies by running checks instead of writing tests first.

## [1.0.3] - 2026-10-09

### Fixed

- herdr could keep showing a session as idle while it was working. Each report's sequence number came from the moment Pi started, so after another Pi had run in the same pane (for example one started inside it), herdr treated every later report as stale. Sequence numbers now follow the clock at send time.

### Changed

- Internal cleanup across every module (about 1,500 fewer lines of code and tests): one owner per piece of state, no unused exports, no dead branches or legacy fallbacks. Behaviour is unchanged except as listed here.
- **Breaking:** sub-agent pool files left by v8 are discarded with a notice instead of being migrated.
- **Breaking:** review findings must use the field names of the current reviewer prompt; findings written with older wording make the vote invalid.
- **Breaking:** the OpenAI Fast toggle only reads and writes the `openai` section of `config.jsonc`; the standalone native config file fallback is gone.
- Queued review cards saved by older versions show as plain text after reload.

### Removed

- Undocumented Claude subscription overrides: `PI_CLAUDE_OAUTH_LOG_FILE`, `PI_CLAUDE_CODE_VERSION_SUFFIX`, `PI_CLAUDE_CODE_ENTRYPOINT`, `PI_CLAUDE_CODE_WORKLOAD`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_WORKLOAD`. `PI_CLAUDE_CODE_VERSION` still works.
- The `review.background` migration hint; the key is now reported as an unknown field like any other.

## [1.0.2] - 2026-10-09

### Changed

- The startup banner now matches the brand logo: a pixel flame with `>_` that runs red to gold, and a bold lowercase `firecode` in an orange-to-gold gradient. It lights up in about a second, then stays still. Terminals narrower than the logo get the one-line banner.

## [1.0.1] - 2026-10-09

### Added

- English and Chinese UI and model-facing text. The new top-level `language` (`"zh"` | `"en"`) in `config.jsonc` picks it; when omitted it follows the system locale (`zh*` → Chinese, otherwise English). Restart to apply a change. The header, input-box shell, tool rows, providers, the watcher and Master (activity list, Worker view, events, tool descriptions and both prompts), review (cards, prompts, notices, validation errors) and the session commands (`/preset`, `/quota`, `/tokens`, herdr sidebar labels) are bilingual too. Review output parsing and review-card previews keep accepting both languages' field names, so sessions that cross a language switch still resume cleanly.
- The first main-session launch writes the recommended `config.jsonc` into the Pi Agent directory when it is missing (never overwrites an existing file) and uses it right away; adjust models and restart when ready.

### Changed

- The recommended `config.example.jsonc` is now in English, including the role names (`researcher`, `engineer`, `batch`, `designer`, `sentinel`) and their `use` text; existing configs are untouched. The Master prompt no longer names any role: it points to roles by their stated use, so role names are entirely up to your config.
- **Breaking:** `review.language` is removed in favour of the top-level `language`; the old key is reported as an unknown field.
- **Breaking:** the Fast toggle shortcut now defaults to `Ctrl+Shift+S` (was `Ctrl+F`, which collided with Pi's built-in `tui.editor.cursorRight` and produced an "Extension issues" warning on every fresh install). `/fast` is unchanged.
- **Breaking:** session rename is no longer an extension shortcut: pressing Pi's own rename key (`app.session.rename`, `Ctrl+R` by default, follows `keybindings.json`) in the input box now opens the rename prompt. The `keys.rename` setting, the `features.rename` switch and the `/rename` command are removed (use Pi's `/name`); the removed settings are reported as unknown. Rename now ships with the input-box shell, so it needs `features.statusbar`.
- herdr: FireCode is now the only agent-state reporter for its pane. The sidebar stays `working` while sub-agents run after the main turn ends, and during `/fire-review`. Uninstall herdr's official pi integration (don't click "install" in herdr settings), or the two will overwrite each other.
- The npm package now ships a single bundled `dist/index.js` (121 kB) instead of TypeScript sources; review the source on GitHub.
- New logo and README (English and Chinese) built around automatic review, sub-agent status and a light core, with comparisons against similar tools.

### Fixed

- Native Responses compaction no longer serializes mid-conversation system messages as tool results. It now follows pi-ai's Responses conversion: dropped for models that fold them into the leading prompt, sent in place as a developer/system item for models that accept them (`supportsMidConvoSystemMessages`, which the GPT-5.4+/GPT-6 catalog entries enable). Replay now also drops system messages from the kept pre-compaction window as the host does and no longer misreads a trailing system update as a provider hint. Histories where tools were added mid-conversation cannot be reproduced outside the host, so replay is declined for them.

## [1.0.0] - 2026-10-08

First stable release. npm is the only public distribution channel.

### Added

- Sub-agent full-run view: open any row of the activity list to follow a sub-agent's whole session, send it follow-ups, page through output, and switch agents with Tab. Follow-ups sent from the view are reported to the commander without waking it.
- Round recorder: every session (main and sub-agent) persists each turn's total duration, final state, and average speed. The input frame and the summary line show `✓ duration · speed`; interrupted and review-blocked turns are marked.
- Activity list: failures and stalled agents pin to the top, folded rows show a count chip with name previews, finished rows expand to the first sentence of their result, and idle agents collapse into one expandable row. Stalled rows append "N min no output".
- Click anchoring in the main session and the sub-agent view: an expanded row stays in view, and following the tail resumes after the next output.
- Master: events carry the run's elapsed time; results arriving while the commander is idle are coalesced into a single wake-up; a rejected idle wake-up is redelivered through steer instead of being lost.
- Master: `send` can reopen a session in a different working directory; ordinary `send` to a working Worker steers it.
- Master: Haiku 5.5 roles (researcher, sentinel, new batch worker); deep audits go to the engineer role.
- Review: results and truncation markers state what was cut, the original size, and which session file holds the full text.
- Write guard: `write` calls containing a `read` truncation notice are rejected so half files are not written back (main session and sub-agents).
- OpenAI fast mode list gains `gpt-6-sol`, `gpt-6.1-sol`, and `gpt-6-luna`; retired `gpt-5.4` models are removed.
- Delegation clause evaluation tools under `evals/delegation` (development only, not packaged).

### Changed

- **Breaking:** every model setting is one atom, `"provider/model/thinking"`; the old split fields and two-part forms are reported as config problems.
- **Breaking:** the configured roster is the role vocabulary for Master.
- **Breaking:** removed Bark notifications (`features.bark`).
- **Breaking:** removed the preset cycle shortcut (`keys.cyclePreset`); the `keys` section rejects unknown fields.
- **Breaking:** removed `tools.replyLines`; intermediate replies are fixed at 3 lines. Unknown top-level config sections are reported.
- Presets hold only a name and extra instructions; the model follows the host. A preset becomes invalid when the model changes, and a failed model switch applies nothing. New sessions do not inherit the previous preset.
- Process groups: one summary line per user-bounded stretch with an action verb and the current target; per-turn expansion is an override of the global level.
- Review cards use monochrome glyphs instead of emoji; review progress shows in the input frame's top border.
- Sub-agent sessions register only UI-independent features, and sub-agent pool state lives in the Pi Agent directory.
- The recommended config moves to the GPT-6, Opus 5.5, and Grok 4.7 generation; review timeout is 40 minutes.

### Fixed

- Master: `kill` wins over late `start`/`steer` write-backs; tearing down a session no longer counts as settling; an `error` terminal state triggers fallback immediately; `start`/`send` return only after the run is counted in flight.
- Busy edge: the "session settled" edge is computed once, in one place, so idle wake-ups no longer report a spurious settle that overwrote the whole-run duration.
- Review: a hung reviewer abort no longer blocks the timeout; runtime state is isolated per session; failed-state reasons carry the round details.
- Claude subscription: a 401 caused by token rotation recovers once; the attribution fallback tracks Claude Code 2.1.278.
- Host coupling: private host access is confined to one adapter that self-checks component shapes and falls back to native rendering with one notice when they do not match.
- Watcher: one failed delivery drops that message only instead of disabling the watcher.
- Fixed the OSC 133 marker landing mid-line after the user-message bar, and click-anchor drift when content fit on one screen.

[Unreleased]: https://github.com/Suge8/firecode/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Suge8/firecode/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Suge8/firecode/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Suge8/firecode/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Suge8/firecode/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/Suge8/firecode/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Suge8/firecode/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Suge8/firecode/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Suge8/firecode/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Suge8/firecode/compare/v0.8.1...v1.0.0
