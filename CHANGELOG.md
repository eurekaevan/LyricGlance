# Changelog

## Unreleased

### Added

- Offline language detection for unmarked lyrics skips translation only when sufficiently long, consistent samples confidently match the target language. Explicit source language takes precedence; uncertain and mixed-language text still reaches the configured translator.
- Translation transport failures now distinguish timeout, DNS, TLS, proxy and connection errors, with localized UI and safe batch/size/timing diagnostics that omit credentials and request contents.
- Translation settings can check the entered endpoint/model with the saved key using a small synthetic Responses API request, with localized outcomes and cancellation on edits or window close.
- Traditional Chinese (`zh_TW`) interface translations for the Shell popup and Preferences.
- Overflowing panel titles loop for tracks without lyrics and provider-marked instrumental tracks. Instrumental explanations remain in the popup; pause, hover and reduced motion are respected.
- MPRIS playback, pause, previous/next and seek controls in the popup, with capability checks and cancellation when the active track or player changes.
- Optional LrcAPI fallback with synchronized-over-plain lyric selection, provider-isolated caching and a compact source label.
- Playback-timed panel lyric scrolling, word focus following, edge fading, hover catch-up and looping popup titles.
- Overlapping timed lyric pages when Shell animations are disabled, including pause, seek and hover handling.

### Changed

- Reused existing JSON file helpers across both caches and removed null-only timestamp wrappers, redundant guards/validation and a forwarding method. Refreshed gettext source references, removed obsolete catalog entries without changing active translations, and clarified current versus historical verification records.
- Removed unused UI lookup/multiline paths, one-use forwarding methods and unconsumed translation options/error fields. Module-only helpers and defaults no longer expose unused exports; runtime behavior and cache formats are unchanged.
- Removed unused internal LRC lookup helpers/re-exports, artwork state, provider labels, build variables and an unreferenced fixture. Parser tests now exercise the document/synchronizer path used at runtime; maintenance docs distinguish deterministic checks from live tests.
- Overflowing panel and popup titles now scroll continuously left with matching copies and a fixed gap, replacing the reverse return leg. Popup-title hover pauses without resetting its position.
- Renamed the project and GNOME extension identity to LyricGlance (`lyric-glance@eureka`), including its settings schema, credential namespace, gettext domain, cache/config paths, package, and release artifacts. No migration from the previous identity is provided.
- Release automation uses date tags (`YYYY-MM-DD`) and uploads the tested ZIP and SHA-256 checksum to GitHub Releases.
- Line scrolling targets a four-second movement window when the text length permits, with reading time reserved at the ending rather than spreading movement across a long interlude.

### Fixed

- Mixed-language translation instructions explicitly cover foreign-language lines and phrases, including English refrains in Japanese lyrics. API responses with omitted/empty lines are rejected, and prompt-versioned cache identity prevents old translations masking the new policy; nonempty translation language/quality still depends on the model.
- Popup lyrics inherit the normal theme foreground instead of disabled-row gray; distant lines retain more contrast, bilingual groups have clearer spacing, and offset text is centered across scripts and directions. Footer padding is consistent, disabled buttons keep native styling, and lyrics gain edge fading.
- Small-display popups retain a font-relative lyrics viewport and scroll the full menu when needed, revealing keyboard-focused footer controls. Single-line titles and metadata use natural text height to prevent large-font overlap with media controls.
- Translation requests prefer `reasoning.effort: "none"`, use balanced chunks of up to 20 lines/3000 characters and allow three concurrent chunks. Confirmed unsupported-reasoning errors permit one fallback per in-flight request; unrelated HTTP 400 responses do not disable reasoning. These changes reduce per-request work without guaranteeing provider latency.
- Translation errors distinguish invalid credentials, forbidden access and recognized quota/spending-limit errors using bounded error responses. Quota failures are not automatically retried, and raw provider error text is not displayed or logged.
- Translation requests allow 120 seconds for slow model responses, replacing the 45-second timeout; Preferences connection checks retain 15 seconds, with batch limits and retries unchanged.
- Valid translation endpoint/model edits persist when closing Preferences without Apply; invalid edits preserve saved values. Saved credentials are explicitly marked as hidden, blank replacement keeps the existing key, and lyrics cache counts are shown separately from translation cache counts.
- Full-text scroll measurement uses unconstrained Pango logical/ink bounds rather than CSS-dependent preferred sizes. Drawing allocations include glyph overhang, padding and borders; resource-scale changes invalidate geometry.
- Lyrics timing buttons now use the translated seconds unit consistently. Translation checks compare current source strings against the template and every language catalog, and packaging verifies all compiled catalogs.
- Rapid song changes debounce uncached lookups; 429/503 retries honor service-wide cooldowns across tracks, preserve plain lyrics and align delayed results with the current clock. Temporary failures are distinguished from missing lyrics and are not negatively cached.
- Blank-only plain text and timestamp-only LRC/Lyricsfile no longer suppress fallback lookup; enabled fallback also retries legacy negative cache entries.
- Unrelated MPRIS capability/volume notifications no longer suppress control reconciliation. Snapshot/query ordering preserves newer clock feedback, capability changes and artwork metadata without polling.
- Explicit lyric and final-word endings are no longer overridden by a later next-line timestamp. Unknown final-word ends fall back to line timing, and known overlapping endings are retained.
- Resynchronizing the same line preserves its visible text and offset until the updated scroll plan starts.
- Lyrics received while hidden start scrolling when shown; font and viewport changes invalidate stale scroll geometry.
- Width and icon preference changes restart scrolling even when external panel constraints keep the allocated width unchanged.
- Scroll geometry uses widths recorded from actual allocations, avoiding transient preferred-width readings during layout invalidation that could leave newly clipped lyrics static.
- Word-follow coordinates account for the text resource scale on high-resolution displays. Allocation-sensitive scroll changes wait for layout before starting transitions.

Packaged Shell regressions cover these scrolling changes; fresh-session desktop and soak validation for the latest changes remains a separate gate in `docs/EGO-CHECKLIST.md`.

## [0.9.0] - 2026-08-23

### Added

- English and Simplified Chinese interface translations for the Shell popup and Preferences.
- Fedora 44 CI for deterministic tests, local integration checks, and verified extension packages.
- Tag-triggered GitHub release packaging with a SHA-256 checksum.
- Release documentation for privacy, compatibility, EGO review, and manual verification.

### Changed

- Release metadata now targets GNOME Shell 50 only, includes the project URL and gettext domain, and no longer carries the deprecated metadata version field.
- Async work, signals, timers, later callbacks, transitions, actors, and caches now have explicit lifecycle owners and cancellation paths.
- LRCLIB and translation responses are size-limited, and all network clients identify release version 0.9.0.
- Packaging now includes compiled translations, the project license, and all bundled dependency attribution while excluding development files.

### Fixed

- Stale async artwork, lyrics, cache, and translation work can no longer update a destroyed or replaced owner.
- Repeated enable/disable no longer relies on lifecycle boolean guards and is covered by three-cycle Shell testing.
- Preferences cancels outstanding Secret Service and cache operations and disconnects its settings signals when closed.
- Translation rate-limit waits now remove their timeout and cancellation signal on every completion path.

[0.9.0]: https://github.com/eurekaevan/lyric-glance/releases/tag/v0.9.0
