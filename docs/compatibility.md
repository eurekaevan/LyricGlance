# LyricGlance Compatibility

## Current release candidate matrix

| Environment | Status | Evidence |
|---|---|---|
| Fedora 44, GNOME Shell 50.4, Wayland | PASS | `make check`, local integration suite, packaged `gnome-shell-test-tool` runs in English and Simplified Chinese |
| Firefox MPRIS discovery and player policy | PASS, 2026-08-23 | Live Firefox owner plus a controlled second player verified selection, preference, disappearance fallback, and changed instance bus names |
| Firefox with Spotify Web lyrics | PASS by owner-confirmed practical use, 2026-09-23 | The owner reports no significant issues in practical use and accepts the live-player UI and soak gates as complete. The 1,800-second 2026-08-23 run observed 19 track changes, 18 lyric loads and 57 synchronized samples. Fresh GNOME Shell 50.5 import was confirmed on 2026-09-23; no player was present for another instrumented run that day |
| Media controls and interactive progress | Deterministic tests PASS, 2026-10-09; live player not tested | Isolated MPRIS control, failure and cancellation tests; packaged headless Shell buttons, drag cancellation and native slider stepping |
| Spotify Linux client | Not tested | No compatibility claim beyond its standard MPRIS interface |
| GNOME Shell 49 | Not tested / not declared | Absent from `shell-version` |
| GNOME Shell 51 | Not tested / not declared | Absent from `shell-version` |

Headless Shell testing verifies the package, actors, layout, settings, timers, repeated enable/disable, and deterministic runtime behavior. The owner has separately accepted the live-player UI and soak gates based on practical use without significant issues; no new instrumented soak was captured during the 2026-09-23 inspection, when no MPRIS player owner was present. The 2026-08-23 run did not force-close the user's primary Firefox process.

## GNOME 51 preparation

Do not add `51` to `shell-version` until each of these areas has been tested on a real GNOME 51 session:

- centralized panel placement using `Main.panel._leftBox`, `_centerBox`, and `_rightBox`;
- `PanelMenu.Button` and `PopupMenu` layout/ownership;
- `St.ScrollView` adjustment and comfortable-zone scrolling;
- Shell theme CSS and symbolic icon behavior in light/dark modes;
- Clutter transitions, reduced motion, and `Meta.Later` cleanup;
- native `Slider` gestures and keyboard/scroll step origin synchronization;
- GTK4/Libadwaita Preferences API and extension gettext loading.

The panel boxes are private GNOME Shell fields. GNOME Shell 50 has no equivalent public API for moving one existing indicator among all five requested positions, so access remains centralized in `extension.js` rather than replaced with a broader hack.

The media progress view resets Shell 50 Slider's private `_unsnappedValue` when synchronizing from the playback clock, so keyboard and scroll adjustments start from the latest position. This needs rechecking for future Shell versions. Headless drag tests simulate gesture signals; physical mouse/touch input and a freshly loaded desktop session remain unverified for the new media controls.
