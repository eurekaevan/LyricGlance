# LyricGlance Development & Architecture Guide

This document covers developer setup, runtime architecture, translation internals,
localization maintenance, linting, automated/live verification, and the release workflow.
For user-facing installation and configuration, see [README.md](../README.md)
([简体中文](../README.zh-CN.md)).

## Developer Setup

Static EGO packaging checks (`make shexli-check`) use Python 3.14 and a virtual environment.
On Fedora, install `python3.14` and `python-pip-wheel`, then set up the pinned `shexli` analyzer:

```sh
git clone https://github.com/eurekaevan/LyricGlance.git
cd LyricGlance
python3.14 -m venv /tmp/lyricglance-shexli
. /tmp/lyricglance-shexli/bin/activate
python -m pip install \
  'shexli @ https://github.com/GNOME/extensions-web/archive/56e6799ac01e39c0b31d83d350a8b4c15326efd8.tar.gz#subdirectory=shexli' \
  tree-sitter==0.25.2 tree-sitter-javascript==0.25.0
make check
make install
gnome-extensions enable lyric-glance@eureka
```

After a first install or any JavaScript change, log out and back in. GNOME Shell 50/51
caches imported ES modules for the lifetime of the Shell process, so `disable` / `enable`
alone does not prove a fresh module import.

## Architecture & Modules

```text
MPRIS signals
  -> normalized playback state
  -> LRCLIB / optional LrcAPI lookup and LyricsDocument
  -> monotonic playback synchronization
  -> panel and popup updates
```

### Major Modules

- `extension.js`: Extension lifecycle and MPRIS -> lyrics -> translation -> UI coordination.
- `mpris.js`: D-Bus player discovery, signal-driven monotonic playback clock, playback controls, and player selection policy.
- `lyrics.js`: LRCLIB / LrcAPI lookup, debounce, rate-limit retries, and cache coordination.
- `lyrics-parser.js`, `lyricsfile-parser.js`: LRC and Lyricsfile parsers.
- `lyrics-normalizer.js`, `lyrics-matcher.js`: Normalization and candidate ranking.
- `lyrics-document.js`, `lyrics-synchronizer.js`: Unified lyrics document model and line/word timing lookup.
- `translation-provider.js`, `translation-service.js`, `translation-batching.js`, `translation-cache.js`, `translation-document.js`, `credentials.js`: Translation providers, coalescing service, balanced batching, bounded cache, line-aligned documents, and GNOME Secret Service integration.
- `indicator.js`, `panel-label-view.js`, `artwork-loader.js`, `artwork-view.js`, `ui-utils.js`: Shell indicator, popup UI, scrolling panel label view, artwork loading/rendering, and pure UI math.
- `storage.js`: Bounded disk cache and per-track offset persistence.
- `network-utils.js`: Shared release `VERSION`/`USER_AGENT` and bounded stream readers/closers; protocol-specific HTTP error handling remains in callers.
- `shell-ui-utils.js`: Shell-only animation preference helpers and symbolic icon loaders.
- `prefs.js`, `schemas/`: GTK4/Libadwaita Preferences window and GSettings schema.

### MPRIS Discovery & Playback Controls

Player discovery listens to `NameOwnerChanged`, state updates listen to `PropertiesChanged`,
and seeks listen to `Seeked`. The initial `ListNames` call is treated only as a snapshot:
unresolved placeholders whose owners vanish (`NameHasNoOwner`) are removed, new owner signals
replace stale placeholders, late replies cannot overwrite newer owners, and restarted players
are rediscovered within the same session.

Lyrics schedule one-shot timers only for the next line, word, or reduced-motion page boundary.
While the popup is open and playing, a 500 ms UI timer updates progress from the local monotonic
clock (no D-Bus `Position` polling) and is removed immediately on pause or popup close.

Media buttons control the selected player according to its MPRIS capabilities. Seeking previews
while dragging and commits one `SetPosition` on release (retaining the preview until reconciliation
settles, without including lyrics time offsets). Post-command reconciliation checks only the
relevant `Position`/`Seeked` or `PlaybackStatus` notifications; unrelated capability, volume, or
artwork signals do not satisfy control feedback, and invalidated properties discard stale feedback.
Position reads and full snapshots are ordered independently; track changes clear the old clock even
when combined with status or rate updates.

### Caching & Resource Ownership

