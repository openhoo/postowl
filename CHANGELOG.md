# postowl Changelog

## 0.5.0 (2026-07-16)

### Features

- **response:** add adaptive previews (485f4cb)

### Other Changes

- **tauri:** sync generated metadata (38aa729)

## 0.4.1 (2026-07-16)

### Bug Fixes

- **security:** patch test dependency (f1ac574)

## 0.4.0 (2026-07-16)

### Features

- **ui:** migrate to Tailwind CSS (846fc4f)

## 0.3.1 (2026-07-16)

### Other Changes

- sync v0.3.0 lockfile (fe9dd11)

### Bug Fixes

- harden request and persistence workflows (6f74204)

## Unreleased

### Improvements

- Harden request, environment, workspace import, and persistence validation.
- Preserve exact response JSON values with raw and lossless pretty views.
- Automatically select JSON, XML, sandboxed HTML, and image response previews from the response content type.
- Improve keyboard navigation, responsive layouts, field errors, dirty-state protection, and accessible control labels.
- Prevent request-operation races and stale script-produced environment updates.
- Make native end-to-end tests rebuild reliably on Node 26 and Wayland workstations.

## 0.3.0 (2026-07-16)

### Features

- **ui:** migrate desktop to SolidJS (5cb6630)

## 0.2.2 (2026-07-16)

### Bug Fixes

- harden native desktop workflows (8eaf011)

## 0.2.1 (2026-07-16)

### Bug Fixes

- **release:** limit checksums to bundle assets (925688c)

## 0.2.0 (2026-07-16)

### Features

- launch PostOwl desktop REST client (d084b3c)
