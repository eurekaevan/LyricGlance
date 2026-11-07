# LyricGlance Compatibility

## Recorded verification matrix

| Environment | Status | Evidence |
|---|---|---|
| Fedora 44, GNOME Shell 50.4, Wayland | PASS | `make check`, local integration suite, packaged `gnome-shell-test-tool` runs in English and Simplified Chinese |
| GNOME Shell 50.5, isolated Wayland Shell | Scrolling regressions PASS, 2026-10-15 | Packaged tests for explicit line endings, same-line resynchronization, font/layout changes, hidden-to-visible startup, title loops and native animation inhibition/restoration |
| GNOME Shell 50.6, isolated Wayland Shell | Cleanup and popup regressions PASS, 2026-10-31 | Full packaged Shell regression plus English/Simplified/Traditional Chinese × native dark/light × 100%/150% fonts × 720p/480p presentation checks; no allocation warnings in these runs |
| Firefox MPRIS discovery and player policy | PASS, 2026-08-23 | Live Firefox owner plus a controlled second player verified selection, preference, disappearance fallback, and changed instance bus names |
| Firefox with Spotify Web lyrics | PASS by owner-confirmed practical use, 2026-09-23 | The owner reports no significant issues in practical use and accepts the live-player UI and soak gates as complete. The 1,800-second 2026-08-23 run observed 19 track changes, 18 lyric loads and 57 synchronized samples. Fresh GNOME Shell 50.5 import was confirmed on 2026-09-23; no player was present for another instrumented run that day |
| Media controls and interactive progress | Deterministic tests PASS, 2026-10-09; live player not tested | Isolated MPRIS control, failure and cancellation tests; packaged headless Shell buttons, drag cancellation and native slider stepping |
| Spotify Linux client | Limited live integration evidence, 2026-10-14 | Real MPRIS state and seeks were exercised through an isolated Shell with cached lyrics. This did not reproduce the desktop clipping report or prove the latest desktop rendering fixes |
| Spotify Linux client, control core | Live MPRIS tests PASS, 2026-10-31 | Real player discovery, playback, pause/resume and bidirectional seeks passed with the original state restored. The selected song returned no lyrics; this does not establish lyric rendering or a fresh desktop import of the latest package |
| GNOME Shell 49 | Not tested / not declared | Absent from `shell-version` |
| Fedora 45, GNOME Shell 51.1, isolated Wayland Shell | Runtime regressions PASS, 2026-11-04 | Full packaged Shell regression including the native reduced-motion preference; shader, panel placement, text geometry, title loops, native slider, settings and repeated enable/disable. Additional presentation/Preferences evidence is recorded in `EGO-CHECKLIST.md` |

Headless Shell testing verifies the package, actors, layout, settings, timers, repeated enable/disable, and deterministic runtime behavior. The owner has separately accepted the live-player UI and soak gates based on practical use without significant issues; no new instrumented soak was captured during the 2026-09-23 inspection, when no MPRIS player owner was present. The 2026-08-23 run did not force-close the user's primary Firefox process.

The September acceptance applies to that historical baseline. It does not close the fresh-session and live soak gates for later scrolling changes. The latest automated scrolling tests and remaining desktop checks are recorded separately in `EGO-CHECKLIST.md`.

## GNOME 51 compatibility

