---
name: esbuild + pdfkit runtime asset loading
description: pdfkit's standard fonts throw ENOENT after esbuild bundling; requires a post-build copy step.
---

`pdfkit` loads its standard fonts (Helvetica, Courier, Times, etc.) by
`fs.readFileSync`-ing `.afm` files from a path relative to `__dirname` at
runtime — this happens automatically the moment a `PDFDocument` is
constructed (it calls `initFonts()` in its constructor), not just when a
non-default font is requested.

esbuild bundles the JS but has no way to see or inline this dynamic
filesystem read, so after bundling into a single `dist/index.mjs`, the
`data/*.afm` files pdfkit expects next to its own module simply aren't
there, and the very first `new PDFDocument()` throws
`ENOENT: ... open '.../dist/data/Helvetica.afm'`.

**Why:** esbuild only bundles statically-analyzable `import`/`require`
graphs; runtime `fs` reads relative to `__dirname` are invisible to it.

**How to apply:** in the build script (e.g. `build.mjs`), after the
esbuild bundle step, copy the resolved `pdfkit/js` package's `data/`
directory into the output directory (e.g. next to `dist/index.mjs`) so
the same relative-path lookup still resolves post-bundle. Any other
library that reads asset files from disk at runtime relative to its own
module location (rather than importing them) will hit the same failure
mode and needs the same fix — copy the assets alongside the bundle
output as a post-build step.
