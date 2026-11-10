# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers do not strictly follow Semantic Versioning: a breaking change can ship in any release and is marked **Breaking**.

## [Unreleased]

### Changed

- Idle compaction runs in the main session only. A Worker session is released after 10 idle minutes, before a summary is prepared, so it almost never took effect there.

### Fixed

- Killing or releasing a Worker whose turn is still running no longer crashes pi about 45 minutes later. The pool now aborts the turn and waits up to 2 seconds for it to settle before it sends `session_shutdown`, so extensions in the Worker session no longer receive `agent_settled` after the shutdown; a turn whose model stream is stuck is closed when the wait runs out.
- Idle compaction is now applied when the next request is a Worker result waking the master, or when the model or thinking level was changed before the next message. Entries appended after the summary was prepared no longer discard it; switching branch with `/tree` or a manual `/compact` still does.

## [1.11.0] - 2026-11-10

### Changed

- **Breaking**: the Master no longer delegates by default. The main session reads, edits and verifies itself; it starts sub-agents only for two or more independent pieces of read-only research, or when you ask for parallel implementation. The Master prompt is about a fifth of its former length. To have work delegated, ask for it.
- The Master no longer starts a review for its own work. For high-risk changes (persistence, concurrency, migrations, data deletion, billing, auth) it suggests `/fire-review` in its report; work written by a Worker is reviewed once after the Master has read the diff.
- The Worker contract drops the four-step acceptance routine: a Worker runs the narrowest check that covers its change once, commits, and reports what changed and what was not verified.
- The config template has three roles (`researcher`, `junior`, `engineer`) instead of six. Existing config files are not touched; roles whose `use` no longer matches one of the two delegation cases are only picked when you name them.
- Master actions no longer block. `start`, `send`, `review` and `kill` return as soon as the Worker record is written; opening the session and starting the turn happen in the background, and a failure arrives as the usual "failed" event. A failed `start` leaves the Worker idle in the pool: retry with `send` or remove it with `kill`. `interrupt` records the intent and returns `{ interrupting: true }`; the turn is stopped once it is actually running, and the outcome arrives as the "interrupted" event. A follow-up `send` to a running Worker returns `{ queued: true }`.
- Dispatch only checks that the role exists in the config. Model and credential resolution happen when the turn's first request is routed, so credentials added mid-session work right away, and a role with no usable model fails as a "failed" event.
- In the `firecode:subagents` roster, `model` and `thinking` are absent until the Worker's model has been picked.
- `subagents_list`, `/fire-master status` and the activity list show the same state; a paused Worker shows as paused instead of idle.

### Fixed

- An `interrupt` or follow-up sent while a Worker is still starting, or while its turn is still in the host's pre-prompt stage, is no longer dropped.
- Switching a Worker's role no longer sends a "model switched" notice without a reason, and a failed role switch no longer shows the previous role's model.
- A `thinking` override survives a pause followed by a cold auto-resume.
- A run started from the Worker view stays inform-only after a reload, instead of waking the master when it lands.
- A `send` right after a review lands is no longer reported as a failure while the real turn runs untracked.
- Opening the full-process view of a released Worker no longer rewrites its session file.
- Turning the master off and on while a Worker session is still opening no longer fails with "already held".
- A killed Worker's session path is never opened again.
- `ack` on a Worker whose auto-resume has already started now says to use `interrupt`.

## [1.10.1] - 2026-11-06

### Fixed

- Sub-agent progress lines now reach the `firecode:subagents` roster as well, so other extensions such as CuePad show the same "what it is doing" line as the terminal activity list instead of the raw tool command. A stuck sub-agent still shows the command it is stuck on.

## [1.10.0] - 2026-11-06

### Added

