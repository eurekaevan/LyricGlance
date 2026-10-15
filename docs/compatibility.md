# LyricGlance Compatibility

## Recorded verification matrix

| Environment | Status | Evidence |
|---|---|---|
| Fedora 44, GNOME Shell 50.4, Wayland | PASS | `make check`, local integration suite, packaged `gnome-shell-test-tool` runs in English and Simplified Chinese |
| GNOME Shell 50.5, isolated Wayland Shell | Scrolling regressions PASS, 2026-10-15 | Packaged tests for explicit line endings, same-line resynchronization, font/layout changes, hidden-to-visible startup, title loops and native animation inhibition/restoration |
| Firefox MPRIS discovery and player policy | PASS, 2026-08-23 | Live Firefox owner plus a controlled second player verified selection, preference, disappearance fallback, and changed instance bus names |
| Firefox with Spotify Web lyrics | PASS by owner-confirmed practical use, 2026-09-23 | The owner reports no significant issues in practical use and accepts the live-player UI and soak gates as complete. The 1,800-second 2026-08-23 run observed 19 track changes, 18 lyric loads and 57 synchronized samples. Fresh GNOME Shell 50.5 import was confirmed on 2026-09-23; no player was present for another instrumented run that day |
| Media controls and interactive progress | Deterministic tests PASS, 2026-10-09; live player not tested | Isolated MPRIS control, failure and cancellation tests; packaged headless Shell buttons, drag cancellation and native slider stepping |
| Spotify Linux client | Limited live integration evidence, 2026-10-14 | Real MPRIS state and seeks were exercised through an isolated Shell with cached lyrics. This did not reproduce the desktop clipping report or prove the latest desktop rendering fixes |
| GNOME Shell 49 | Not tested / not declared | Absent from `shell-version` |
| GNOME Shell 51 | Not tested / not declared | Absent from `shell-version` |

Headless Shell testing verifies the package, actors, layout, settings, timers, repeated enable/disable, and deterministic runtime behavior. The owner has separately accepted the live-player UI and soak gates based on practical use without significant issues; no new instrumented soak was captured during the 2026-09-23 inspection, when no MPRIS player owner was present. The 2026-08-23 run did not force-close the user's primary Firefox process.

The September acceptance applies to that historical baseline. It does not close the fresh-session and live soak gates for later scrolling changes. The latest automated scrolling tests and remaining desktop checks are recorded separately in `EGO-CHECKLIST.md`.

## GNOME 51 preparation

Do not add `51` to `shell-version` until each of these areas has been tested on a real GNOME 51 session:

- centralized panel placement using `Main.panel._leftBox`, `_centerBox`, and `_rightBox`;
- `PanelMenu.Button` and `PopupMenu` layout/ownership;
- `St.ScrollView` adjustment and comfortable-zone scrolling;
- Shell theme CSS and symbolic icon behavior in light/dark modes;
- Clutter transitions, reduced motion, and `Meta.Later` cleanup;
- custom label allocation, clipped viewports and the edge fade shader;
- Pango byte-index geometry and conversion from text resource scale to logical pixels;
- native `Slider` gestures and keyboard/scroll step origin synchronization;
- GTK4/Libadwaita Preferences API and extension gettext loading.

The panel boxes are private GNOME Shell fields. GNOME Shell 50 has no equivalent public API for moving one existing indicator among all five requested positions, so access remains centralized in `extension.js` rather than replaced with a broader hack.

The media progress view resets Shell 50 Slider's private `_unsnappedValue` when synchronizing from the playback clock, so keyboard and scroll adjustments start from the latest position. This needs rechecking for future Shell versions. Headless drag tests simulate gesture signals; physical mouse/touch input and a freshly loaded desktop session remain unverified for the new media controls.

## Scrolling compatibility and lifecycle

The custom label layout gives the moving label its full natural width while clipping it to the allocated text viewport. The viewport, rather than the whole panel button, defines overflow, so the music icon and spacing are excluded. Font/style, resource-scale and allocation measurements invalidate cached word geometry and scroll plans. Layout-changing work is deferred through `Meta.Later` before transitions start; resynchronizing unchanged text preserves the visible label while waiting.

Text viewport widths are recorded from `get_allocation_box()` inside allocation notifications. Scrolling, word focus, pages, fades and title overflow use these recorded widths. Reading `Actor.width` during invalid layout can return a preferred width instead: a regression reproduced an 85 px allocation temporarily reporting 255 px after the moving label changed size. Retaining the last allocated width prevents this from falsely cancelling overflow. Width/icon preference changes also queue a restart even if external panel constraints leave the actual allocation unchanged.

Word focus following requires matching original text, monotonic glyph geometry and non-overlapping word timing. Unsupported geometry or timing falls back to line scrolling. Translations use the original line timeline rather than original word coordinates. Plain LRC has no explicit end; known line/final-word ends take precedence over the next line, while overlaps are capped at that next line. Full timing and fallback rules are documented in the README.

`St.Settings.enable_animations` controls continuous motion. When it is false, synchronized panel lyrics use overlapping pages driven by the same playback clock; popup titles retain static ellipsizing. The packaged test inhibits and restores native Shell animations, rather than only substituting a test preference, and checks page advancement, pause, hover, backward/forward seeks and return to continuous motion.

Word and page boundaries reuse one one-shot timer per indicator. Pause, hover and resynchronization cancel or replace it; hiding or destroying the indicator cancels pending boundaries, deferred layout work and transitions. Closing the popup stops its title loop and popup progress refresh, while panel lyrics can continue following playback. None of these paths adds D-Bus position polling.