Pure reads of lyrics, translations, and offsets refresh access metadata only when more than
12 hours have elapsed since the previous access; disk eviction uses this coarse timestamp while
new results and user offset edits still persist immediately. `TranslationService` also keeps a
20-entry in-memory LRU isolated by track, source lyrics hash, target language, and provider
configuration.

Runtime resources are owned and cleaned up synchronously by their creators: `disable()` / `destroy()`
cancels `Gio.Cancellable` handles, removes GLib and `Meta.Later` sources, disconnects signals, stops
Clutter transitions, destroys actors, and drops references. Async completions verify request
generations or owner identity to prevent stale updates. `MprisManager.destroy()` is safe before
`start()` and on repeated calls.

### Scrolling & Text Measurement

Only synchronized panel lyrics wider than the allocated text viewport scroll. The viewport width
comes from layout allocation boxes (excluding the icon and spacing) and remeasures on resize, font,
or resource-scale changes. `max-panel-width` (default 500 px, range 150-1000 px) serves as both
preferred and maximum text width while allowing external panel compression.

Full text width is measured using an unconstrained Pango layout combining logical and ink glyph
extents, converted to logical pixels plus padding and borders (never using CSS-constrained preferred
widths). Hidden moving labels and repeating title copies become visible and wait for valid
full-width allocations before transitions start. Full cancellation clears layout pan widths and
repeat offsets; display-preserving resynchronization retains them.

When no lyrics exist (and track-info fallback is enabled) or a track is marked instrumental, the
panel shows the track title and loops overflowing titles seamlessly left using two copies separated
by a 32 px gap (1 s initial hold, 35 px/s continuous scroll, left fade active only after movement
starts). The popup title uses the same seamless loop under normal animations.

