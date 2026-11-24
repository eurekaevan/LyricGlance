#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

readonly TAG=${1:?usage: check-release.sh YYYY-MM-DD [REPO_ROOT]}
readonly ROOT_DIR=${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
readonly NETWORK_UTILS="${ROOT_DIR}/network-utils.js"
readonly CHANGELOG="${ROOT_DIR}/CHANGELOG.md"
readonly PO_DIR="${ROOT_DIR}/po"

if [[ ! "${TAG}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
   ! release_date=$(date -u --date="${TAG}" +%F 2>/dev/null) ||
   [[ "${release_date}" != "${TAG}" ]]; then
    printf 'Invalid release tag %q: expected a valid YYYY-MM-DD calendar date.\n' "${TAG}" >&2
    exit 1
fi

if [[ ! -f "${NETWORK_UTILS}" ]]; then
    printf 'Missing version source: %s\n' "${NETWORK_UTILS}" >&2
    exit 1
fi

if [[ ! -f "${CHANGELOG}" ]]; then
    printf 'Missing changelog: %s\n' "${CHANGELOG}" >&2
    exit 1
fi

if [[ ! -d "${PO_DIR}" ]]; then
    printf 'Missing translations directory: %s\n' "${PO_DIR}" >&2
    exit 1
fi

mapfile -t version_matches < <(
    tr -d '\r' < "${NETWORK_UTILS}" |
        sed -nE "s/^export const VERSION = '([^']+)';$/\1/p"
)
if [[ ${#version_matches[@]} -ne 1 ]]; then
    printf 'Expected exactly one VERSION export in %s (found %d).\n' \
        "${NETWORK_UTILS}" "${#version_matches[@]}" >&2
    exit 1
fi

readonly VERSION=${version_matches[0]}
if [[ ! "${VERSION}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
    printf 'Invalid VERSION in %s: %q\n' "${NETWORK_UTILS}" "${VERSION}" >&2
    exit 1
fi

if [[ "${VERSION}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "${VERSION}" != "${TAG}" ]]; then
    printf 'Date VERSION %s in %s does not match release tag %s.\n' \
        "${VERSION}" "${NETWORK_UTILS}" "${TAG}" >&2
    exit 1
fi

shopt -s nullglob
readonly POT_FILES=("${PO_DIR}"/*.pot)
readonly PO_FILES=("${PO_DIR}"/*.po)
shopt -u nullglob

if [[ ${#POT_FILES[@]} -eq 0 || ${#PO_FILES[@]} -eq 0 ]]; then
    printf 'Expected gettext .pot and .po catalogs in %s.\n' "${PO_DIR}" >&2
    exit 1
fi

readonly EXPECTED_PO_HEADER="\"Project-Id-Version: LyricGlance ${VERSION}\\n\""
for catalog in "${POT_FILES[@]}" "${PO_FILES[@]}"; do
    if ! awk -v version="${VERSION}" '
        BEGIN { expected = "\"Project-Id-Version: LyricGlance " version "\\n\"" }
        { sub(/\r$/, "") }
        $0 == "msgstr \"\"" && !seen_header { in_header = 1; seen_header = 1; next }
        in_header && $0 == "" { in_header = 0 }
        in_header && $0 == expected { found++ }
        END { exit(found == 1 ? 0 : 1) }
    ' "${catalog}"; then
        printf '%s is missing expected header %s.\n' "${catalog}" "${EXPECTED_PO_HEADER}" >&2
        exit 1
    fi
done

awk -v tag="${TAG}" -v version="${VERSION}" '
BEGIN {
    fence_char = ""
    fence_len = 0
    in_target = 0
    target_matches = 0
    target_entries = 0
    version_headings = 0
    date_headings = 0
    version_link_defs = 0
    link_matches = 0
    same_version_tag = (version == tag)
    bracket_prefix = "## [" version "]"
    expected_primary = same_version_tag ? "## [" tag "]" : "## [" version "] - " tag
    expected_alt = same_version_tag ? "## [" tag "] - " tag : ""
    date_suffix = " - " tag
    link_label = "[" version "]:"
    link_suffix = "/releases/tag/" tag
}
{
    sub(/\r$/, "")
    sub(/[ \t]+$/, "")

    if (fence_char != "") {
        if ($0 ~ /^[ \t]*(```+|~~~+)$/) {
            stripped = $0
            sub(/^[ \t]+/, "", stripped)
            if (substr(stripped, 1, 1) == fence_char && length(stripped) >= fence_len) {
                fence_char = ""
                fence_len = 0
            }
        }
        next
    }

    if ($0 ~ /^[ \t]*(```+|~~~+)/) {
        stripped = $0
        sub(/^[ \t]+/, "", stripped)
        c = substr(stripped, 1, 1)
        n = 0
        while (substr(stripped, n + 1, 1) == c)
            n++
        if (c == "~" || index(substr(stripped, n + 1), "`") == 0) {
            fence_char = c
            fence_len = n
            next
        }
    }

    if (substr($0, 1, 2) == "# ") {
        in_target = 0
        next
    }

    if (substr($0, 1, 3) == "## ") {
        in_target = 0
        if ($0 == bracket_prefix || substr($0, 1, length(bracket_prefix) + 1) == bracket_prefix " ")
            version_headings++
        if ($0 == "## [" tag "]" ||
            (length($0) >= length(date_suffix) &&
             substr($0, length($0) - length(date_suffix) + 1) == date_suffix))
            date_headings++
        if ($0 == expected_primary || (expected_alt != "" && $0 == expected_alt)) {
            target_matches++
            in_target = 1
        }
        next
    }

    if (in_target && $0 ~ /^[-*] [ \t]*[^ \t]/)
        target_entries++

    if (substr($0, 1, length(link_label)) == link_label) {
        version_link_defs++
        rest = substr($0, length(link_label) + 1)
        if (rest ~ /^[ \t]+https:\/\/[^\/ \t]+\/[^ \t]+$/) {
            url = rest
            sub(/^[ \t]+/, "", url)
            if (length(url) > length("https://") + length(link_suffix) &&
                substr(url, length(url) - length(link_suffix) + 1) == link_suffix) {
                base = substr(url, length("https://") + 1,
                    length(url) - length("https://") - length(link_suffix))
                if (base ~ /^[^\/ \t]+\/[^ \t]+$/ && base !~ /\/\/|\/$/)
                    link_matches++
            }
        }
    }
}
END {
    if (target_matches == 0) {
        printf "CHANGELOG.md is missing the release section %s (network-utils.js VERSION is %s).\n",
            expected_primary, version > "/dev/stderr"
        exit 1
    }
    if (target_matches > 1) {
        printf "CHANGELOG.md contains %d duplicate release sections for %s.\n",
            target_matches, expected_primary > "/dev/stderr"
        exit 1
    }
    if (version_headings != 1) {
        printf "CHANGELOG.md contains %d headings for version [%s]; expected 1.\n",
            version_headings, version > "/dev/stderr"
        exit 1
    }
    if (date_headings != 1) {
        printf "CHANGELOG.md contains %d headings for release date %s; expected 1.\n",
            date_headings, tag > "/dev/stderr"
        exit 1
    }
    if (target_entries == 0) {
        printf "CHANGELOG.md release section %s has no bullet entries.\n",
            expected_primary > "/dev/stderr"
        exit 1
    }
    if (version_link_defs != 1 || link_matches != 1) {
        printf "CHANGELOG.md must define exactly one release tag link [%s]: https://<host>/<repo>/releases/tag/%s (found %d definitions, %d valid).\n",
            version, tag, version_link_defs, link_matches > "/dev/stderr"
        exit 1
    }
}
' "${CHANGELOG}"

printf 'Release metadata check passed: tag=%s version=%s\n' "${TAG}" "${VERSION}"
