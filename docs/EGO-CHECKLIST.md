# LyricGlance EGO Submission Checklist — 0.9.0

Last updated: 2026-09-23

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
