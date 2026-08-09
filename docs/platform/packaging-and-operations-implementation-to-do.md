# Packaging and Operations Implementation To-Do

Companion specification: [Packaging and Operations](packaging-and-operations.md)

## Desktop distribution

- [x] Configure reproducible development and production builds.
- [ ] Configure macOS and Windows signing/notarization.
- [x] Build installers with explicit Remote Script setup.
- [x] Detect supported Ableton/User Library locations.
- [x] Implement Remote Script install, update, backup, and manual-path flow.
- [x] Generate/store per-installation authentication credentials securely.

## Version and update management

- [x] Define app, Remote Script, protocol, and database version sources.
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
- [x] Define privacy settings and telemetry consent.
- [x] Limit default telemetry to operational metadata.
- [~] Add retention and deletion controls for logs/session metadata.
  - [x] Bound logs by age and size.
  - [ ] Add in-app session-metadata deletion controls.
- [x] Publish supported platform and Live-version matrix.

## Tests

- [x] Build installers in CI for macOS and Windows.
- [ ] Test clean install, upgrade, repair, and uninstall in fresh environments.
- [x] Test Remote Script detection and all install-path variants.
- [x] Test incompatible/outdated script flows.
- [x] Test log and support-bundle redaction.
- [ ] Test offline startup and update-service failure.

## Exit criteria

- [ ] Signed builds install on clean supported systems.
- [~] App and Remote Script compatibility is visible and recoverable.
- [x] Support bundles contain diagnostics without musical content or secrets.
- [ ] Release artifacts and checksums are reproducible and published.
