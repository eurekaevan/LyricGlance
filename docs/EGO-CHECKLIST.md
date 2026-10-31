# LyricGlance EGO Submission Checklist — 0.9.0

Last updated: 2026-10-31

The baseline checklists and August/September evidence below are historical records. Their completed boxes do not imply that later changes have passed a new live desktop test. Track the current scrolling changes separately here.

## Repository cleanup verification — 2026-10-31

- [x] inspected all production modules, tests, styles, build/release scripts, gettext manifests and documentation; removed only unconsumed internal methods, options, fields, exports and the unused gettext import/extraction entry
- [x] retained cache migration, test-used helpers, all seven lyric fixtures, native callbacks, dependency notices and historical verification records; no cache/schema format, user-facing behavior, dependency or file additions
- [x] `make check`, isolated local integration and the final packaged Shell regression pass on GNOME Shell 50.6
- [x] English/Simplified/Traditional Chinese × native dark/light themes × 100%/150% fonts × 720p/480p: all 24 presentation combinations pass; these runs and the main Shell regression have no allocation warnings
- [x] local Markdown targets, fixture references, vendored file/license hashes, gettext manifests, shell script syntax and `git diff --check` verified

The initial cleanup verification above used repository and isolated-runtime evidence. Installation and real-player follow-up are recorded separately below; no Secret Service credential, physical display/input or new desktop-session soak was exercised.

## Installation and real-player follow-up — 2026-10-31

- [x] installed the cleaned package locally; all 33 packaged files and the locally compiled schema match, and the desktop reports the extension enabled/ACTIVE
- [x] discovered the real Spotify player; playback, pause/resume and bidirectional seek synchronization pass, restoring the original paused state and approximately 29.8-second position
- [x] inspected the current desktop session's journal: no `needs an allocation` warning since its 12:30:20 start; LRCLIB TLS/503 failures are present
- [ ] lyric rendering/synchronization with a real song: the selected Bach track returned no lyrics, so this check remains open
- [ ] a fresh desktop session importing this package: the active Wayland session began before this installation; ACTIVE and matching files do not prove a new ESM import

No automatic logout or Shell restart was performed. The real-player tests exercise the checked-out code against the actual desktop MPRIS bus; they do not establish that the running desktop indicator has imported the newly installed code.

## Popup presentation and multilingual layout — 2026-10-30

- [x] native dark/light themes × 100%/150% fonts × 720p/480p × English/Simplified/Traditional Chinese: all 24 combinations pass the focused packaged presentation test
- [x] inherited normal current-line foreground, distinct disabled reset styling, aligned footer bounds, original/translation grouping, native edge fade and readable active text inside both scrolling viewports
- [x] actual offset glyph centering within one logical pixel across English/CJK units and Arabic/Hebrew RTL cases; no per-language positional correction
- [x] large-font title/artist/album do not overlap media controls; footer keyboard focus scrolls offscreen controls into view, closing ignores subsequent focus, and disabling disconnects the focus observer
- [x] `make check`, local integration checks and the full packaged Shell regression; focused runs have no allocation warnings

The new `tests/shell-presentation.js` retains these UI regressions independently of the larger playback test. Native layout measurements and isolated screenshots verify the fixture; custom desktop themes, physical mixed-DPI monitors and Dock interactions still require live desktop checks.

## Same-language translation guard — 2026-10-30

- [x] explicit language and ISO/locale aliases skip before provider, credential or cache access, including an unconfigured provider
- [x] unmarked English/Chinese/Japanese/French samples detected offline; short/repeated samples, mixed text and ambiguous rankings do not force a skip; different-language lyrics still translate
- [x] pinned readable franc-min bundle rebuilt identically twice and imported successfully in GJS; source archives, runtime licenses and build-tool checksums retained

Statistical detection can abstain or misclassify; fixture success does not establish accuracy for every song. No billable request is needed for language detection. The original lyrics remain the source of timing and displayed text.

## Parallel translation compatibility — 2026-10-30