- Background session naming (`background.sessionNames`, on by default; older configs keep working): an unnamed session in the main interactive or RPC session is named in the background from your first message (about 1k bytes of text, no images) by the `background` chain, without delaying the reply. The name is one short line in your language. If the message holds no task (a greeting), no name is set and the next message tries again; a failed request is not retried on the main model. A name you set yourself (`/name`, the rename key, CuePad) always wins, and a session is named only once. With no `background` section nothing is named.

## [1.9.0] - 2026-11-06

### Removed

- **Breaking:** the watcher (`/fire-watch`) is removed. In `config.jsonc`, delete `features.watcher` and the top-level `watcher` section. If `features.watcher` stays, it is an unknown feature switch and blocks both `/fire-review` and `/fire-master` from starting until it is deleted. A leftover `watcher` section only shows an "unknown section" warning at session start.
- **Breaking:** presets (`/preset`, `--preset` and per-preset shortcuts) are removed. In `config.jsonc`, delete `features.presets` and the top-level `presets` section. If `features.presets` stays, it is an unknown feature switch and blocks both `/fire-review` and `/fire-master` from starting until it is deleted. A leftover `presets` section only shows an "unknown section" warning at session start. The `keys.fast` shortcut is unchanged.

### Changed

- **Breaking:** a new top-level `background` section, `{ "model": <model chain>, "idleCompaction": true }`, is the only model source for background work: Worker progress lines, every compaction summary, and idle compaction. `master.progress` is gone; move its chain to `background.model`. A leftover `master.progress` is an unknown field and stops `/fire-master` from starting until it is removed. Leaving out `background` turns all three off: no progress lines, and compaction is Pi's default (the session model writes the summary). The template's chain is `["gpt-6-luna/low", "claude-haiku-5-5/low"]`.
- Compaction summaries, automatic and `/compact`, in the main session and in Workers, are written by the `background` chain instead of the session model, with Pi's own cut point, kept messages and summary prompt. Pi sends the summarized messages as a fresh uncached request, so with Opus each compaction cost about $1; with the template's chain it is about a cent, and in replays of real sessions the next decisions were no worse and about as many of the details used later survived (46% with Haiku, 48% with Opus). A candidate whose context window cannot hold the summary input is skipped. If the whole chain fails, one notice says so and Pi's default compaction runs. Sessions held by OpenAI native compaction are left to it; its first automatic failure now falls back to the `background` chain.
- Idle compaction (`background.idleCompaction`, on by default): when a session (the main one or a Worker that is still held) has sat idle for 45 minutes with at least 150k tokens of context, the `background` chain prepares a summary in memory. If the next request, from you or a Master event, comes after the 55-minute cache line and nothing changed in the session meanwhile, that summary is applied as a compaction first, with one line saying how long it was idle, which model wrote it and how far the context shrank; otherwise it is dropped. After a restart nothing is prepared, so the request goes out as usual.
- While a Worker runs, its row in the activity list and the sub-agent view show one line saying what it is doing and why, written by the `background` model from the Worker's new output only: the first line after 30 seconds, then at most once every 2 minutes and only when there is new output. It is never sent to the Master.
- Transient failures resume on their own. When every model in a Worker's chain is temporarily unavailable (network down, overloaded, rate-limited, or a quota window with a reset time), the Worker pauses instead of failing, and resumes in the same session at the reset time; without a reset time it retries after 1, 5, then every 15 minutes. The Master gets one notice saying until when and why, without being woken, and later only the run's final result. A review cut short by a 429 in a reviewer or in the repair turn pauses and starts again the same way, so its obligation is not left hanging. When the Master's own turn fails on a transient error while it still holds unhandled Worker events, it is woken again on the same schedule. Auth errors, bad parameters and unknown models still fail right away. Paused Workers show "Paused until HH:MM" in the activity list, survive reloads and resume once; send, review, interrupt or ack cancels the pending resume. "Model switched" notices no longer wake the Master. Bun's "Unable to connect" network errors count as transient, and a chain whose models are all cooling down no longer retries the same cooling model in a loop inside one turn.
- When a cheap role's handback fails acceptance twice or its evidence contradicts itself, the Master reassigns the work to the deep-reading role instead of letting it try a third time. Workers give a reason for every existing test or assertion they weaken or delete, and the Master's final review checks those reasons hold.
- The Master routes work by its shape instead of by how long it would take: search, locating unknown code, long logs and data go to the read-only research role; specified mechanical work and scripts to the mechanical-work role; bounded ordinary implementation to the ordinary-implementation role; hard problems and final integration to the deep-reading role. It does a known read, one command or one deterministic script itself, sends independent research angles out together (usually 2–4), tries one sample before sharding batch mechanical work, and uses Workers' evidence instead of redoing their exploration. Read-only research hands back conclusions with path:line or URL quotes, the scope searched and what stays unconfirmed, in about 20 lines, with longer material in a file. The template's role `use` texts follow these four kinds.
- `sleep` longer than 30 seconds, or whose length cannot be worked out, is blocked before bash runs it, in the main session, in Workers and in bash calls inside codemode scripts. The model is told how to wait instead: `until <condition>; do sleep 10; done` with an overall timeout, or wait in the foreground for the background job to finish.
- When a reviewer seat's output format is invalid, the next model in its chain re-reviews within the same round. Within one review, later rounds try the model that gave the previous round's verdict first, with the rest of the chain behind it as fallbacks; a new review starts from the first choice again. A review left incomplete because the reviewers themselves failed says in its final state that this is not a code problem and suggests re-reviewing with another model or having the Master review it.
- When a Worker's running turn produces no output for a long time (30 minutes by default), the Master is woken with the command being run and how long the run has taken. The activity list's stuck mark uses the same limit.
- The review wrap-up drops its numbered sections: it lists only the suggestions it recommends acting on and the items needing a user decision, within a length limit.
- When a ticket going to review changes a state machine (persistence, concurrency, retries, recovery, delivery), the Master also dispatches a read-only audit of that whole state machine: rebuild the states and transitions from flags and callbacks, walk every event order, reproduce each suspicion in real code. It waits for the audit before ack. The template gives this to the `junior` role; in your own config, add "state-machine audits" to the `use` of the role you want doing it.
- The Master sends only costly, hard-to-test work to review (persistence and crash recovery, concurrency and state machines, migrations and releases, data deletion, billing, auth and security), reviews each ticket once when its code is complete, and does its final diff review while the review runs instead of after it. Small fixes after a pass are read by the Master, not reviewed again.
- Workers wait for CI, deployments and other external state with one conditional loop that returns as soon as the state changes, instead of sleeping for minutes between checks.
- The Worker prompt carries its own implementation contract (acceptance written as runnable checks, implement, run every check, commit with explicit paths, no push) instead of asking Workers to read an `implement` skill that only existed on the maintainer's machine. Handbacks list each criterion's result, failures and gaps, without commands and exit codes. Workers write only inside their checkout and the system temp directory, and wait for their own background processes to finish before handing back.
- The Master closes implementation Workers once their work is delivered and verified, instead of keeping them until you have tried the change; only Workers whose UI or interaction changes you need to see for yourself stay until you confirm.
- The Master no longer restates global principles and skills in delegations, lists an acceptance matrix (screenshots, interaction paths, reference datasets) for UI, interaction and data work, splits batches of similar work across 2–3 Workers by file ownership, and hands integration to one Worker or the project's merge entry point. When a review ends incomplete because the reviewers themselves failed, it reviews the diff itself and tells the user which model failed instead of re-dispatching, it only dogfoods UI and interaction changes (non-UI changes that went to review are not dogfooded), and it does not write sleep loops to watch other sessions.

