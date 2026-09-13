# Compatibility

## Current release candidate matrix

| Environment | Status | Evidence |
|---|---|---|
| Fedora 44, GNOME Shell 50.4, Wayland | PASS | `make check`, local integration suite, packaged `gnome-shell-test-tool` runs in English and Simplified Chinese |
| Firefox MPRIS discovery and player policy | PASS, 2026-08-23 | Live Firefox owner plus a controlled second player verified selection, preference, disappearance fallback, and changed instance bus names |
| Firefox with Spotify Web lyrics | PASS for playback/lyrics, final post-fix login check pending | A 1,800-second live run on 2026-08-23 observed 19 track changes, 18 lyric loads and 57 synchronized samples without losing the player; the allocation-warning fix made afterward still needs a fresh Shell import |
| Spotify Linux client | Not tested | No compatibility claim beyond its standard MPRIS interface |
| GNOME Shell 49 | Not tested / not declared | Absent from `shell-version` |
| GNOME Shell 51 | Not tested / not declared | Absent from `shell-version` |

Headless Shell testing verifies the package, actors, layout, settings, timers, repeated enable/disable, and deterministic runtime behavior. It does not replace a post-login live-player soak test. The 2026-08-23 run did not force-close the user's primary Firefox process, and successful credential-backed translation plus a live word-synced MPRIS track remain unverified.

## GNOME 51 preparation

Do not add `51` to `shell-version` until each of these areas has been tested on a real GNOME 51 session:

- centralized panel placement using `Main.panel._leftBox`, `_centerBox`, and `_rightBox`;
- `PanelMenu.Button` and `PopupMenu` layout/ownership;
- `St.ScrollView` adjustment and comfortable-zone scrolling;
- Shell theme CSS and symbolic icon behavior in light/dark modes;
- Clutter transitions, reduced motion, and `Meta.Later` cleanup;
- GTK4/Libadwaita Preferences API and extension gettext loading.

The panel boxes are private GNOME Shell fields. GNOME Shell 50 has no equivalent public API for moving one existing indicator among all five requested positions, so access remains centralized in `extension.js` rather than replaced with a broader hack.
