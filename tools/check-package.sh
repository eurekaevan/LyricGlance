#!/usr/bin/env bash
set -euo pipefail

readonly ARCHIVE=${1:?usage: check-package.sh EXTENSION_ZIP}
readonly TMP_DIR=$(mktemp -d)
trap 'rm -rf -- "${TMP_DIR}"' EXIT

unzip -t "${ARCHIVE}"
unzip -q "${ARCHIVE}" -d "${TMP_DIR}"

readonly REQUIRED_FILES=(
    metadata.json
    extension.js
    prefs.js
    stylesheet.css
    schemas/org.gnome.shell.extensions.lyric-glance.gschema.xml
    js-yaml.mjs
    LICENSE.js-yaml
    franc.mjs
    LICENSE.franc
    LICENSE
)

for file in "${REQUIRED_FILES[@]}"; do
    if [[ ! -f "${TMP_DIR}/${file}" ]]; then
        printf 'Missing required package file: %s\n' "${file}" >&2
        exit 1
    fi
done

for catalog in "$(dirname "${BASH_SOURCE[0]}")/../po/"*.po; do
    language=$(basename "${catalog}" .po)
    if [[ ! -f "${TMP_DIR}/locale/${language}/LC_MESSAGES/lyric-glance@eureka.mo" ]]; then
        printf 'Missing compiled translation: %s\n' "${language}" >&2
        exit 1
    fi
done

if unzip -Z1 "${ARCHIVE}" | grep -E \
    '(^|/)(\.git|tests|tools|docs|node_modules|build|dist)(/|$)|(^|/)(\.env|gschemas\.compiled$|README\.[^/]+\.md$)' > /dev/null; then
    printf 'Package contains a development-only or forbidden file\n' >&2
    exit 1
fi

if grep -rE '\b(MockTranslationProvider|alignTranslation|progressFraction)\b' \
    --include='*.js' --include='*.mjs' "${TMP_DIR}" > /dev/null; then
    printf 'Package contains test-only translation or UI helpers\n' >&2
    exit 1
fi

while IFS= read -r imported; do
    if [[ ! -f "${TMP_DIR}/${imported}" ]]; then
        printf 'Package import target is missing: %s\n' "${imported}" >&2
        exit 1
    fi
done < <(
    grep -rEho "(from|import) ['\"]\./[^'\"]+['\"]" \
        --include='*.js' --include='*.mjs' "${TMP_DIR}" |
        sed -E "s/^.*(from|import) ['\"]\.\/([^'\"]+)['\"]$/\2/" |
        sort -u
)

printf 'Package content and runtime import checks passed\n'
