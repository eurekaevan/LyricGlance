# Vendored language detector

`franc.mjs` bundles [franc-min 6.2.0](https://github.com/wooorm/franc/tree/6.2.0/packages/franc-min)
and its three runtime dependencies as readable, self-contained ESM. The upstream
82-language model and detection algorithm are unchanged. esbuild bundles and
formats the source without minification; the only added content is a provenance
banner. Detection runs offline in GJS, with no runtime Node.js, npm, network,
external imports, or native library dependencies.

All bundled packages are MIT licensed. `LICENSE.franc` retains the complete
upstream notices for franc-min, trigram-utils, collapse-white-space, and n-gram.
The franc-min npm archive omits its license, so the build fetches and verifies
the license from the upstream `6.2.0` tag separately.

## API and limits

The bundle exports `franc(value, options)` and `francAll(value, options)`.
`franc` returns the most likely ISO 639-3 language code; `francAll` returns ordered
`[code, score]` tuples. `und` means undetermined. Options include `only`, `ignore`,
and `minLength` (default 10 UTF-16 code units). The detector examines at most the
first 2,048 UTF-16 code units of each input. Scores are normalized relative
distances, not probabilities: the first result has score 1 even for ambiguous
input. Callers must decide whether the evidence is sufficient for their use.

## Pinned inputs

The build extracts exactly these npm archives into a temporary directory. It
does not resolve version ranges or run npm lifecycle scripts. The build-only
esbuild binary is MIT licensed and is not included in the extension.

| Input | Version | Archive SHA-256 |
| --- | --- | --- |
| [franc-min](https://registry.npmjs.org/franc-min/-/franc-min-6.2.0.tgz) | 6.2.0 | `82417c7fe3778988b00b1b0c4db783b583ce9c8321dd7279f7a7f67709686654` |
| [trigram-utils](https://registry.npmjs.org/trigram-utils/-/trigram-utils-2.0.1.tgz) | 2.0.1 | `3390b247fcb2dc1589ee3fa714986bce010af465446299746ee9928094bee8e6` |
| [collapse-white-space](https://registry.npmjs.org/collapse-white-space/-/collapse-white-space-2.1.0.tgz) | 2.1.0 | `7e2300655decce051cf4c8ece8cf997ed0c16ce6eb3cec975529d12cfa211d5e` |
| [n-gram](https://registry.npmjs.org/n-gram/-/n-gram-2.0.2.tgz) | 2.0.2 | `05cf48444f90a33bac1750cf30f18dbafd975b8006d6c6496acccf93571df504` |
| [@esbuild/linux-x64](https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz) | 0.25.12 | `f7efc127658a108dcda9d4210b01804ee8f5d6b3acbd6d63f20aa51d3b50bd5f` |

[franc's upstream license](https://raw.githubusercontent.com/wooorm/franc/6.2.0/license)
SHA-256: `f5e0c5c44706ddda7ac2f9096f848222f1e0e90f88643955041c2735be84592b`.

## Reproduce and verify

On Linux x86-64, with Bash, curl, tar, GNU coreutils, and network access:

```sh
tools/update-franc.sh /tmp/lyric-glance-franc-6.2.0
cmp franc.mjs /tmp/lyric-glance-franc-6.2.0/franc.mjs
cmp LICENSE.franc /tmp/lyric-glance-franc-6.2.0/LICENSE.franc
```

The script verifies every downloaded input and both generated outputs. All
build inputs live under `/tmp` and are removed on exit; the output directory is
retained. Node.js and npm are not needed. Linux x86-64 is a reproduction
requirement for the pinned build tool, not a runtime requirement for the ESM.

The exact bundling command, from the temporary build directory, is:

```sh
node_modules/@esbuild/linux-x64/bin/esbuild node_modules/franc-min/index.js \
    --bundle --format=esm --platform=neutral --target=es2020 --charset=utf8 \
    --legal-comments=inline --tree-shaking=true \
    '--banner:js=// franc-min 6.2.0 and dependencies. MIT licenses: LICENSE.franc; provenance: README.franc.md.' \
    --outfile=/tmp/lyric-glance-franc-6.2.0/franc.mjs
```

Output SHA-256:

- `franc.mjs` (113,894 bytes):
  `5b46d265b606806441574a8fb4f2d354e8ba4ae487cf4cbfe055628780915ace`
- `LICENSE.franc` (4,632 bytes):
  `1309f7d0f603e5a26241e1836f4b56df67a2f9417cea2a51d005b066fd7f782f`
