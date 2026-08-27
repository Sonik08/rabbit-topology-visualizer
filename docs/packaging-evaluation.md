# Packaging evaluation — browser vs Tauri / Electron

_Date: 2026-08-27._

## TL;DR

Ship as a **browser-served static app** for now. Revisit **Tauri** (preferred over Electron on bundle size and memory grounds) only if a concrete user story requires a browser-API capability we lack — see [Switching criteria](#switching-criteria).

## Scope of this document

Decision doc, not a benchmark or spike report. No packaging attempt has been made. Bundle-size and RAM figures below are qualitative from published documentation — treat them as planning estimates, not measurements.

## What the app needs from the host today

- **Read a single file** the user drops or picks (`.rar`, `.zip`, `.json`).
  - Handled by `<input type="file">` + `File.arrayBuffer()` in `src/ui/components/ImportPanel.tsx`.
  - Archive decompression is fully in-JS (`jszip` for zip, `node-unrar-js` for rar) so no native binary is required.
- **Run parsing + graph work off the UI thread**.
  - Handled by the Web Worker path in `src/core/import/importArchiveWorkerClient.ts` (see `docs/render-engine-evaluation.md` for how the pipeline is wired).
- **Persist nothing.** No cookies, no `localStorage`, no IndexedDB. Every import lives in memory for one session.
- **Never touch data outside `data/raw/`.** The verification pre-flight in `scripts/verify.sh` enforces that raw topology exports do not get committed.

None of these have hit a browser-API limit yet.

## What packaging as Tauri or Electron would (plausibly) enable

Qualitative from vendor documentation — no measurement performed here.

| Capability | Browser (today) | Tauri | Electron |
| --- | --- | --- | --- |
| Read a single user-picked file | Yes (`<input type="file">`) | Yes + native path | Yes + native path |
| Drop-a-folder import (multiple files, nested) | File System Access API in Chromium; not in Safari/Firefox | Yes | Yes |
| Watch a directory for new exports | Not available (no filesystem watcher in the browser) | Yes (rust `notify` crate) | Yes (`chokidar`) |
| Save reports back to the export folder | Blob download only (user-directed) | Yes (native save dialog + write) | Yes (`fs.writeFile`) |
| System tray / OS notifications | Notifications API (limited) | Yes | Yes |
| Offline install / distributable | Static PWA install | Yes (single binary) | Yes (heavier binary) |
| Ship size (indicative, qualitative) | Static Vite build (main JS + worker chunk); no reproducible installer-size measurement recorded in this doc | Advertised sub-10 MB installer on many platforms per the Tauri docs — unmeasured for this app | Typically 100 MB+ installer per Electron's own guidance — unmeasured for this app |
| Runtime memory footprint | Whatever the browser tab uses | Uses the OS webview → typically closer to a plain browser tab | Bundles Chromium → typically a few hundred MB baseline |
| Auto-update | PWA re-fetch or manual reload | Built-in updater (signed) | Squirrel / autoUpdater |

## Where the current app might hit a browser wall

Nothing today rises to the level of a blocker. Cases we have discussed informally:

1. **Batch import of a folder of split-dump files** (`queues.json`, `bindings.json`, …). The existing importer already accepts a single archive or JSON file. Multi-file browser selection with `<input type="file" multiple>` works cross-browser; folder drop needs `File System Access API` which Firefox and Safari lack. Not blocked yet.
2. **Comparing two topology exports over time**. Watching a directory would automate the workflow — a browser can't do that. But the workflow is not requested by any concrete user story on the backlog.
3. **Sharing a persistent workspace across sessions**. Would need `localStorage` / IndexedDB / native storage. Explicitly out of scope today (session-only, no persistence) so this is a policy choice, not a browser limit.

## Switching criteria

Package as Tauri only when **at least one** of these becomes a hard requirement:

1. A user story on the backlog explicitly requires a filesystem watcher or "point at a folder" batch import that is not supported in Firefox / Safari via `<input type="file" multiple>` or drag-and-drop.
2. Persistence across sessions is added to the roadmap and IndexedDB is judged insufficient.
3. Distribution to an offline-first / air-gapped environment where a browser is not available.

Below **all** of these, ship as a static build behind whatever HTTP server the user prefers.

## Why Tauri over Electron if we do switch

Qualitative comparison based on published documentation from each project — no measurements against this app.

- **Runtime architecture**: Tauri reuses the OS webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux), while Electron bundles its own copy of Chromium and Node. This has documented implications for installer size and steady-state memory that we would need to measure on the target hardware before quoting numbers.
- **Native process language**: Tauri's backend is written in Rust; Electron's is written in Node.js. Neither language carries an intrinsic security guarantee — treat this as a language/ecosystem choice with different supply-chain surfaces to review, not a claim that one is safer than the other. Any specific security judgment should cite a concrete CVE history or audit rather than being asserted here.
- **Project activity**: both projects are actively maintained as of the time of writing; verify current release cadence and LTS policy against each project's release page before committing.

Electron is the fallback if a target platform lacks a modern webview (e.g. some older Linux distros).

## Migration plan (only if triggered)

If a switching criterion is met and the requirement is agreed with stakeholders:

1. Spike `tauri init` in a throwaway branch. Verify `pnpm run tauri dev` boots the existing Vite build unchanged.
2. Introduce a thin `Host` abstraction:
   - `HostFilesystem.pickFiles({ multiple, extensions })` — implemented against `<input type="file">` on the web and Tauri's `dialog.open` inside the app.
   - `HostFilesystem.watchDirectory(path, handler)` — noop on the web, `notify` binding in Tauri.
3. Refactor `ImportPanel` (and the yet-to-be-built folder-drop UI) to consume the abstraction.
4. Wire the Web Worker to use `postMessage` inside the Tauri webview (same code path as browser).
5. Add a Tauri-signed release job to `.github/workflows/ci.yml` for the tagged-release event.
6. Update `docs/README.md` with distribution instructions for the new binary.

## How to measure before proposing a switch

Before opening a switching proposal:

1. Point to a specific user story that needs the missing capability.
2. Show that the browser API path (multi-select, drag-drop, PWA install) is insufficient — either by prototyping it or by citing a documented browser limitation with a link.
3. Log installer size and cold-start memory for both engines against the current build under `docs/packaging-benchmarks/<YYYY-MM-DD>.md`.

## Decision

**Not packaging as Tauri or Electron now.** No user story on the backlog requires it, and the existing browser + Web Worker path handles every import shape the app supports today. Task 64 is closed as an evaluation with concrete criteria and a migration plan for the future.

## References

- `src/ui/components/ImportPanel.tsx`
- `src/core/import/importArchiveWorkerClient.ts`
- `scripts/verify.sh` (raw-data safety pre-flight)
- Tauri: https://tauri.app
- Electron: https://www.electronjs.org
- File System Access API status: https://caniuse.com/native-filesystem-api
