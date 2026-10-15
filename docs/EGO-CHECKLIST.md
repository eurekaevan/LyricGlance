# LyricGlance EGO Submission Checklist — 0.9.0

Last updated: 2026-10-15

The baseline checklists and August/September evidence below are historical records. Their completed boxes do not imply that later changes have passed a new live desktop test. Track the current scrolling changes separately here.

## Incremental scrolling verification — 2026-10-15

- [x] `make check`: schema, translations, pure logic, packaged contents and runtime imports
- [x] `make integration`: isolated D-Bus and local HTTP/storage contracts
- [x] packaged GNOME Shell 50.5 regression: explicit line/final-word ends, next-line overlap cap and track-end fallback
- [x] unknown final-word end does not borrow an earlier word's end; overlapping known endings retain the latest end
- [x] same-line resynchronization preserves the visible text and offset before deferred restart
- [x] font changes cancel/restart overflow correctly; lyrics received while hidden start after mapping
- [x] external panel compression uses the allocated text viewport for scroll endpoints; changing width/icon preferences with unchanged allocation restarts scrolling
- [x] a previously fitting paused lyric reveals its ending after external compression and becomes static again when space is released
- [x] title looping, close/reopen cleanup and panel hover catch-up regressions
- [x] no-lyrics/instrumental panel title loops: ending, return, repeated cycle, pause/hover, width change, reduced motion, clearing the track and returning to synchronized lyrics
- [x] native Shell animation inhibition/restoration; timed pages advance, pause, hover and handle forward/backward seeks
- [x] source recheck and failing-then-passing regressions for blank lyrics/legacy negative cache and unrelated MPRIS notifications during control reconciliation
- [x] local HTTP and packaged Shell regressions for song-change debounce, cross-track 429/503 cooldowns, bounded retries, unavailable versus missing status, retained plain lyrics and current-clock alignment of late results
- [x] English/Simplified Chinese packaged Shell and GTK preferences tests, localized timing controls, and rejection of missing/fuzzy/invalid-format translations or missing compiled catalogs
- [x] Traditional Chinese packaged Shell/GTK preferences tests and English fallback for an unsupported interface locale
- [x] final package installed locally; all 30 packaged files byte-match, including the Traditional Chinese catalog and the expected compiled schema
- [x] source diff has no whitespace errors
- [ ] fresh desktop session confirmed to load the final 2026-10-15 package
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