Line scrolling uses a brief lead hold, linear movement targeting a 4-second reading window when
length allows (extending around 240 px/s for very long lines within the line's available duration),
and an end hold of at least 200 ms (or 25% of very short lines), scaled by `playbackRate`.
Hovering freezes scrolling while preserving reading position across background timeline refreshes
and catching up over ~200 ms on leave.

Word focus following uses measured glyph positions to keep the active word near 60% of the viewport;
bidi text, split glyphs, overlapping word times, or mismatched text fall back to line scrolling.
Translations always follow the original line timeline.

When Shell animations are disabled or GNOME Shell 51 reduced motion is enabled, overflowing panel
lyrics switch to overlapping timed pages driven by the playback clock, and overflowing titles
remain statically ellipsized. See [compatibility.md](compatibility.md) for Shell 50/51 shader
and layout details.

### Timeline and End Times

`extension.js` supplies `startMs`, `endMs`, `positionMs`, and `playbackRate` to the panel view.
`positionMs` combines the MPRIS playback clock with global and per-track lyrics offsets (while
media progress and `SetPosition` use unshifted player time). `playbackRate` comes directly from
the normalized MPRIS state, including while paused.

Line end times resolve in priority order:

1. Explicit `line.endMs` (when greater than `startMs`).
2. Final word's known `endMs`, retaining any later overlapping word `endMs` (an unknown final word
   end never borrows an earlier word's end).
3. Known end times are capped at the next line's `startMs`.
4. Otherwise the next line's `startMs`, falling back on the final line to the offset-adjusted track
   end. Standard LRC lines have `endMs = null`; singing duration is never guessed from text length.

Finishing a scroll plan never clears the active line early; line selection remains controlled by
lyric timestamps (blank lyric lines represent interludes). Scroll math lives in `ui-utils.js`,
rendering/measurement/timers in `panel-label-view.js` and `indicator.js`, and boundary lookup in
`lyrics-synchronizer.js`.

## Translation Internals and Configuration

### Configuration Source of Truth

Historically (0.9.0), LyricGlance stored a single translation provider across four scalar GSettings
keys: `translation-provider`, `translation-api-endpoint`, `translation-api-protocol`, and
`translation-model`. Multi-provider support later introduced `translation-providers` (JSON array).

To eliminate dual-source drift and prevent stale scalar keys from overriding JSON edits or pairing
the wrong endpoint with a newly selected provider's credential, the unified contract is:

- **Single authoritative source**: Whenever `translation-providers` parses to at least one valid
  provider entry, `translation-providers` (catalog) + `translation-provider` (active provider ID)
  is the sole source of truth for both Preferences (`loadTranslationProviders`) and runtime
  (`loadActiveTranslationProvider` in `extension.js`). Legacy scalar keys never overwrite it.
  If `translation-provider` refers to an unknown ID, both Preferences and runtime consistently
  fall back to the first stored provider.
- **Migration & corruption fallback**: When `translation-providers` is empty (`''`, fresh install
  or upgrade from a legacy single-provider setup) or malformed JSON, both readers fall back to the
  four legacy scalar keys (normalizing invalid `translation-provider` IDs to `openai` consistently).
  At runtime, legacy fallback passes the trimmed endpoint/protocol/model to
  `OpenAITranslationProvider` so invalid legacy endpoints or blank models fail closed instead of
  silently substituting the default OpenAI URL or model.
- **Save mirroring**: `saveTranslationProviders()` writes `translation-providers` and
  `translation-provider`, and mirrors the active provider's endpoint, protocol, and model into the
  three legacy scalar keys strictly as a corruption/downgrade backup.
- **Runtime change handling**: `extension.js` watches `translation-providers`, `translation-provider`,
  and the legacy fallback keys, coalesces rapid updates over 25 ms, and replaces `TranslationService`
  only when the resolved active `{id, endpoint, protocol, model}` signature actually changes
  (so editing an inactive provider or touching an ignored legacy key does not cancel active work).

### Request Coalescing, Batching & Protocol Behavior

- **Coalescing & forced refresh**: In-flight requests matching track, source hash, target language,
  provider config, model, and network policy share work and replay their current status (including
  `loading`) to late subscribers. A forced refresh cancels and replaces an ordinary in-flight cache
  read or network request; repeated forced refreshes and subsequent ordinary callers join the new
  refresh. Canceled tasks never accept new callers.
- **Prompt & schema**: Prompts and JSON Schema request `{"lines":[{"id":"...","text":"..."}]}`.
  Mixed-language lines (such as English refrains inside Japanese lyrics) are translated into the
  target language while preserving existing target-language text and proper nouns. A top-level
  `translations` array alias is accepted only when `lines` is absent, with the same strict ID,
  duplicate, completeness, and non-empty validation. Cache identity includes the prompt version
  (`TRANSLATION_PROMPT_VERSION`) and resolved endpoint/protocol.
- **Offline same-language guard**: Explicit source language tags take precedence; unmarked lyrics
  use the bundled offline `franc-min` model (no network or Node.js dependency). Auto-skip requires
  at least 80 letter characters (or 60 Han characters with no kana/hangul and fewer than 24 Latin
  characters), at most 8,192 UTF-16 code units after deduplicating lines/credits, and consistent
  multi-sample agreement with sufficient score margin. Uncertain or mixed-language lyrics are still
  translated, and the popup provides a manual "Translate anyway" override. See
  [`README.franc.md`](../README.franc.md).
- **Reasoning effort & batching**: Requests send `reasoning.effort: "none"` (Responses) or
  `reasoning_effort: "none"` (Chat Completions), falling back once per in-flight request if a
  bounded error response explicitly rejects the reasoning parameter (remembered per provider
  instance). Lyrics split into balanced batches of up to 20 lines and 3,000 characters, running up
  to 3 concurrent batches; any batch failure cancels sibling batches.
- **Timeouts, retries & error boundaries**: Translation requests time out after 120 s (Preferences
  connection checks use 15 s and a 2,048-token cap with fixed input `Hello`). Error bodies are read
  up to 16 KiB; 401/invalid-key, generic 403, and whitelisted quota/spend-limit errors are
  classified without exposing raw provider text. Transient HTTP 429, 502, 503, and 504 retry at most
  once (honoring `Retry-After` up to `min(30 s, timeout)`); recognized quota errors do not retry.

### Translation Diagnostics

Transport failures distinguish `timeout`, `dns`, `tls`, `proxy`, `connection_closed`, `connection`,
and `unknown`. Journal entries (`translation transport failure`) log only error category, batch
index/count, line count, request byte size, elapsed milliseconds, attempt count, phase, and native
error code — never credentials, lyrics, track titles, endpoints, or raw exception messages that
could contain URLs.

Invalid responses log `invalid translation response reason=...` using these fixed reasons (never
logging response bodies or line IDs):

| `reason` | Meaning |
| --- | --- |
| `response_too_large` | Response body exceeded the size limit (default 4 MiB) |
| `response_json` | Outer HTTP response was not valid JSON |
| `response_not_completed` | Response reported a non-completed status other than output limit |
| `output_limit` | Responses stopped due to `max_output_tokens`, or Chat Completions returned `finish_reason: "length"` |
| `missing_output` | Responses lacked a valid `output` array, or Chat Completions lacked a first `choices` entry |
| `missing_output_text` | Protocol-specific translated text payload was missing |
| `missing_models` | `GET .../models` response lacked a recognizable model array (`fetchModels`) |
| `translation_json` | Extracted translation payload was not valid JSON |
| `line_schema` | Translated line structure or ID validation failed |
| `missing_lines` | Response omitted one or more requested lines in the batch |
| `blank_translation` | Response contained a blank translation string |

## LrcAPI Fallback, Rate Limiting and Retries

When LrcAPI fallback is enabled, selection order is **credible synchronized lyrics > plain lyrics >
no lyrics** (with LRCLIB preferred on equal quality and explicit instrumental results preserved).
Candidate arrays (`title`, `artist`, optional `album`/`duration`, `lyrics` or `lrc`) are ranked
rather than blindly accepting the first result. Both `lyrics` and `lrc` are normalized
independently: whitespace-only text and timestamp-only LRC lines are rejected (including legacy
disk cache entries on read) while meaningful blank interlude lines are preserved.

Fallback caches isolate by enabled flag and endpoint signature. Empty fallback results, 404s,
low-confidence candidates, and transport/server errors are never negatively cached. Plain-only
results remain upgradeable on future lookups.

Uncached lookups wait 600 ms for track changes to stabilize (`TRACK_DEBOUNCE_MS`) and keep at least
300 ms spacing between requests (`REQUEST_SPACING_MS`). HTTP 429 and 503 retry up to 4 times per
stage, honoring `Retry-After` seconds or HTTP dates clamped to 1 s-5 min, or exponential backoff
(1, 2, 4, 8 s) when absent/invalid. Cooldowns are tracked per service (`lrclib` shared across
`/api/get` and `/api/search`, `lrcapi` separate) and persist across track changes and cache clears
within the session. Exhausted retries or transport/parse errors report unavailable without creating
negative cache entries or background polling loops.

## Maintaining Interface Translations

Mark user-visible strings with `_('...')` and pluralized strings with `ngettext()`, keeping `%s`
and `%d` format placeholders intact. Register every source file containing translatable strings in
`po/POTFILES.in`:

```sh
make translations-update
```

This regenerates `po/lyric-glance@eureka.pot` and merges all `po/*.po` catalogs without fuzzy
matching. After updating translations, run `make check` to verify POT completeness, missing/fuzzy
entries, format placeholders, and compiled `.mo` packaging.

To add a new language, regenerate the POT file, initialize the catalog with
`msginit --input=po/lyric-glance@eureka.pot --locale=<LOCALE> --output-file=po/<LOCALE>.po`,
translate all entries, and add `<LOCALE>` to `po/LINGUAS`.

## Linting

`eslint.config.mjs` provides a self-contained ESLint 9+ flat configuration for GJS ES modules with
no npm dependencies (`franc.mjs` and `js-yaml.mjs` are ignored; `global` is scoped to Shell runtime
files and Shell tests, and legacy `imports` is scoped solely to `tests/prefs-window.js`).

With ESLint 9+ installed on `PATH` or in `./node_modules/.bin` (or specified via `ESLINT=...`):

```sh
make lint
```

`make lint` is kept separate from `make check` so offline and Fedora container environments without
Node.js remain self-contained. In GitHub Actions, `.github/workflows/ci.yml` runs `make lint` in a
dedicated `lint` job on `ubuntu-latest` using an isolated ESLint install outside the workspace
(also exercised by `.github/workflows/release.yml` via `workflow_call`).

## Verification & Testing

Deterministic release gates:

```sh
make clean
make check
make integration
make shell-check
make shell-presentation-check
make prefs-check
```

- `make check`: Runs `schema-check`, `translations-check`, all nine pure-logic `unit-check`
  scripts, `pack`, `package-check` (ZIP integrity, allowlist/denylist, runtime relative imports),
  and `shexli-check`. `shexli` itself exits 0 even when reporting findings, so `make shexli-check`
  prints the full report and exits non-zero on any `EGO-*` diagnostic. Commit `56e6799` is pinned
  because PyPI `0.2.1` incorrectly rejects GNOME Shell 51, and `tree-sitter==0.25.2` avoids a
  crash in `0.26.0`.
- `make integration`: Uses an isolated D-Bus session and local HTTP servers to verify MPRIS events,
  artwork loading, network errors (`tests/integration-lyrics-errors.js`), LRCLIB/LrcAPI HTTP
  contracts (`tests/integration-lyrics-http.js`, using injectable clock/timer hooks on
  `LyricsProvider` so debounce/backoff/cooldown contracts run deterministically without multi-minute
  wall-clock waits), persistent storage, and translation HTTP contracts without touching live
  external services.
- `make shell-check`, `make shell-presentation-check`, `make prefs-check`: Pack into isolated
  temporary runtime directories and run headless GNOME Shell / GTK Preferences regressions. CI and
  Release workflows share the Fedora 44 (Shell 50) and Fedora 45 (Shell 51) matrix using an
  isolated system D-Bus (`tests/system-bus.conf`, avoiding systemd/logind autostart in containers)
  alongside per-test session buses from `dbus-run-session`.

Manual headless Shell invocation (useful when customizing flags or scripts):

```sh
make pack
shell_runtime=$(mktemp -d /tmp/lyricglance-media-runtime-XXXXXX)
trap 'rm -rf -- "$shell_runtime"' EXIT
cp lyric-glance@eureka.shell-extension.zip "$shell_runtime/lyric-glance@eureka.shell-extension.zip"
dbus-run-session -- env XDG_RUNTIME_DIR="$shell_runtime" \
  GIO_USE_VFS=local GSETTINGS_BACKEND=memory \
  gnome-shell-test-tool --headless \
  --extension "$shell_runtime/lyric-glance@eureka.shell-extension.zip" tests/shell-extension.js
```

Always copy the freshly built ZIP into the temporary runtime directory before rerunning.

Optional real Secret Service test (writes and removes an isolated test secret):

```sh
make integration-secret
```

Desktop and live-service tests excluded from `make integration`:

| Entry point | Environment & purpose |
| --- | --- |
| `tests/shell-extension.js` | Isolated headless Shell regression using controlled playback fixtures |
| `tests/shell-presentation.js` | Dark/light themes, 100%/150% fonts, bilingual grouping, RTL centering, edge fades, keyboard focus |
| `tests/prefs-window.js` | GTK4/Libadwaita Preferences window test (requires display session & Shell prefs runtime) |
| `tests/integration-current-player.js` | Reads the live desktop MPRIS player and fetches lyrics (may write extension cache) |
| `tests/integration-playback-sync.js` | Exercises pause, play, and seek on a live player, attempting to restore original state |
| `tests/integration-track-cache.js` | Live player A -> B -> A track switching and cache verification |
| `tests/integration-live-player-policy.js` | Live Firefox plus controlled second player policy/fallback test |
| `tests/integration-live-lyricsfile.js` | Queries public LRCLIB to verify known word-synced, plain, and instrumental records |
| `make integration-secret` | Creates, reads, and deletes an isolated test secret in GNOME Secret Service |

Read each live test script before running it; live checks are tracked separately in
[EGO-CHECKLIST.md](EGO-CHECKLIST.md), compatibility boundaries in
[compatibility.md](compatibility.md), and historical review records in [EGO-AUDIT.md](EGO-AUDIT.md).

## Packaging & Release Workflow

Build and inspect a local package:

```sh
make pack
unzip -l lyric-glance@eureka.shell-extension.zip
```

Automated releases use `YYYY-MM-DD` date tags (for example `2026-11-22`):

1. Update `VERSION` in `network-utils.js`.
2. Sync `Project-Id-Version` headers in `po/*.pot` and `po/*.po` (`make translations-update`).
3. Add the matching release section and tag link in `CHANGELOG.md`.
4. Commit, tag, and push:

```sh
git tag 2026-11-22
git push origin 2026-11-22
```

`.github/workflows/release.yml` first runs `tools/check-release.sh` to verify the date tag,
`VERSION`, gettext headers, and `CHANGELOG.md` consistency, then reuses `.github/workflows/ci.yml`
to run the `lint` job (`make lint`) alongside the Fedora 44/45 (GNOME Shell 50/51) matrix
(`make check`, `make integration`, `make shell-check`, `make shell-presentation-check`,
`make prefs-check`). Once all checks pass, it creates the GitHub Release and attaches the verified
ZIP and `.sha256` checksum. Regular branch pushes trigger CI only and upload build artifacts.
Rerunning a tag workflow updates that release's attachments from the tagged commit.