### Fixed

- Workers now compact at the threshold Pi's settings give the model they are actually running on. A Worker's session model is FireCode's routing model, so a `compaction.modelOverrides` entry for, say, `anthropic/claude-opus-5-5` never matched and Workers fell back to the default reserve: a Claude Worker with a 1M window and a 650k reserve compacted near 950k instead of 350k. Reserve and keep-recent tokens now follow the routed model, also after the chain switches models, for automatic compaction, `/compact` and idle compaction. Settings still live only in Pi's `settings.json`.
- A review no longer settles on someone else's turn. When another extension sent a message while a turn was wrapping up, Pi ran that extension's turn first, and the review took it for its own repair or summary turn: the summary was skipped and the review settled early, or the next review round started before the repair feedback had been delivered. A plugin message now counts as delivered only when that exact message enters a turn.
- If writing a review round failed, the review was cancelled but its saved state still counted the unwritten round, so reopening the session reported the review record as corrupt. The saved state now counts only the rounds actually written.
- A review that had already passed, been stopped by the advisor or run out of rounds is no longer recorded as cancelled when its saved state is closed without it: after you turn `/fire-review` off and restart, or after a failed write. Before, the Master read such a review as cancelled; it now keeps the verdict, as cancelling during the summary already did.
- `/fire-review --cancel` during the review's wrap-up summary used to do nothing visible. It now says that the review stopped waiting for the summary and that its verdict stands; the verdict is not changed to cancelled.
- A Worker's automatic resume after a pause now holds in three more cases: an `ack` sent while the resume is being prepared cancels it instead of the resume starting anyway; the Master is told "paused" once per run, also across reloads; and a reset time more than about 24.8 days away no longer makes the resume fire at once and loop. The Master's own wake-up after a transient failure had the same timer overflow and is fixed too.
- A Worker that resumes after a pause longer than the stall limit (30 minutes by default) is no longer reported as stalled the moment it resumes; silence is counted from the start of the resumed turn.
- Review: when a reviewer seat had no usable verdict in an intermediate round, the next round now still starts from the model that last gave it a verdict, instead of retrying an invalid-format first choice again.
- Claude image uploads: when Anthropic keeps reporting an uploaded file as missing, FireCode now re-uploads and retries at most once per turn instead of looping.
- Idle compaction now respects Pi's `compaction.enabled` setting: with compaction turned off, FireCode no longer prepares or applies an idle summary, so your full context is kept.
- A retry after "model chain exhausted" no longer hands the request back to a model that is still cooling down; the turn ends as paused until a model recovers.
- A failed write of the Worker state file no longer leaves memory and disk out of sync. It is reported, instead of silently losing a Worker's result or making `kill` look like it worked.
- Reloading again before a Worker interrupted by a reload was resumed no longer loses the reminder to resume it. If the reminder cannot be saved to the session, it is sent again after the next reload.
- The 15-Worker concurrency limit now also applies to `send` and `review` on idle Workers.
- Sending to, or auto-resuming, a Worker whose idle session is still shutting down now waits for the shutdown instead of failing with "already held by an in-process session".
- Subagent results and review feedback delivered while the main turn is running are no longer lost when you press Esc, and no longer sit unseen until your next message when the turn is aborted (including by `/compact`). A message counts as delivered only once it actually enters a turn, and FireCode wakes the agent itself if the turn ended first.

