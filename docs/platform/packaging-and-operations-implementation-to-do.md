# Packaging and Operations Implementation To-Do

Companion specification: [Packaging and Operations](packaging-and-operations.md)

## Desktop distribution

- [ ] Configure reproducible development and production builds.
- [ ] Configure macOS and Windows signing/notarization.
- [ ] Build installers with explicit Remote Script setup.
- [ ] Detect supported Ableton/User Library locations.
- [ ] Implement Remote Script install, update, backup, and manual-path flow.
- [ ] Generate/store per-installation authentication credentials securely.

## Version and update management

- [ ] Define app, Remote Script, protocol, and database version sources.
- [ ] Implement compatibility checks and upgrade prompts.
- [ ] Implement signed desktop updates.
- [ ] Implement Remote Script artifact updates independently.
- [ ] Test upgrade from the previous supported version.

## Operations and privacy

- [ ] Implement structured, redacted, correlated logs.
- [ ] Implement diagnostics and support-bundle export.
- [ ] Define privacy settings and telemetry consent.
- [ ] Limit default telemetry to operational metadata.
- [ ] Add retention and deletion controls for logs/session metadata.
- [ ] Publish supported platform and Live-version matrix.

## Tests

- [ ] Build installers in CI for macOS and Windows.
- [ ] Test clean install, upgrade, repair, and uninstall in fresh environments.
- [ ] Test Remote Script detection and all install-path variants.
- [ ] Test incompatible/outdated script flows.
- [ ] Test log and support-bundle redaction.
- [ ] Test offline startup and update-service failure.

## Exit criteria

- [ ] Signed builds install on clean supported systems.
- [ ] App and Remote Script compatibility is visible and recoverable.
- [ ] Support bundles contain diagnostics without musical content or secrets.
- [ ] Release artifacts and checksums are reproducible and published.

