# Pinned spectral-shape dependency (#92 smoke)

Only the unmodified macOS `fluid.spectralshape~.mxo` bundle is redistributed.
The listener ships it beside the device at
`dependencies/flucoma/fluid.spectralshape~.mxo`; it is not a user-installed Max
package, a custom native wrapper, or a fallback analyzer. Builds are offline.
The publisher and installer preserve its signed bundle structure and executable
mode. It stays adjacent to frozen AMXD resources: a native bundle must not be
encoded as an archive-only text file.

## Provenance and notices

- Upstream: <https://github.com/flucoma/flucoma-max/releases/tag/1.0.10>
- Asset: `FluCoMa-Max-1.0.10.zip`, 91,263,396 bytes.
- Archive SHA-256:
  `238d7f0528828a29b53555066381ecb9bc017f0a9b147b18d1cb96d2e2a44196`.
- Release build: `a1f6f90a584f9d369344e6a81bf8f155e4a58972`.
- Extracted package version: `1.0.10+sha.a1f6f90.core.sha.f1551f70`.
  The core revision is the package's abbreviated claim, not a independently
  reproduced build or the previously inspected `9a06a915` core.
- Original archive paths begin `FluidCorpusManipulation/`; the bundle alone
  moves from `externals/` into this directory. `LICENSE.md`, `package-info.json`
  and `docs/fluid.spectralshape~.maxref.xml` are verbatim extracted files.
- `LICENSE.md` contains the University of Huddersfield BSD-3-Clause license,
  Alex Harker's HISSTools BSD-3-Clause notice and the Eigen MPL-2.0 notice/source
  link. Those notices accompany every distribution. Eigen source and license:
  <https://gitlab.com/libeigen/eigen>, <https://www.mozilla.org/MPL/2.0/>.
  No endorsements or ownership of upstream code are implied.

Static inspection (no execution of the external): universal `x86_64 arm64`
Mach-O bundle; both slices link only the host's
`@executable_path/../Frameworks/MaxAudioAPI.framework/Versions/A/MaxAudioAPI`,
Apple Accelerate, `libc++.1.dylib` and `libSystem.B.dylib`. The upstream signature
verifies with `codesign --verify --strict`; identifier
`org.flucoma.fluid.spectralshape-tilde`, Team ID `C492MVUR7P`, Developer ID
Application Pierre Alexandre Tremblay, timestamp 2026-10-10, stapled notarization
ticket. This is not proof of runtime loading or Live 11 compatibility.

## Packaging contract and remaining qualification

The application-owned pin table in `packages/shared/src/flucoma-dependency.ts`
bounds and hashes every file, including this notice. Missing, stale, extra,
symlinked, or tampered dependency files fail packaging before publication;
rewriting a payload manifest cannot authorize a different external. No archive
download, package search, recursive arbitrary resource copying, OS trust bypass
or normal-profile installation occurs during a build.

- [x] Minimal immutable bundle, notices, offline pins and explicit nested-file
  inventory in listener generation, packaged payloads and installer.
- [x] Deterministic integrity, containment and publication lifecycle coverage.
- [ ] Separately authorized existing-fixture host smoke: prove the direct stock
  object resolves this exact bundled external, not a user search-path copy.
- [ ] Qualify actual outlet delivery and independent frame support before
  claiming authoritative flatness observations. No numerical qualification,
  Live/Max launch, trust-setting change or installation is authorized here.
