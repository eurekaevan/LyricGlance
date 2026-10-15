UUID := lyric-glance@eureka
GETTEXT_DOMAIN := $(UUID)
PACKAGE := $(UUID).shell-extension.zip
USER_DATA_DIR ?= $(HOME)/.local/share
EXTENSION_DIR := $(USER_DATA_DIR)/gnome-shell/extensions/$(UUID)
SCHEMA := schemas/org.gnome.shell.extensions.lyric-glance.gschema.xml
POT_FILE := po/$(GETTEXT_DOMAIN).pot
PO_FILES := $(wildcard po/*.po)
RUNTIME_SOURCES := indicator.js artwork-loader.js artwork-view.js ui-utils.js \
	lyrics.js lyrics-document.js lyrics-matcher.js lyrics-normalizer.js \
	lyrics-parser.js lyrics-synchronizer.js lyricsfile-parser.js mpris.js \
	storage.js credentials.js translation-batching.js translation-cache.js \
	translation-document.js translation-provider.js translation-service.js \
	js-yaml.mjs LICENSE.js-yaml README.js-yaml.md LICENSE
PACK_SOURCE_ARGS := $(foreach source,$(RUNTIME_SOURCES),--extra-source=$(source))

.PHONY: check unit-check schema-check translations-check package-check \
	integration integration-secret install enable disable reload pack pot translations-update clean

check: schema-check translations-check unit-check pack package-check

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
		--package-name="LyricGlance" --package-version=0.9.0 \
		--msgid-bugs-address="https://github.com/eurekaevan/lyric-glance/issues" \
		--output=$(POT_FILE) --files-from=po/POTFILES.in

translations-update: pot
	@set -eu; for catalog in $(PO_FILES); do \
		msgmerge --update --backup=none --no-fuzzy-matching "$$catalog" $(POT_FILE); \
	done

clean:
	rm -f "$(PACKAGE)"
