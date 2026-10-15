# LyricGlance EGO Review Audit for 0.9.0

Audit date: 2026-08-23

Sources checked:

- [GNOME Extensions Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- [GNOME Extensions Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html)
- [GNOME Extension Translations](https://gjs.guide/extensions/development/translations.html)
- [GNOME Extension Anatomy](https://gjs.guide/extensions/overview/anatomy.html)
- [GNOME Shell 50 porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-50.html)

This document records the source and package audit. “PASS” means deterministic evidence exists in this checkout. The final live desktop gates are recorded separately in `EGO-CHECKLIST.md`, including owner acceptance based on practical use where a new instrumented run was not captured.

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
| Packaging and supported Shell versions | `metadata.json`, `make check`, packaged Shell tests | Runtime import/package checks pass; only Shell 50 is declared. Isolated Shell 50.5 testing does not establish Shell 49/51 support |

Clock read ordering and operation feedback are separate checks. Get/GetAll share a latest-request token, while only the corresponding actual Position/Seeked or PlaybackStatus notification can acknowledge a control operation. Invalidation removes that acknowledgement. Full snapshots retain newer Metadata/capability notifications using per-property versions. If a superseding read fails, the manager keeps its local clock rather than applying an obsolete reply or starting retries/polling.

Provider boundaries were also checked in code: an LRCLIB HTTP/JSON/transport error ends the lookup rather than triggering LrcAPI, while an available cached plain result is retained. Candidate credibility is a matching heuristic; missing duration can still permit a candidate, so recording-version accuracy is not guaranteed. These are current behavior and limitations, not newly verified public-service availability.

Reproduction tests first failed on the previous behavior before the fixes. Verification commands are `make check`, `make integration` and the packaged headless Shell command in the README. The Shell test operates in an isolated session with controlled player data. Physical gestures, current desktop third-party clipping, live public-provider hit rate, online release success and a fresh post-install desktop soak remain separate evidence gates; see `EGO-CHECKLIST.md`.

| Requirement | Current status | Action needed | Evidence |
|---|---|---|---|
| Metadata is valid JSON and contains UUID/name/description/URL | PASS | None | `metadata.json`; packaged Shell metadata assertion |
| Supported Shell versions are honest | PASS | Keep only `50` until separately tested | `shell-version: ["50"]`; compatibility matrix |
| Deprecated metadata `version` is absent | PASS | Let EGO manage submitted revisions | Metadata/package assertions |
| Gettext domain and compiled locale are packaged | PASS | Maintain POT/PO on string changes | `po/`, `locale/zh_CN/...mo`, English/Chinese Shell and prefs tests |
| No module-scope runtime objects, signals, or timers | PASS | None | Entry-point audit; resources created during `enable()`/window fill |
| Disable destroys all extension-owned objects | PASS | Complete live post-login soak | Three-cycle packaged Shell lifecycle test |
| Signals and D-Bus subscriptions are disconnected | PASS | None | Explicit IDs/owners in `extension.js`, `mpris.js`, `indicator.js` |
| GLib timeout and Meta later sources are removed | PASS | None | Explicit stop/remove methods plus lifecycle assertions |
| Async work is cancellable and stale-safe | PASS | None | `Gio.Cancellable`, request serial/generation, current-owner identity |
| Actors and Clutter transitions are destroyed/stopped | PASS | None | Indicator/artwork destroy paths and transition removal |
| No lifecycle `_enabled`/`_destroyed` boolean guards | PASS | None | Production source search returns no matches |
| No monkey patching or prototype modification | PASS | None | Static source audit |
| No subprocess, executable, or runtime script dependency | PASS | None | Static audit; no `Gio.Subprocess`; package contains JS/data only |
| Shell and Preferences libraries remain process-separated | PASS | None | Shell uses St/Clutter; prefs uses GTK4/Libadwaita |
| Networking is asynchronous, bounded, and cancellable | PASS | None | Local HTTP tests for success, 429, timeout/cancel, malformed and oversized responses |
| Credentials avoid settings/cache/log/source | PASS | None | `credentials.js`; secret-pattern audit; Secret Service CRUD/cleanup test passed |
| Filesystem access is namespaced and bounded | PASS | None | XDG paths, atomic replace, safe-miss corruption tests, bounded caches |
| Bundled libraries are readable and attributed | PASS | None | Unmodified js-yaml 4.1.0 ESM, upstream/version/hashes/MIT/reproduction notes |
| Project license is EGO-compatible and packaged | PASS | None | GPL-2.0-or-later `LICENSE`; package content check |
| Preferences uses GSettings schema conventions | PASS | None | Strict schema compile and GTK window test |
| Stylesheet is theme-derived and package-owned | PASS | None | `stylesheet.css`; no bundled theme or hard-coded light/dark palette |
| Private Shell API is minimized | RISK ACCEPTED | Re-test for every new Shell major | Three panel box fields centralized in `_panelBox()`; no public GNOME 50 equivalent |
| `session-modes` does not enable user extensions at login/lock | PASS | None | No `session-modes` field |
| Package excludes development-only files | PASS | None | `tools/check-package.sh`; zip contains runtime, schema, MO and licenses only |
| Logging is contextual and not excessive | PASS | Re-check live soak journal | No lyrics/key/header logging; expected network failures use bounded warnings |
| AI-assisted code is understandable and maintainable | PASS | Author review remains required | Removed redundant identity lifecycle booleans and no new abstraction layer |

## Private API decision

GNOME Shell 50 exposes `Main.panel.addToStatusArea()` for initial placement but no public API that moves one existing indicator between the left, center, and right panel boxes while preserving all five configured positions. The extension therefore keeps exactly three private-field reads in one compatibility function. Reaching into more internals, reconstructing the indicator, or monkey-patching Shell would be riskier.

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
