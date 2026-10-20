# Toolchain maintenance

The current version pins live in [package.json](../package.json),
[.nvmrc](../.nvmrc), and [pnpm-workspace.yaml](../pnpm-workspace.yaml).
These files are authoritative; historical upgrade reports are not version
requirements for the current checkout.

## Updating pins

- Change `engines.node`, `devEngines.runtime.version`, and `.nvmrc` together.
- Change `engines.pnpm` and the integrity-pinned `packageManager` together.
- Use the direct Node installation and install the pinned pnpm version.
- Refresh the lockfile, then verify `pnpm install --frozen-lockfile` and
  `pnpm verify:environment` before running relevant tests, lint, and builds.
- Shell Node/pnpm, Electron's embedded Node, and native build tools are
  separate runtimes. Electron's embedded Node does not follow the shell pin.

## Compatibility exceptions

Strict engine and peer checks remain enabled. `pnpm-workspace.yaml` contains
narrow version-specific exceptions for `ngx-indexed-db` Angular peers and
`nx-electron` Nx peers, plus the latter's build dependency extensions.
The local `nx-electron` patch is registered there as well. Review those
exceptions when upgrading the named packages; do not broaden them globally.

## Native artifacts

Use `pnpm dev` for ordinary development. The existing fingerprint checks reuse
native player artifacts when their inputs and toolchains are unchanged.
After changes to Electron, native dependencies, Swift/Metal/MPV inputs, or
relevant build configuration, run the applicable rebuild and verify the
packaged application. Production lifecycle commands may perform native
checks/rebuilds; see the project README for current commands.

Record actual verification and outstanding failures in the current handoff.
The archived upgrade report retains the earlier migration and test history.