Both `50` and `51` are declared in `shell-version`. The [GNOME Shell 51 porting guide](https://gjs.guide/extensions/upgrading/gnome-shell-51.html) identifies removed `Shell.GLSLEffect`, removed `St.Widget.vertical`, the reduced-motion preference, and changed popup animation parameters. The project already uses `orientation`, synchronous `disable()` and parameterless menu open/close calls. It does not use the removed backend/pointer-watcher APIs.

The edge-fade class selects the native shader parent and virtual hook by API availability: Shell 50's `GLSLEffect.build_pipeline` or Shell 51's `Clutter.ShaderEffect.get_static_snippet`. The same fragment code is appended after the texture color is computed; uniforms use the legacy location or the new name-based API. Registering only the available virtual hook avoids referencing an unimplemented hook on either parent.

Shell 51's `St.Settings.reduced_motion` is checked separately from `enable_animations`. Changes to either setting restart lyric/title plans; reduced motion uses timed lyric pages, static ellipsized titles and immediate artwork replacement. The optional enum/property are not read on Shell 50.

The 51.1 runtime suite and installed Shell resources cover these compatibility-sensitive areas:

- centralized panel placement using `Main.panel._leftBox`, `_centerBox`, and `_rightBox`;
- `PanelMenu.Button` and `PopupMenu` layout/ownership;
- `St.ScrollView` adjustment and comfortable-zone scrolling;
- Shell theme CSS and symbolic icon behavior in light/dark modes;
- Clutter transitions, reduced motion, and `Meta.Later` cleanup;
- custom label allocation, clipped viewports and the edge fade shader;
- Pango byte-index geometry and conversion from text resource scale to logical pixels;
- native `Slider` gestures and keyboard/scroll step origin synchronization;
- GTK4/Libadwaita Preferences API and extension gettext loading (window checks are tracked separately in `EGO-CHECKLIST.md`).

The panel boxes remain private GNOME Shell fields in both 50 and 51; neither exposes an equivalent public API for moving one existing indicator among all five requested positions. Access remains centralized in `extension.js`.

The media progress view resets the private `_unsnappedValue` retained by both Shell 50 and 51 Slider implementations when synchronizing from the playback clock, so keyboard and scroll adjustments start from the latest position. Headless drag tests simulate gesture signals; physical mouse/touch input and a freshly loaded desktop session remain separate checks. The Shell 50 branch has historical runtime evidence; it was not rerun in a local Shell 50 environment during the 51 port. Remote CI runs remain unverified until the workflow is executed.

## Scrolling compatibility and lifecycle

The custom label layout gives the moving label enough space for unconstrained Pango logical/ink bounds, padding and borders, independently of CSS preferred/minimum widths. Drawing coordinates include glyph overhang and text origin; hidden labels wait for allocation after becoming visible. The allocated text viewport defines overflow, excluding the music icon and spacing. Font/style, resource-scale and allocation changes invalidate cached word geometry and scroll plans. Layout-changing work is deferred through `Meta.Later` before transitions start; resynchronizing unchanged text preserves the visible label while waiting.

Text viewport widths are recorded from `get_allocation_box()` inside allocation notifications. Scrolling, word focus, pages, fades and title overflow use these recorded widths. Reading `Actor.width` during invalid layout can return a preferred width instead: a regression reproduced an 85 px allocation temporarily reporting 255 px after the moving label changed size. Retaining the last allocated width prevents this from falsely cancelling overflow. Width/icon preference changes also queue a restart even if external panel constraints leave the actual allocation unchanged.

Word focus following requires matching original text, monotonic glyph geometry and non-overlapping word timing. Unsupported geometry or timing falls back to line scrolling. Translations use the original line timeline rather than original word coordinates. Timing and fallback rules have one reference in the [README](../README.md#时间轴与结束时间).

`St.Settings.enable_animations` and, on 51, `St.Settings.reduced_motion` control continuous motion. When animations are disabled or reduced motion is requested, synchronized panel lyrics use overlapping pages driven by the same playback clock; popup titles retain static ellipsizing. The packaged test inhibits and restores native Shell animations, and separately changes the native reduced-motion setting while animations stay enabled. It checks page advancement, pause, hover, backward/forward seeks and return to continuous motion.

Word and page boundaries reuse one one-shot timer per indicator. Pause, hover and resynchronization cancel or replace it; hiding or destroying the indicator cancels pending boundaries, deferred layout work and transitions. Closing the popup stops its title loop and popup progress refresh, while panel lyrics can continue following playback. None of these paths adds D-Bus position polling.
