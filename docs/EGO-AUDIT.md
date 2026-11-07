# LyricGlance EGO Review Audit for 0.9.0

Initial audit: 2026-08-23. Latest source/package recheck: 2026-11-07.

Sources checked:

- [GNOME Extensions Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- [GNOME Extensions Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html)
- [GNOME Extension Translations](https://gjs.guide/extensions/development/translations.html)
- [GNOME Extension Anatomy](https://gjs.guide/extensions/overview/anatomy.html)
- [GNOME Shell 50 porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)
- [GNOME Shell 51 porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-51.html)

This document retains dated source and package audits. “PASS” refers to the recorded checkout and date, not automatic verification of later changes. Current automated results and remaining live desktop gates are tracked in [EGO-CHECKLIST.md](EGO-CHECKLIST.md); runtime behavior and test entry points are documented in the [README](../README.md).

## Source and behavior recheck — 2026-10-15

The previous August audit below is historical. This recheck follows the current implementation and executable regressions rather than treating the README or completed historical checklist as evidence.

| Claim rechecked | Source and executable evidence | Result and boundary |
|---|---|---|
| Actual width controls scrolling | `indicator.js` allocation-box caches feed line/word/page/fade/title geometry; `tests/shell-extension.js` applies real external panel constraints | PASS in isolated Shell: 298→85 px text viewport, full ending, fitting-to-overflow-to-fitting, unchanged-allocation width/icon settings |
| Timing, word follow and reduced motion | `extension.js`, `lyrics-synchronizer.js`, `ui-utils.js`; UI logic and packaged Shell regressions | PASS for explicit endings, overlaps, missing final-word ends, offsets, pause/seek/hover, title cycles and native animation inhibition/restoration. Explicit ends control scrolling, not automatic removal of the selected line |
| Timed lyrics outrank plain/absent lyrics | `lyrics.js`, `lyrics-normalizer.js`, `lyrics-document.js`; local HTTP/parser tests | Fixed blank-only plain text and timestamp-only LRC/Lyricsfile being treated as usable lyrics. Meaningful blank lines remain intact; explicit instrumental results remain authoritative |
| Failed fallback stays retryable | `lyrics.js`, `storage.js`; HTTP regression recreates the provider after an empty fallback and a simulated legacy negative entry | Fixed legacy negative entries blocking enabled fallback lookup. Configuration signatures still prevent cross-provider reuse; they are not separate physical cache directories |
| Media operations and one-shot reconciliation | `mpris.js`; isolated D-Bus fixture in `tests/integration-mpris-events.js` | Fixed capability/volume notifications suppressing control readback or invalidating Position replies. Newer property notifications survive older full snapshots; query ordering, invalidation, opposite status reports and newer Seeked anchors have explicit assertions |
| Lifecycle and absence of position polling | `extension.js`, `indicator.js`, `mpris.js`; event and packaged Shell tests | PASS for owner/track guards, drag cancellation, popup timer removal and repeated disable. Popup progress uses the local clock; command/property reconciliation remains event driven |
| Translation and credential handling | `credentials.js`, `translation-provider.js`, `translation-service.js`; unit/local HTTP integration tests | Source confirms Secret Service storage and sanitized credential errors; translation HTTP/error/cancellation tests pass. No real credential or external translation provider was exercised in this recheck |
| Date releases and uploaded ZIP/checksum | `.github/workflows/release.yml`, `Makefile`, `tools/check-package.sh` | Actual workflow date guard passes six valid/invalid date cases, including leap days. Check/build/upload dependencies are present; no GitHub release was created or remotely verified |
| Packaging and supported Shell versions | `metadata.json`, `make check`, packaged Shell tests | Both Shell 50 and 51 are now declared. Historical Shell 50 results and isolated Shell 51.1 evidence are separated in `compatibility.md`; remote CI execution and fresh desktop validation remain separate gates |

Clock read ordering and operation feedback are separate checks. Get/GetAll share a latest-request token, while only the corresponding actual Position/Seeked or PlaybackStatus notification can acknowledge a control operation. Invalidation removes that acknowledgement. Full snapshots retain newer Metadata/capability notifications using per-property versions. If a superseding read fails, the manager keeps its local clock rather than applying an obsolete reply or starting retries/polling.

Provider boundaries were also checked in code: an LRCLIB HTTP/JSON/transport error ends the lookup rather than triggering LrcAPI, while an available cached plain result is retained. Candidate credibility is a matching heuristic; missing duration can still permit a candidate, so recording-version accuracy is not guaranteed. These are current behavior and limitations, not newly verified public-service availability.

Reproduction tests first failed on the previous behavior before the fixes. Verification commands are `make check`, `make integration` and the packaged headless Shell command in the README. The Shell test operates in an isolated session with controlled player data. Physical gestures, current desktop third-party clipping, live public-provider hit rate, online release success and a fresh post-install desktop soak remain separate evidence gates; see `EGO-CHECKLIST.md`.

| Requirement | Current status | Action needed | Evidence |
|---|---|---|---|
| Metadata is valid JSON and contains UUID/name/description/URL | PASS | None | `metadata.json`; packaged Shell metadata assertion |
| Supported Shell versions are honest | PASS | Re-test both declared versions for compatibility changes | `shell-version: ["50", "51"]`; compatibility matrix and CI matrix |
| Deprecated metadata `version` is absent | PASS | Let EGO manage submitted revisions | Metadata/package assertions |
| Gettext domain and compiled locale are packaged | PASS | Maintain POT/PO on string changes | `po/`, `locale/zh_CN/...mo`, English/Chinese Shell and prefs tests |
| No module-scope runtime objects, signals, or timers | PASS | None | Entry-point audit; resources created during `enable()`/window fill |
| Disable destroys all extension-owned objects | PASS | Complete live post-login soak | Three-cycle packaged Shell lifecycle test |
| Signals and D-Bus subscriptions are disconnected | PASS | None | Explicit IDs/owners in `extension.js`, `mpris.js`, `indicator.js` |
| GLib timeout and Meta later sources are removed | PASS | None | Explicit stop/remove methods plus lifecycle assertions |
| Async work is cancellable and stale-safe | PASS | None | `Gio.Cancellable`, request serial/generation, current-owner identity |
| Actors and Clutter transitions are destroyed/stopped | PASS | None | Indicator/artwork destroy paths and transition removal |
| No lifecycle `_enabled`/`_destroyed` boolean guards | PASS | None | Production source search returns no matches |
| No Shell monkey patching | PASS | Keep GJS async wrappers centralized | `io-promisify.js` only applies `Gio._promisify()` to native async methods; no Shell method replacement |
| No subprocess, executable, or runtime script dependency | PASS | None | Static audit; no `Gio.Subprocess`; package contains JS/data only |
| Shell and Preferences libraries remain process-separated | PASS | None | Shell uses St/Clutter; prefs uses GTK4/Libadwaita |
| Networking is asynchronous, bounded, and cancellable | PASS | None | Local HTTP tests for success, 429, timeout/cancel, malformed and oversized responses |
| Credentials avoid settings/cache/log/source | PASS | None | `credentials.js`; secret-pattern audit; Secret Service CRUD/cleanup test passed |
| Filesystem access is namespaced and bounded | PASS | None | XDG paths, atomic replace, safe-miss corruption tests, bounded caches |
| Bundled libraries are readable and attributed | PASS | Keep reproduction scripts and source notes current | js-yaml 4.1.1 and franc-min 6.2.0 ESM; complete licenses in ZIP; versions, hashes and reproduction scripts in source. franc dictionary expansion is lazy |
| Project license is EGO-compatible and packaged | PASS | None | GPL-2.0-or-later `LICENSE`; package content check |
| Preferences uses GSettings schema conventions | PASS | None | Strict schema compile and GTK window test |
| Stylesheet is theme-derived and package-owned | PASS | None | `stylesheet.css`; no bundled theme or hard-coded light/dark palette |
| Private Shell API is minimized | RISK ACCEPTED | Re-test for every new Shell major | Three panel box reads in `_panelBox()` and the Slider `_unsnappedValue` write in `PlaybackProgressView._renderProgress()`; no equivalent public operations in Shell 50/51 |
| `session-modes` does not enable user extensions at login/lock | PASS | None | No `session-modes` field |
| Package excludes development-only files | PASS | None | `tools/check-package.sh`; zip contains runtime, schema, MO and licenses only |
| Logging is contextual and not excessive | PASS | Re-check live soak journal | No lyrics/key/header logging; expected provider failures use debug diagnostics, while local configuration, size-limit and disk-write failures retain warnings |
| AI-assisted code is understandable and maintainable | PASS | Author review remains required | Removed redundant identity lifecycle booleans and no new abstraction layer |

## Private API decision

GNOME Shell 50 and 51 expose `Main.panel.addToStatusArea()` for initial placement but no public API that moves one existing indicator between the left, center, and right panel boxes while preserving all five configured positions. Three panel-box reads remain centralized in `_panelBox()`. A fourth access writes `this._slider._unsnappedValue = null` in `PlaybackProgressView._renderProgress()`, resetting the native Slider's retained input origin when playback-clock updates move the slider. Native keyboard/scroll tests cover that reset; physical pointer input remains a separate check. These are the four intentional private Shell accesses to disclose in Reviewer Notes.

## Static analysis and Reviewer Notes — 2026-11-06

`make check` includes `make shexli-check`, which runs the unmodified official CLI
on the release ZIP. Local, CI and release installations pin the official
[GNOME source commit `56e6799`](https://github.com/GNOME/extensions-web/tree/56e6799ac01e39c0b31d83d350a8b4c15326efd8/shexli),
Python 3.14, `tree-sitter==0.25.2` and `tree-sitter-javascript==0.25.0`.
The 0.26.0 parser crashed during full-package analysis; the pinned combination
completed repeated scans. These are development-only dependencies.

The upstream source package still labels itself 0.2.1, so the commit pin is
essential: the [PyPI 0.2.1 release](https://pypi.org/project/shexli/0.2.1/) predates
its metadata fix. Both CLIs return 0 even when findings contain errors. The Make
target preserves all diagnostics without suppressions and produces an advisory
review report. The current ZIP reports **zero errors and zero warnings** with
the pinned upstream source. All four earlier findings were addressed:

| Rule | Earlier report | Resolution |
|---|---|---|
| EGO-M-004 | Error for declared Shell 51 | The official [upstream fix `d959a97`](https://github.com/GNOME/extensions-web/commit/d959a9707bb41414e6a7a552be1b05db233a8382) replaces the hard-coded maximum of 50 with a release-calendar calculation. The pinned source includes that fix; metadata continues to declare both 50 and 51 |
| EGO-A-004 | Nine warning/logging sites in `lyrics.js` | Routine upstream HTTP, transport and response-format failures retain their messages as `console.debug()` and still report unavailable to the UI. Invalid configuration/request construction, response-size violations and disk-write failures retain warnings. `G_MESSAGES_DEBUG=Gjs-Console` exposes debug diagnostics without a new setting or logging wrapper |
| EGO-L-002 | Progress container/time-label cleanup was implicit in the outer actor tree | `PlaybackProgressView.destroy()` now explicitly destroys its retained labels and its own root actor, which destroys the Slider and remaining children. The view can release its native resources before its parent is destroyed |
| EGO-L-003 | Three Slider handlers lacked explicit cleanup | The Slider handlers use `connectObject()` with the progress root actor as owner; `destroy()` calls `disconnectObject()` before destroying the native actors |

Local verification passed: `make check`, `make integration`, `make shell-check`,
and the GTK Preferences test in an isolated Shell session. The GTK test emits a
valid close request before closing again, exercises cancellation and reopening,
and produced no repeated-disconnect warning. The packaged Shell regression also
verifies that destroying the progress view destroys its root, Slider and both
labels before destroying the surrounding indicator, then safely repeats cleanup
through the parent and completes the pending seek. Workflow YAML and command syntax
checks passed; removing `io-promisify.js` from a temporary ZIP is rejected by
the package import check.

The pinned analyzer has compatibility rules for Shell 49/50, but no Shell 51 API
rules. It emits no `Shell.GLSLEffect` warning; that absence does not validate the
51 branch. `PanelEdgeFade` selects `Shell.GLSLEffect` with its legacy pipeline
hook when available, otherwise `Clutter.ShaderEffect` with the 51 snippet hook.
Keep this feature check visible and disclose both paths in Reviewer Notes;
the runtime evidence and its limits are in [compatibility.md](compatibility.md).

Preferences performs no synchronous settings flush. The deterministic GTK test
flushes settings after its application loop exits. The window's close handler
saves valid pending backend fields, discards invalid drafts without blocking
closure, cancels work, disconnects settings handlers
and clears their ID list. Shared native async wrappers live only in
`io-promisify.js`, statically imported through the storage/network paths; it creates no GI
instances or main-loop sources.

Disk-cache and offset read tests count actual writes: no access-time rewrite
through twelve hours, one after that boundary, and immediate persistence of
changed offset values. Translation tests cover a twenty-entry memory LRU,
cache-only hits, refresh/clear, track identity and cancellation during delayed
disk reads/writes. Shell tests bound ordinary lyric styling to the two five-row
neighborhoods, retain full refresh on entering/leaving no selection, stop progress
sources while paused and cover paused seeks and UTF-8 geometry.

The packaged presentation and GTK Preferences entry points now have Make
targets and run in both CI and release workflows. Each UI test copies its ZIP
under a unique runtime directory that is removed on exit. `network-utils.js`
centralizes the HTTP User-Agent/version and bounded stream loop while retaining
caller-specific status, truncation and empty-body rules. `shell-ui-utils.js`
shares native Shell animation/icon helpers without adding St to the prefs graph.

The ZIP excludes tests and dependency READMEs while retaining all LICENSE files.
Reproduction inputs, hashes and scripts stay in `README.franc.md`,
`README.js-yaml.md` and `tools/update-*.sh` in the public source repository.
The three panel-box reads and Slider private-state write described above are
also intentional Reviewer Notes disclosures. No EGO submission or remote CI run
was performed as part of this local review.

## Full source follow-up — 2026-11-07

The follow-up covered all runtime modules, tests, stylesheet/schema, build and
release scripts, dependency reproduction and documentation. It found and fixed
four additional boundary failures:

- Translation retry cancellation disconnected its own active `Gio.Cancellable`
  callback, which can deadlock. Cleanup now runs after that callback returns;
  the local HTTP regression cancels during an actual 429 backoff and checks that
  the timeout is removed without making another request.
- Closing Preferences during credential lookup could later open its Configure
  dialog. The continuation checks cancellation before constructing the dialog;
  the GTK regression closes the window before resolving the lookup.
- A lyrics-cache read completing after destruction could start a timestamp
  write with a released cancellation token. The cache retains its cancelled
  token and checks cancellation after the read; a real-file regression verifies
  that the stored access time remains unchanged.
- Large external lyric timestamps could exceed native timeout/animation integer
  limits. Line, word and panel scheduling and native pan delays/durations are
  bounded. The packaged Shell regression checks 5-billion-ms boundaries and a
  30-billion-ms current word, including source/transition removal.

The readable upstream js-yaml distribution was updated from 4.1.0 to 4.1.1,
including its upstream prototype-pollution fix. The runtime already uses
`JSON_SCHEMA` and rejects anchors/aliases, so this is not evidence that the
application's parser exposed the vulnerable merge path. Both vendored libraries
and licenses reproduce byte-for-byte with `tools/update-*.sh`; pinned versions
and hashes remain in their dependency READMEs.

The presentation test now waits up to ten seconds for the indicator to exist
instead of assuming startup completes in 700 ms; its original assertion and
layout checks remain intact. The old fixed wait failed during a concurrent UI
run while the main Shell and Preferences regressions passed.

Final verification passed: `make check`, all six `make integration` entry
points, packaged Shell lifecycle/timing, popup presentation and GTK Preferences
targets. The final ZIP has zero pinned-shexli findings; all 34 installed files
and the compiled schema match. The installation checksum and fresh-session
boundary are recorded in [EGO-CHECKLIST.md](EGO-CHECKLIST.md). No new runtime
dependency, file or abstraction was introduced by this follow-up audit.

## Maintainability notes

The lifecycle can be explained as:

```text
enable
  → settings + owner objects
  → MPRIS signals
  → lyrics/translation/artwork requests
  → one-shot synchronization sources and actors

disable
  → cancel requests
  → remove sources and transitions
  → disconnect signals/subscriptions
  → destroy actors and owners
  → release references
```

The remaining complex state is product-essential: current playback identity, lyrics document, translation document, effective offset, and one-shot line/word scheduling. It was not replaced with a new framework during hardening.
