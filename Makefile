UUID := lyric-glance@eureka
GETTEXT_DOMAIN := $(UUID)
APP_VERSION := $(shell sed -nE "s/^export const VERSION = '([^']+)';$$/\1/p" network-utils.js)
PACKAGE := $(UUID).shell-extension.zip
SCHEMA := schemas/org.gnome.shell.extensions.lyric-glance.gschema.xml
POT_FILE := po/$(GETTEXT_DOMAIN).pot
PO_FILES := $(wildcard po/*.po)
RUNTIME_SOURCES := network-utils.js shell-ui-utils.js io-promisify.js indicator.js artwork-loader.js artwork-view.js ui-utils.js \
	lyrics.js lyrics-document.js lyrics-matcher.js lyrics-normalizer.js \
	lyrics-parser.js lyrics-synchronizer.js lyricsfile-parser.js mpris.js \
	storage.js credentials.js translation-batching.js translation-cache.js \
	translation-document.js translation-provider.js translation-service.js \
	js-yaml.mjs LICENSE.js-yaml \
	franc.mjs LICENSE.franc LICENSE
PACK_SOURCE_ARGS := $(foreach source,$(RUNTIME_SOURCES),--extra-source=$(source))

.PHONY: check shell-check shell-presentation-check prefs-check unit-check schema-check translations-check package-check shexli-check \
	integration integration-secret install enable disable reload pack pot translations-update clean

check: schema-check translations-check unit-check pack package-check shexli-check

shell-check: SHELL_TEST_SCRIPT := tests/shell-extension.js
shell-presentation-check: SHELL_TEST_SCRIPT := tests/shell-presentation.js
prefs-check: SHELL_TEST_SCRIPT := tests/shell-prefs.js
prefs-check: SHELL_TEST_ARGS := --extra-filter org.gnome.Shell.Extensions.LyricGlancePrefsTest

shell-check shell-presentation-check prefs-check: pack
	@set -eu; shell_runtime=$$(mktemp -d /tmp/lyricglance-shell-XXXXXX); \
	trap 'rm -rf -- "$$shell_runtime"' EXIT; \
	cp "$(PACKAGE)" "$$shell_runtime/$(PACKAGE)"; \
	dbus-run-session -- env XDG_RUNTIME_DIR="$$shell_runtime" \
		GIO_USE_VFS=local GSETTINGS_BACKEND=memory LIBGL_ALWAYS_SOFTWARE=1 \
		timeout 300s gnome-shell-test-tool --headless \
		$(SHELL_TEST_ARGS) --extension "$$shell_runtime/$(PACKAGE)" "$(SHELL_TEST_SCRIPT)"

schema-check:
	glib-compile-schemas --strict --dry-run schemas

translations-check:
	@set -eu; template=$$(mktemp); trap 'rm -f "$$template"' EXIT; \
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=ngettext:1,2 --add-comments=Translators \
		--files-from=po/POTFILES.in --output="$$template"; \
	msgcmp --use-untranslated $(POT_FILE) "$$template"; \
	for catalog in $(PO_FILES); do \
		msgfmt --check --check-header --output-file=/dev/null "$$catalog"; \
		msgcmp "$$catalog" "$$template"; \
	done

unit-check:
	gjs -m tests/test-lrc.js
	gjs -m tests/test-lyrics-document.js
	gjs -m tests/test-lyricsfile.js
	gjs -m tests/test-lyrics-matcher.js
	gjs -m tests/test-translation-document.js
	gjs -m tests/test-translation-service.js
	gjs -m tests/test-mpris.js
	gjs -m tests/test-ui-utils.js
	gjs -m tests/test-player-policy.js

package-check: pack
	tools/check-package.sh "$(PACKAGE)"

shexli-check: pack
	shexli "$(PACKAGE)"

integration:
	dbus-run-session -- gjs -m tests/integration-mpris-events.js
	gjs -m tests/integration-artwork-loader.js
	gjs -m tests/test-lyrics-errors.js
	gjs -m tests/integration-lyrics-http.js
	gjs -m tests/integration-storage.js
	gjs -m tests/integration-translation-http.js

integration-secret:
	gjs -m tests/integration-credentials.js

install: pack
	gnome-extensions install --force "$(PACKAGE)"

enable: install
	gnome-extensions enable "$(UUID)"

disable:
	gnome-extensions disable "$(UUID)"

reload: install
	-gnome-extensions disable "$(UUID)"
	gnome-extensions enable "$(UUID)"

pack:
	gnome-extensions pack --force --out-dir=. \
		--schema=$(SCHEMA) \
		--podir=po \
		--gettext-domain=$(GETTEXT_DOMAIN) \
		$(PACK_SOURCE_ARGS) .

pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=ngettext:1,2 --add-comments=Translators \
		--package-name="LyricGlance" --package-version=$(APP_VERSION) \
		--msgid-bugs-address="https://github.com/eurekaevan/LyricGlance/issues" \
		--output=$(POT_FILE) --files-from=po/POTFILES.in

translations-update: pot
	@set -eu; for catalog in $(PO_FILES); do \
		msgmerge --update --backup=none --no-fuzzy-matching "$$catalog" $(POT_FILE); \
	done

clean:
	rm -f "$(PACKAGE)"