## [1.8.0] - 2026-11-05

### Changed

- **Breaking:** Model settings for roles, reviewers, the advisor and watcher now accept an atom or ordered array. Remove role `fallback` fields and reviewer `{ model, fallback }` objects. Provider prefixes are optional.
- **Breaking:** Pi 1.5.0 or later is required. Tool schemas import TypeBox from `typebox`, which Pi provides to extensions, instead of the re-export Pi 1.5 dropped from `@earendil-works/pi-ai`.
- Master Workers use codemode again when the Master session has it on. Each subsession with codemode raises Pi's process-wide codemode worker limit (`PI_CODEMODE_MAX_WORKERS`) by two while it lives, so Workers running long scripts never take the slots the Master needs; the variable returns to its original value once they are released.
- **Breaking:** Review checkpoints use a new format; after upgrading, restart any review that was in progress with `/fire-review`.
- `/fire-review` reviewers score every finding with the condition that triggers it, a frequency (0–10) and an impact (1–10) instead of High/Medium/Low. Only findings with frequency × impact ≥ 20, or frequency ≥ 1 and impact ≥ 8, send the work back for a repair round; findings below that, or whose condition cannot be stated, are listed as suggestions in the result card and the wrap-up. Conflicts in the request itself are listed under "Needs user decision" instead of being fixed. Reviewers read the ticket or document a pointer-only request refers to, and the advisor now sees the original request.
- `/fire-review` reviewers reproduce a finding when they can and quote the command and its output; otherwise they give the trigger path. From round 2 a review re-runs the earlier findings' commands and checks the repair for regressions instead of re-auditing the whole task, and the wrap-up names finding patterns worth turning into a lint rule or type check. The template's `review.maxRounds` is now 3.
- When a reviewer seat's first-choice model is unavailable and a later candidate in its chain does the review, the result card and the Master's review event name that model and mark it as a fallback. The template's reviewer chain now ends with `claude-opus-5-5/low` instead of `claude-sonnet-5-5/low`.

