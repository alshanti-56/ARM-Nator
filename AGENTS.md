# Development app instructions

- Use `pnpm dev` from this repository for the active development app.
- When inspecting or controlling the running app, target the Electron executable
  under this repository's `node_modules/.pnpm/electron@*/.../Electron.app`, or
  the window titled `ARM-Nator`. Do not target the generic app name `Electron`:
  it can launch an unrelated default Electron shell from another checkout.
- Keep only the current repository's dev process running. The app enforces a
  single instance for its user-data directory; close stale Electron shells from
  other checkouts before inspecting the UI.
