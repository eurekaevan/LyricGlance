# Changelog

## Unreleased

### Added

- Overflowing panel titles loop for tracks without lyrics and provider-marked instrumental tracks. Instrumental explanations remain in the popup; pause, hover and reduced motion are respected.
- MPRIS playback, pause, previous/next and seek controls in the popup, with capability checks and cancellation when the active track or player changes.
- Optional LrcAPI fallback with synchronized-over-plain lyric selection, provider-isolated caching and a compact source label.
- Playback-timed panel lyric scrolling, word focus following, edge fading, hover catch-up and looping popup titles.
- Overlapping timed lyric pages when Shell animations are disabled, including pause, seek and hover handling.

### Changed

- Renamed the project and GNOME extension identity to LyricGlance (`lyric-glance@eureka`), including its settings schema, credential namespace, gettext domain, cache/config paths, package, and release artifacts. No migration from the previous identity is provided.
- Release automation uses date tags (`YYYY-MM-DD`) and uploads the tested ZIP and SHA-256 checksum to GitHub Releases.
- Line scrolling targets a four-second movement window when the text length permits, with reading time reserved at the ending rather than spreading movement across a long interlude.

### Fixed

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
