<div align="center">

# PostOwl

**A fast, native REST workspace for composing requests, inspecting responses, and keeping an exact local history.**

[![CI](https://github.com/openhoo/postowl/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoo/postowl/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/openhoo/postowl)](https://github.com/openhoo/postowl/releases/latest)
[![License](https://img.shields.io/github/license/openhoo/postowl)](LICENSE)

</div>

PostOwl is a local-first desktop API client built for focused request work. It combines a compact native shell with a precise request editor, response telemetry, scripting, environments, and persistent history—without requiring an account or remote service.

## Highlights

- Compose HTTP requests with query parameters, headers, and JSON or text bodies.
- Reuse values through local environments and variable substitution.
- Run isolated QuickJS scripts before requests and after responses.
- Inspect status, timing, captured size, headers, assertions, and script logs.
- Automatically preview JSON, XML, sandboxed HTML, and supported images.
- Preserve response history in a local SQLite workspace.
- Import and export complete workspaces as JSON.
- Navigate the full request and response workflow with the keyboard.

## Technology

- [Tauri 2](https://v2.tauri.app/) and Rust for the native application
- [SolidJS](https://www.solidjs.com/) for the interface
- SQLite for local persistence
- QuickJS for request and response scripting
- WebDriverIO for native end-to-end coverage

## Development

### Prerequisites

- Node.js 22 or newer
- [pnpm 11](https://pnpm.io/installation)
- Rust 1.88 or newer
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

### Run locally

```bash
pnpm install
pnpm tauri dev
```

### Verify changes

```bash
pnpm check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e
```

The native end-to-end suite builds PostOwl with its test-only WebDriver feature and uses an isolated temporary data directory.

### Build a desktop bundle

```bash
pnpm tauri build
```

Generated bundles are written beneath `src-tauri/target/release/bundle/`.

## Project layout

```text
src/                  SolidJS application
src/lib/components/   Request, response, environment, and sidebar UI
src-tauri/src/        Tauri commands, HTTP execution, scripting, and SQLite
scripts/              Release and version synchronization utilities
tests/e2e/            Native WebDriver workflow coverage
```

## Data and privacy

PostOwl stores workspaces and response history locally. Workspace exports can contain request URLs, headers, bodies, scripts, environment values, and recorded responses; review exported files before sharing them.

## License

[MIT](LICENSE)