### Fixed

- Prompts are read once when FireCode loads, so a running session keeps the prompts that match the code it loaded. Before, updating FireCode's files while Pi was running (`pi update`, or `git pull` on a source install) paired the old code with the new prompts on disk. **After upgrading to this release, restart Pi sessions that were already running:** they still run the old review parser, and with the new review prompt every review fails with "first line must be PASS or FAIL".
- A Claude subscription limit such as "You've hit your 5-hour limit · resets 5:10am (Asia/Singapore)" now cools the model down until that time instead of for 5 minutes, so the next task no longer hits the same limit again.
- A model switch reported to the Master no longer carries the failure reason of an earlier task.
- `/fire-review` waits for a repair or summary turn to settle after automatic retries and continuations, so a transient provider error no longer cancels the review. A final repair error or feedback delivery failure is reported to the Master with its original message.

## [1.7.0] - 2026-10-29

### Changed

- **Breaking:** native compaction checkpoints use a new format. Older native checkpoints are not replayed or migrated automatically. Before upgrading an existing compacted session, back up the complete session file and export its active branch. Returning with `/tree` to before its earliest native checkpoint restores only earlier context; later messages stay on the old branch and in the backup and must be brought back before continuing. Incompatible checkpoints now stop requests and compaction instead of silently omitting history.

### Fixed

- Native compaction follows Pi's projected summary boundary, so edited or deleted messages do not return and the recent tail stays under Pi's control. The server compaction item replaces the extra local retention algorithm.
- Native compaction no longer limits generation to 16 tokens, which could truncate the compaction itself. Incomplete responses are rejected; if a later native compaction fails, its existing history is preserved instead of being replaced by an ordinary summary of a placeholder. Each checkpoint has a distinct identity.
- A Worker's truncated response is reported as a failure, and a review ending at the output limit cannot pass even if its partial text begins with PASS.
- Image file IDs sent to Claude now belong to the account that uploaded them. After switching to another Claude account, or between a subscription and an API key, every request in a session with images failed with 404 "File `file_…` not found", because IDs uploaded under the old account were reused; the images are now uploaded once more under the new account. If a file is gone within the same account (for example deleted), it is uploaded again and the turn is retried automatically instead of the session breaking.

## [1.6.0] - 2026-10-16

### Changed

- **Breaking:** FireCode now requires Pi 1.3.0 or later.
- Master Workers no longer use codemode, even when the Master session has it on. Pi 1.3.0 lets at most two codemode scripts run at once across all sessions in a process, and a script keeps its slot while it waits for a tool. Workers run in the Master's process, so two Workers running long commands left a Master in codemode `only` mode unable to call any tool, including interrupting them. Workers now call their tools directly and can still run them in parallel.