- [x] three simultaneous unsupported-reasoning responses each retry once successfully; unrelated HTTP 400 does not disable reasoning for later requests
- [x] bounded error bodies distinguish 401, generic 403, explicit invalid keys and recognized quota/spending errors; quota failures do not retry, malformed/oversized 403 bodies retain safe access-denied classification
- [x] balancing covers 16×200 characters as 8+8, 381 short lines, mixed lengths, exact limits, intact oversized lines, stable order and neighboring context
- [x] reverse-order completion merges in original order; first failure cancels both active siblings promptly and preserves its status/reason without starting later batches

Limits remain 20 lines/3000 characters and three concurrent batches. Errors are parsed in memory up to 16 KiB; free-form provider text is never displayed or logged. SSE and partial-result publication/caching are not introduced. Automated local tests do not establish real-provider latency or quota mappings outside the recognized error codes.

## Translation transport diagnostics — 2026-10-30

- [x] native GLib error cases cover timeout, DNS, TLS, proxy, connection closed/refused and unknown failures; canceled requests retain their separate status
- [x] a delayed local HTTP response reproduces a one-second timeout without automatic retry; captured failure logs contain batch/size/time metadata and no test credential, endpoint, song title or lyrics
- [x] after increasing the default to 120 seconds, a local HTTP response delayed for 46 seconds succeeds with exactly one request, crossing the former 45-second limit
- [x] service results preserve the reason for the popup; packaged Shell verifies the specific timeout message, and the shared formatter is used by Preferences connection checks

The initial diagnostics retained the 45-second translation timeout. After a real request timed out at 45.125 seconds, the default was raised to 120 seconds; Preferences connection checks retain their explicit 15-second timeout. Batch limits and the HTTP 429 retry policy are unchanged. Real provider success with the longer timeout still needs a reproduction after the desktop Shell imports the updated code; no billable API request was made for these tests.

## Translation connection check — 2026-10-30

- [x] local HTTP contract checks: selected model/key, synthetic one-line input, 512-token output cap, invalid/empty responses, rejected credentials and cancellation before/during a request
- [x] packaged English/Simplified Chinese/Traditional Chinese Preferences: localized success/failure, entered model without saving, duplicate submission blocked, cancellation on edits/close
- [x] `make check`, `make integration` and full packaged Shell regression; existing translation HTTP authentication, redirect, size and 429 checks remain covered
- [ ] user-configured real endpoint/model/key check (no billable public API request was made during verification)

## Preferences and cache persistence — 2026-10-30

- [x] English/Simplified Chinese/Traditional Chinese Preferences: valid endpoint/model edits survive closing without Apply and reopening; invalid pending edits block closing and preserve saved values
- [x] isolated persistent GSettings backend: a separate process restores endpoint/model after the Preferences test exits
- [x] real Secret Service: a separate process reads a unique temporary credential, removed afterwards; the user's existing key was not changed or displayed
- [x] independent processes write and reload lyrics/translation caches; lyrics count tests cover positive/negative results, unrelated files, fresh instances and clear

The inspected desktop already had 448 lyrics cache files (413 positive, 35 negative). Translation had no files and the journal recorded authentication failures. This establishes a configuration/UI persistence problem and failed translation requests, rather than a reproduced cache-write failure. Real provider authentication still needs checking with the intended endpoint and key; no public translation request was made during this verification.

## Repository cleanup verification — 2026-10-24

- [x] removed unreferenced helpers, re-exports, state, build variables and one unused fixture; LRC boundary checks now exercise the runtime document/synchronizer chain
- [x] `make check`, `make integration` and the full packaged Shell regression pass; no `needs an allocation` warning in the normal Shell run
- [x] local Markdown links, relative module imports, retained fixture references, shell script syntax and `git diff --check` verified

This cleanup preserves runtime behavior and the preceding scrolling fixes. It adds no dependencies or new files. Real-player, public-service, physical-input and post-login soak tests were not repeated; their existing evidence boundaries below remain open.

## Text measurement verification — 2026-10-24

