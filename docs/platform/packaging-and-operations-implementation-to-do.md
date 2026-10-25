# Packaging and Operations Implementation To-Do

Companion specification: [Packaging and Operations](packaging-and-operations.md)

## Desktop distribution

- [x] Generate canonical native-v4 Machine-Listening-Development and Midi-Capture
  bundles through every electron-builder entry point; validate complete portable
  hashes/resources without source promotion or machine configuration.
- [x] Verify the integrated wire-4 dual-mode bundle after merging mode, full-loop
  and advisory timing changes; reject Session-only, implicit-mode or oversized
  provider claims even after self-rehashing. Synthetic installed-artifact tests
  verify qmetro graph entries and explicit per-pass mode metadata.
- [x] Install that integrated wire4/protocol8 candidate after user app closure.
  Verify all three installed components are current, actual qmetro/mode metadata
  is correct and the signed installed Desktop authenticates and launches.
  Deployment trace: `bbcb1938-a23d-4e60-a32d-7170bad682d6`.
- [ ] Physically qualify the new candidate in fresh Live/device instances;
  historical v3 installs and packaged smoke tests are not capture acceptance.
- [x] Install both managed bundles with the Remote Script through a shared typed
  installer and CLI, preserving tokens/unrelated files and stopped-Live guards
  even when Python is skipped.
- [x] Cover profile/custom-Library selection, atomic component replacement,
  explicit partial outcomes, cancellation, recovery and bounded traced history.
- [x] Verify packaged no-checkout delivery and reinstall the normal app and devices.
- [ ] Complete fresh Live11 registration/MIDI-ingress acceptance. Both exact
  isolated devices were loaded in owned Live 11.3.43; further physical checks
  were stopped at the user's request and handed off for manual verification.

- [x] Configure reproducible development and production builds.
- [x] Provide a fail-fast, host-architecture macOS development install command
      that cleans stale artifacts, verifies the package, updates the Remote
      Script, locally signs, atomically replaces, and launches the installed app.
- [x] Bundle architecture-matched Copilot SDK and Koffi native runtimes in
  Intel and Apple Silicon macOS artifacts.
- [x] Configure branded macOS, Windows, and runtime application icons.
- [ ] Configure macOS and Windows signing/notarization.
- [x] Build installers with explicit Remote Script setup.
- [x] Detect supported Ableton/User Library locations.
- [x] Implement Remote Script install, update, backup, and manual-path flow.
- [x] Generate/store per-installation authentication credentials securely.
- [x] Auto-provision the installed Remote Script token into the Desktop
      OS-backed credential vault with conflict and invalid-file diagnostics.

## Version and update management

- [x] Define app, Remote Script, protocol, and database version sources.
- [x] Restrict the compatibility matrix to Live 11, retaining the existing
  11.3+ API baseline without a patch pin. Record installed Suite 11.3.43 as the
  current development host, preserve exact historical versions, and cover
  older/newer Live 11 patches plus Live 12 rejection in compatibility tests.
  Automatic patch updates alone do not require downgrade or block development.
- [~] Implement compatibility checks and upgrade prompts.
  - [x] Surface Live, protocol, and Remote Script compatibility in desktop
    diagnostics.
  - [ ] Add one-click Remote Script upgrade prompts in the renderer.
- [ ] Implement signed desktop updates.
- [x] Implement Remote Script artifact updates independently.
- [ ] Test upgrade from the previous supported version.

## Operations and privacy

- [~] Implement structured, redacted, correlated logs.
  - [x] Write structured JSON logs and redact credentials, prompts, paths, and
    musical labels by default.
  - [ ] Propagate correlation IDs through every runtime boundary.
- [x] Implement diagnostics and support-bundle export.
- [x] Adopt a versioned `~/.live-agent` root with profile isolation, safe
  environment overrides, staged legacy migration, and typed storage
  diagnostics.
- [x] Define privacy settings and telemetry consent.
- [x] Limit default telemetry to operational metadata.
- [ ] Implement the separate default-on, local-only detailed event journal with
  producer-boundary sanitization and no upload transport.
- [ ] Enforce 30-day retention and a 250 MiB profile cap; add pause, clear, and
  per-session deletion controls.
- [~] Add retention and deletion controls for logs/session metadata.
  - [x] Bound logs by age and size.
  - [ ] Add in-app session-metadata deletion controls.
- [x] Publish supported platform and Live-version matrix.
- [x] Add isolated automation profiles, owner-only endpoint discovery, and
  per-launch loopback authentication for developer UX testing.

## Tests

- [x] Build macOS installers in CI.
- [x] Smoke-test the generated macOS application in packaged production mode.
- [x] Verify the exact installed macOS application can discover GitHub CLI
  authentication and list Copilot models from a Finder-like environment.
- [ ] Restore Windows installer CI before Windows release support.
- [ ] Test clean install, upgrade, repair, and uninstall in fresh environments.
- [x] Test Remote Script detection and all install-path variants.
- [x] Test clean-install credential auto-provisioning, precedence, invalid
      tokens, and conflicting installations.
- [x] Test incompatible/outdated script flows.
- [x] Test log and support-bundle redaction.
- [ ] Test journal redaction, local-only behavior, default-on migration,
  retention, size-cap eviction, and persistence-failure diagnostics.
- [ ] Test offline startup and update-service failure.
- [x] Test automation endpoint authentication, cleanup, bounded framing,
  isolated launch options, and visible Electron message delivery.

## Exit criteria

- [ ] Signed builds install on clean supported systems.
- [~] App and Remote Script compatibility is visible and recoverable.
- [x] Support bundles contain diagnostics without musical content or secrets.
- [ ] Release artifacts and checksums are reproducible and published.