### Fixed

- OpenAI native compaction no longer drops its window on OpenAI GPT-6 models used with an API key and a thinking level. Pi 1.3.0 marks each reply's thinking level in these requests, the replay no longer matched, and history from before the compaction was left out of the context.
- A `read` call whose omitted arguments arrive as `null` showed a wrong line range such as `:10-9`; it now shows `:10+`.
- OpenAI native compaction works when OpenAI is signed in with a ChatGPT subscription ("Sign in with ChatGPT"). `/compact` failed with HTTP 400 because that login rejects the `compaction_trigger` input item; compaction now uses server-side compaction (`context_management`), which API keys, Codex and ChatGPT subscriptions all accept.
- An automatic compaction whose native compaction fails now falls back to an ordinary summary with a warning, the same as after a model switch. It used to be cancelled, so it failed again every turn and, once the context was full, the overflow recovery was cancelled too and the session could not continue. A manual `/compact` is still cancelled with the reason.

## [1.5.0] - 2026-10-14

### Changed

- `/fire-review` passes only when every reviewer returns PASS. A reviewer that gives no verdict (error, expired login, timeout, empty output) used to be skipped, so the other reviewer's PASS was enough; now the review stops as failed and the result names the model and the reason.

### Added

- A reviewer can have a fallback chain: write `{ "model": "…", "fallback": ["…"] }` in `review.reviewers` (up to 2 fallback models, same as Master roles). When a reviewer gives no verdict, the next model in its chain reviews instead, and the result card says which model was replaced and why. Later rounds of the same review start from the model that gave the last verdict.
- A review left in progress by an earlier version is not resumed after the update; run `/fire-review` again.
- Images sent to Claude (screenshots, `read` results, pasted images) are uploaded once through the Files API and referenced by ID, instead of being resent inline with the whole history every turn. In an image-heavy session the request shrinks from megabytes to the text alone; image quality is unchanged and prompt cache and thinking stay valid. Turn it off with `"features": { "claudeFiles": false }`.

## [1.4.0] - 2026-10-13

### Changed

- **Breaking:** FireCode now requires Pi 1.2.0 or later.
- Master events, watcher suggestions and review prompts that wake an idle session are now extension messages instead of user messages, the same as when they arrive during a turn. `/fork` and the user-message filter of `/tree` list only what you typed, a wake-up is no longer rejected when the model has no API key (the turn starts and shows the error), and the event stays in the conversation. **Breaking:** in sessions recorded before this version, earlier wake-ups show as plain user messages.

### Fixed

- `tail` showed review feedback that reached a busy Worker as the Worker's own reply; FireCode's messages are now shown as input.

## [1.3.1] - 2026-10-12

### Changed

- A review checkpoint that can no longer be read is reported once, with the session it belongs to, instead of being silently dropped; run `/fire-review` again to restart that review.
- Native compaction now uses pi's public model interface instead of an internal entry point, so OpenAI-compatible setups with a custom `baseUrl` are called at the right address.
- 1.3.0 was never published to npm. From 1.3.1 on, GitHub Actions publishes the package to npm with a provenance attestation.
- For contributors: `bun run setup` fetches the pinned pi sources that tests and the type check need.

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

[Unreleased]: https://github.com/Suge8/firecode/compare/v1.11.0...HEAD
[1.11.0]: https://github.com/Suge8/firecode/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/Suge8/firecode/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/Suge8/firecode/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/Suge8/firecode/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Suge8/firecode/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Suge8/firecode/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Suge8/firecode/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Suge8/firecode/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Suge8/firecode/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Suge8/firecode/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Suge8/firecode/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Suge8/firecode/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Suge8/firecode/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Suge8/firecode/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/Suge8/firecode/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Suge8/firecode/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Suge8/firecode/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Suge8/firecode/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Suge8/firecode/compare/v0.8.1...v1.0.0