- [x] independent unconstrained Pango reference checks for fixed/minimum CSS widths, padding/borders, italic overhang, CJK, combining characters, emoji and RTL text; full drawing allocations and title-copy spacing are checked separately
- [x] packaged virtual-monitor checks at 100%, 125% and 200%, plus moving the indicator between 100%/125% monitors and across their boundary; fractional scaling uses the actor's actual resource scale
- [x] `make check`, `make integration` and the full packaged Shell regression; the normal Shell run emitted no `needs an allocation` warnings
- [x] installed locally; all 30 packaged files and the generated compiled schema match, extension reports enabled/active (this does not prove a fresh JavaScript import)
- [ ] fresh physical desktop login, display-scale changes and journal review for this package

The virtual-monitor probe verifies text geometry rather than physical display rendering. Monitor reconfiguration/reparenting emitted generic `ClutterActor` allocation warnings; the normal packaged regression is checked separately for extension actor warnings.

## Incremental runtime verification — through 2026-10-24

- [x] `make check`: schema, translations, pure logic, packaged contents and runtime imports
- [x] `make integration`: isolated D-Bus and local HTTP/storage contracts
- [x] packaged GNOME Shell 50.5 regression: explicit line/final-word ends, next-line overlap cap and track-end fallback
- [x] unknown final-word end does not borrow an earlier word's end; overlapping known endings retain the latest end
- [x] same-line resynchronization preserves the visible text and offset before deferred restart
- [x] font changes cancel/restart overflow correctly; lyrics received while hidden start after mapping
- [x] external panel compression uses the allocated text viewport for scroll endpoints; changing width/icon preferences with unchanged allocation restarts scrolling
- [x] a previously fitting paused lyric reveals its ending after external compression and becomes static again when space is released
- [x] title looping, close/reopen cleanup and panel hover catch-up regressions
- [x] single-direction seamless panel/popup title loops: matching copies, wrap continuity, pause/hover, font/width changes, reduced motion, clearing the track and returning to synchronized lyrics
- [x] native Shell animation inhibition/restoration; timed pages advance, pause, hover and handle forward/backward seeks
- [x] source recheck and failing-then-passing regressions for blank lyrics/legacy negative cache and unrelated MPRIS notifications during control reconciliation
- [x] local HTTP and packaged Shell regressions for song-change debounce, cross-track 429/503 cooldowns, bounded retries, unavailable versus missing status, retained plain lyrics and current-clock alignment of late results
- [x] English/Simplified Chinese packaged Shell and GTK preferences tests, localized timing controls, and rejection of missing/fuzzy/invalid-format translations or missing compiled catalogs
- [x] Traditional Chinese packaged Shell/GTK preferences tests and English fallback for an unsupported interface locale
- [x] final package installed locally; all 30 packaged files byte-match, including the Traditional Chinese catalog and the expected compiled schema
- [x] source diff has no whitespace errors
- [ ] fresh desktop session confirmed to load the latest installed package
- [ ] real desktop check of short/long repeated lyrics, title looping, font/display scaling and physical hover/seek gestures
- [ ] new 30–60 minute live soak and post-login journal review for recurring allocation warnings

The automated Shell run is isolated and uses controlled playback data. It does not establish the physical desktop or live provider behavior. Earlier real Spotify tests used cached lyrics and did not fully reproduce the reported desktop clipping. The owner's positive practical-use feedback preceded the latest timing/paging patch, so it does not close the remaining boxes above.

For the desktop check, log out/in after installing JavaScript, then compare short and long occurrences of the same lyric, pause/resume, seek both directions, hover/leave, close/reopen the popup, and change the configured width or font. With animations disabled, verify that panel lyrics change pages without sliding and that the title remains static. Inspect the journal from that login and distinguish LyricGlance messages from allocation warnings belonging to other actors; an unnamed actor hierarchy alone does not establish ownership.

## Deterministic and repository gates

- [x] metadata valid, concise, and contains project URL
- [x] only GNOME Shell 50 declared
- [x] deprecated metadata `version` removed
- [x] lifecycle/resource ownership audit completed
- [x] three repeated packaged enable/disable cycles pass
- [x] no secret or Authorization value in source/package/logging paths
- [x] gettext source structure and compiled locale package correctly
- [x] Shell UI verified in English and Simplified Chinese
- [x] Preferences verified in English and Simplified Chinese
- [x] bundled js-yaml version, upstream, modification status, MIT license, SHA-256 and reproduction documented
- [x] GPL-2.0-or-later project license included in repository and zip
- [x] `make check` passes
- [x] deterministic local integration suite passes
- [x] zip integrity, allowlist/denylist and runtime imports pass
- [x] CI uploads the package produced from the tested checkout
- [x] tag workflow attaches zip and SHA-256 without submitting to EGO
- [x] README installation, privacy, network, limitations and license sections complete
- [x] five privacy-safe release screenshots prepared
- [x] compatibility and GNOME 51 risk document present
- [x] focused changelog present
- [x] current EGO guideline audit recorded

