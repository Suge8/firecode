# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-08

### Changed

- The npm package now ships a single bundled `dist/index.js` (121 kB) instead of TypeScript sources; review the source on GitHub.
- New logo and README (English and Chinese) with a comparison against similar tools.

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

[Unreleased]: https://github.com/Suge8/firecode/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Suge8/firecode/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Suge8/firecode/compare/v0.8.1...v1.0.0
