#!/usr/bin/env bash
set -euo pipefail

# Pinned Linux x86-64 build; Node.js and npm are not needed, even to rebuild.
readonly OUTPUT_DIR=${1:-/tmp/lyric-glance-franc-6.2.0}
readonly BUILD_DIR=$(mktemp -d /tmp/lyric-glance-franc-build.XXXXXX)
trap 'rm -rf -- "${BUILD_DIR}"' EXIT

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
    printf 'This reproducible build requires Linux x86-64\n' >&2
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"
readonly OUTPUT_PATH=$(realpath "${OUTPUT_DIR}")
cd "${BUILD_DIR}"

while read -r name version sha256; do
    archive="${name##*/}-${version}.tgz"
    curl -fsSL "https://registry.npmjs.org/${name}/-/${archive}" -o "${archive}"
    printf '%s  %s\n' "${sha256}" "${archive}" | sha256sum -c -
    mkdir -p "node_modules/${name}"
    tar -xzf "${archive}" --strip-components=1 -C "node_modules/${name}"
done <<'PACKAGES'
franc-min 6.2.0 82417c7fe3778988b00b1b0c4db783b583ce9c8321dd7279f7a7f67709686654
trigram-utils 2.0.1 3390b247fcb2dc1589ee3fa714986bce010af465446299746ee9928094bee8e6
collapse-white-space 2.1.0 7e2300655decce051cf4c8ece8cf997ed0c16ce6eb3cec975529d12cfa211d5e
n-gram 2.0.2 05cf48444f90a33bac1750cf30f18dbafd975b8006d6c6496acccf93571df504
@esbuild/linux-x64 0.25.12 f7efc127658a108dcda9d4210b01804ee8f5d6b3acbd6d63f20aa51d3b50bd5f
PACKAGES

# The franc-min npm tarball omits its license; retain the tagged upstream file.
curl -fsSL https://raw.githubusercontent.com/wooorm/franc/6.2.0/license \
    -o node_modules/franc-min/license
printf '%s  %s\n' \
    f5e0c5c44706ddda7ac2f9096f848222f1e0e90f88643955041c2735be84592b \
    node_modules/franc-min/license | sha256sum -c -

node_modules/@esbuild/linux-x64/bin/esbuild node_modules/franc-min/index.js \
    --bundle --format=esm --platform=neutral --target=es2020 --charset=utf8 \
    --legal-comments=inline --tree-shaking=true \
    '--banner:js=// franc-min 6.2.0 and dependencies. MIT licenses: LICENSE.franc; provenance: README.franc.md.' \
    --outfile="${OUTPUT_PATH}/franc.mjs"

{
    for package in franc-min trigram-utils collapse-white-space n-gram; do
        printf '===== %s =====\n\n' "${package}"
        cat "node_modules/${package}/license"
        printf '\n'
    done
} > "${OUTPUT_PATH}/LICENSE.franc"

printf '%s  %s\n' \
    5b46d265b606806441574a8fb4f2d354e8ba4ae487cf4cbfe055628780915ace "${OUTPUT_PATH}/franc.mjs" \
    1309f7d0f603e5a26241e1836f4b56df67a2f9417cea2a51d005b066fd7f782f "${OUTPUT_PATH}/LICENSE.franc" \
    | sha256sum -c -

printf 'Rebuilt franc-min 6.2.0 in %s\n' "${OUTPUT_PATH}"