## Final live desktop gates

- [x] install the final zip into a clean user extension directory and byte-compare packaged files
- [x] log out/in so GNOME Shell 50 fresh-imports the candidate ESM
- [x] open Preferences from the installed candidate in English and Simplified Chinese
- [x] verify upgrade preserves existing GSettings and leaves cache/config namespaces untouched
- [x] verify upgrade preserves an existing Secret Service credential
- [x] verify a fresh profile with no cache/offset/credential starts cleanly
- [x] verify Panel, Popup, Artwork, Progress, Lyrics, Word sync, Translation, Offset and Player select with a live MPRIS player
- [x] complete a 30–60 minute live soak including seek, track changes, popup, player switch, Firefox close/reopen and settings changes
- [x] inspect the post-soak user journal and record any warning/error
- [x] review final screenshots and repository diff for personal or secret data

## Live evidence recorded on 2026-08-23

- A unique temporary Secret Service sentinel survived `make install`, was verified through the production credential store, and was then removed. No real credential was read or changed.
- With the existing cache moved aside and the schema reset, the extension started from default settings, no credential, and no cache/config namespace, then discovered Firefox and populated one cache entry. The original cache and exact non-default settings were restored afterward.
- The live Shell verified all five panel positions, paused visibility, width changes, Popup, Artwork, advancing Progress, timed Lyrics, Offset controls and Firefox/controlled-player selection and fallback. The no-key Translation state failed gracefully. A live word-synced MPRIS track and a successful credential-backed translation are still missing from the compound UI gate.
- The pre-fix candidate completed 1,800 seconds of live monitoring: 60 heartbeats, 19 track changes, 4 player buses, 286 state events, 33 player-list events, 18 lyric loads, 57 synchronized samples and no player-unavailable event. Seek, pause/resume, A→B→A cache reuse, popup, settings and player fallback were exercised. The primary Firefox process was not force-closed; an independent temporary Firefox profile did not acquire a separate MPRIS owner, so the close/reopen part remains open.
- The journal exposed 191 extension-related allocation-warning bursts while a long panel lyric was panning and its width changed. The candidate now stops the transition before style invalidation and waits for the new allocation before restarting it; the packaged headless regression passes without that warning. Unrelated Dash-to-Dock allocation warnings were also present. At the time, the fixed ESM still needed a fresh real-session import and journal recheck; the 2026-09-23 evidence below closes that gate.

The installed files are the final zip contents plus the expected locally compiled `schemas/gschemas.compiled`. On 2026-09-23, the active Wayland session started after the 2026-09-13 install, so GNOME Shell loaded the installed JavaScript in a fresh process.

The candidate's final live desktop gates are closed below. This records the owner's practical-use acceptance; it does not retroactively claim that a separately instrumented soak was run during the 2026-09-23 inspection.

## Live evidence recorded on 2026-09-23

- The active Wayland session began at 12:15 local time, after the installed extension files were updated on 2026-09-13. GNOME Shell 50.5 reports the extension `ACTIVE`; this closes the fresh-session ESM import gate. The running Shell's journal since login contains no LyricGlance warning or critical entry.
- At inspection time, no MPRIS player owned a session bus name and no Firefox or Spotify player process was running, so playback and soak behavior could not be rechecked in that session.

## Owner acceptance recorded on 2026-09-23

- The owner confirmed that both remaining live-player gates had been exercised in practical use without encountering a significant problem and accepted them as complete. Both checklist items are therefore closed.
- This is user-reported real-use acceptance, not a newly captured playback trace or a separately timed 30–60 minute test. The inspection-time absence of a player above remains accurate.
