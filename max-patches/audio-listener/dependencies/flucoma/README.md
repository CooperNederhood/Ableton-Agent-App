# Pinned stock diagnostic dependencies (#92 and #95 smoke)

The unmodified macOS `fluid.spectralshape~.mxo` and `fluid.pitch~.mxo` bundles are
redistributed. The listener ships them beside the device under
`dependencies/flucoma/`; these are not a user-installed Max
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
  moves from `externals/` into this directory. `LICENSE.md`, `package-info.json`,
  `docs/fluid.spectralshape~.maxref.xml` and `docs/fluid.pitch~.maxref.xml` are
  verbatim extracted files.
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

The pitch bundle independently passes `codesign --verify --strict`; identifier
`org.flucoma.fluid.pitch-tilde`, same Team ID and authority, timestamp
2026-10-10 06:40:50, stapled ticket. Its 544,048-byte universal binary has SHA-256
`23e23676725b4f7fa37327a74ed4d4c70ddf09b56dcf76c835fdfd25ab23d02b`;
both slices have the same four system/host dependencies listed above.
All four bundle files retain their upstream signed bytes; binary mode is 0755.

## Pitch diagnostic profile (unqualified)

The pinned reference documents `algorithm 2` as YinFFT, `unit 0` as Hz,
`fftsettings` as window/hop/FFT samples and `select pitch confidence` as a
selection retaining normal pitch-then-confidence order. The upstream help
patch confirms paired list delivery on outlet 0 (one inlet, two outlets).
The fixed smoke configuration is 50–2,000 Hz, independent stereo, and
2,048/2,048/2,048 samples. No frame support or numeric accuracy is asserted.
The documented undefined sentinel is 0 Hz (-999 in unused MIDI mode).
Confidence is a finite 0–1 algorithm-specific YinFFT score, not a calibrated
probability, harmonic-to-noise ratio, or success threshold. Positive candidates
are not proven notes. Octave errors, short-window low-note limitations and
unreliable polyphonic mixtures remain unqualified.

The two-channel gate publishes at most 10 snapshots/second/channel and 400
deliveries/channel. The pitch lifecycle has 24 fixed facts and at most 96
attempted events of 8,192 bytes each; progress reserves terminal headroom.
The separate existing three-descriptor SpectralShape budget remains 288.
Both physical gate stop acknowledgements join the shared capture cleanup.
Normal builds only verify/copy these pinned local files and never download.

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
