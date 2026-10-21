# CyberDM

CyberDM 1.0.4 is a Windows download manager built with Electron. The goal is a capable, fully free desktop download manager and browser companion: no paid plan, trial expiry, speed tier, or feature lock. The app uses a dark interface and includes an HTTP download engine, video tools, and browser media detection.

This README describes what is in the current source and what still needs work. “Implemented” means there is code for the feature; it does not mean every supported site, server, or Windows installation path has been validated.

## Product principles

- Keep all CyberDM features free, including high quality video options and download acceleration.
- Make downloads reliable first: correct resume, pause, cancellation, recovery, and conflict behavior.
- Show live, truthful progress and speed, including for video and queued downloads.
- Make browser capture safe: if CyberDM is unavailable, Chrome must keep its download.
- Keep extension permissions understandable and ask only for what a feature needs.
- Use the IDM extension as a behavior reference. CyberDM has its own implementation, visuals, and product identity.

## Current capabilities

### Desktop app

- Electron main, preload, and renderer processes, with IPC for download and settings operations.
- HTTP/HTTPS download records and settings persisted with `electron-store`.
- Byte-range chunk downloads, chunk metadata, pause/resume/cancel, and startup recovery code.
- HTTP byte-range recovery reconciles metadata with on-disk chunk lengths; non-range downloads restart safely after interruption.
- Shared queue start/stop and queued-job reorder controls cover HTTP, yt-dlp media, and torrents; the stopped/started state persists across app restarts.
- Configurable 4–8 HTTP threads (the add-download thread choice applies to that job), up to 4 concurrent downloads, aggregate HTTP speed limit, retry attempts (including zero), retry delay in seconds, connection timeout, download folder, and file conflict mode. A scheduled speed cap combines with the saved limit without overwriting it.
- File type categories, category subfolders, history filtering, notifications, completion sound, speed graph, and system tray behavior.
- yt-dlp video information and download flows, quality selection that prefers direct HTTPS formats over HLS playlist variants, title-based filenames with the final media extension reported by yt-dlp, best-format fallback through yt-dlp (never a raw watch-page download), audio-only downloads, machine-parsed live bytes/speed/progress, and pause/resume/cancel through the shared download-list controls.
- HTTP/HTTPS direct-file downloads use the server's Content-Disposition filename (including UTF-8 extended filenames), then the URL path as fallback; servers that reject HEAD are checked with a one-byte Range request when supported.
- Clipboard URL detection, bandwidth profiles, checksum helpers, and stream grabbing have application flows. FTP/SFTP, archive extraction, video conversion, proxy, mirror, and login modules are present in source, but several do not have complete renderer controls or an end-to-end verified workflow yet; treat them as unfinished rather than guaranteed user-facing features.
- Torrent, stream capture, and Maya/Gemini code paths are present. Maya uses Google's Gemini 3.8 Flash API and needs the user's own Gemini API key; model access and quota follow the user's Google AI account. Use **Record Stream** in the Add URL dialog to queue a live capture at best quality. HTTP, yt-dlp video/stream, and torrent jobs appear in the main download list and share its concurrent-job limit. Update checks are optional and do not block use.

### Browser extension

- Chrome Manifest V3 service worker, page content script, popup, context menus, media scanning, and download interception code.
- Extension release 1.0.1 refreshes the popup and page overlay with CyberDM's dark glass and mint theme, uses the provided CyberDM logo, and ships correctly sized 16/32/48/128 px icons.
- The popup includes the active site, URL handoff, page scan, detected media, pending-request retry controls, auto-capture, and an opt-in browser-cookie setting.
- Direct media link and HTML media element detection, HLS/DASH URL heuristics routed into the yt-dlp quality flow, YouTube page handoff, and a page overlay.
- Link, selected-link, page-file, and page-media context actions; one native bridge request batches up to eight links.
- Pending-download storage with popup retry/dismiss controls when native messaging fails.
- Stable client request IDs make native-message retries and repeated Chrome download events idempotent; batch items retain individual IDs when queued for retry.
- `native-host-shim.exe` receives Chromium's stdio protocol outside Electron, reads the configured app path from LocalAppData, writes requests to local files, and starts/forwards CyberDM using short command-line IDs. Signed URLs stay out of process arguments, and acknowledgements only return after the desktop app accepts a request.
- `extension/` and `native-host/` are copied beside packaged app resources for manual extension loading and native host setup.

For Chrome Web Store submission, create the listing screenshots and provide an accurate privacy policy and data-use declarations. The extension handles browsing URLs and can access cookies when the user enables that option; the current broad host access and permissions must be justified against the published features and reviewed before submission. See Google's [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) for current requirements.

### Service and build files

- `api/` contains PHP licensing/payment/admin endpoints and a SQL schema.
- `native-host/` contains the Windows stdio shim source/binary, registry installer, and native-host manifest template. `scripts/build-native-host.js` compiles the shim during Windows builds.
- `scripts/download-tools.js` installs and verifies the pinned yt-dlp 2026.08.19 release from the [official yt-dlp release page](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) during development and builds.
- `dist/` contains generated Windows build output. It is not the source of truth.

## Version 1.0.4 duplicate capture protection

- Repeated captures of the same normalized source URL reuse the existing download: active/queued jobs are not duplicated, paused/failed jobs resume, and completed files are skipped while the saved file still exists.

## Version 1.0.3 startup and responsiveness

- The normal startup path starts loading the main window while the short splash is visible. The splash closes on the main window's first ready frame instead of holding startup for a fixed 3.5 seconds.
- The splash layout uses a smaller logo and reserved footer space so the Cyber Prince credit does not cover the title or loading indicator. Particle generation and long-running glow/gradient animations were removed.
- The main window is hidden until ready, uses an opaque background, and is no longer forced above other windows by the splash.
- Initial settings and download history load concurrently, and renderer event listeners attach before those requests complete.
- Background history refresh is visibility-aware, skips overlapping requests, and runs every 15 seconds. Live transfer progress still uses download events. Row refresh uses a cached row map instead of repeatedly searching the entire list.
- Logging appends asynchronously. Archive, video conversion, stream quality, FTP, and SFTP modules load only when those tools are called.
- These are code-level performance improvements. RAM and launch-time gains vary by PC and download history size; compare Task Manager and `debug.log` on the target machine before claiming numerical results.

## Version 1.0.2 stability fixes

- Browser native-message bursts are limited to two in-flight requests and six waiting requests. The native host also allows only one app launch/handoff at a time; when CyberDM is busy, Chrome keeps its original download.
- Secondary Electron launches request the single-instance lock before importing the download engine and other heavy modules, then exit immediately if another CyberDM process owns the lock.
- Restart recovery re-queues interrupted transfers and starts them through the configured concurrency limit. It no longer starts every saved download at once.
- Old native-message request/ack files are pruned after ten minutes; live browser handoffs remain available during app startup.
- HTTP chunk use is capped at eight connections per download, with four as the default. New installations default to two simultaneous downloads; existing user concurrency preferences are retained up to four.
- Windows build scripts use low-memory 7-Zip compression for portable and installer artifacts. The output may be larger than a maximum-compression build, while avoiding the multi-gigabyte memory spike observed with maximum compression.

## Version 1.0 support boundaries

- Direct HTTP/HTTPS file links work when the server allows CyberDM's request and response headers. Correct server-provided names take precedence; endpoint URLs fall back to the URL filename and known content type.
- HTTP download completion checks the bytes actually written against the advertised size, saves the final size and progress to history, and does not mark a non-empty response as complete when the output is empty or truncated.
- Video-page extraction uses the bundled yt-dlp release and supports the sites and formats that release can currently extract. A newer yt-dlp may be needed when a site changes its player.
- Some sites require sign-in, temporary browser cookies, a PO token, region access, or other authorization. CyberDM does not bypass DRM, paywalls, or site access controls. Those sources may need the extension's opt-in cookie setting or may remain unavailable.
- “Any website” cannot be guaranteed: sites with custom players, unsupported extractors, expiring cross-origin media URLs, or anti-automation checks may fail. The extension should keep the browser download when the desktop bridge does not accept the request.

## Known gaps to fix

These are source-review findings, not claims from a successful runtime test:

1. **Extension-to-app delivery has an acknowledged, idempotent native bridge.** The Windows shim's framed stdio and request/ack handoff have a targeted packaged-app smoke check. Direct HTTP/HTTPS links enter the engine; video page requests are persisted and open quality selection. The user's live Chrome handoff now opens CyberDM; end-to-end quality selection and completed media output still need runtime verification.
2. **Auto-capture now waits for app acceptance.** The extension only cancels Chrome's copy after CyberDM has probed the URL and accepted it into the desktop download engine. Failed handoffs keep Chrome's download and are recorded as pending.
3. **Media scanning is intentionally lightweight.** HLS/DASH manifest URLs route to yt-dlp's quality flow; the page scanner no longer serially probes each media URL with opaque `no-cors` `HEAD` requests, so sizes are unknown until a download begins. Stream URLs found in scripts remain heuristics and may be expired, protected, or incomplete manifests. The cookie toggle passes browser cookies to yt-dlp for the selected source origin; site-specific authorization headers and cross-origin media hosts still need support.
   For HTTP and yt-dlp captures, the extension has an opt-in cookie toggle. Cookies travel only in the local native handoff, are never retained in extension retry storage, are encrypted in the desktop download record, and are sent only to the original URL origin. yt-dlp receives a temporary cookie jar that is removed when the info lookup or download process ends.
4. **Progress paths differ.** HTTP, yt-dlp video/stream, and torrent jobs now emit live progress and use the download-list pause/resume/cancel controls. Media jobs preserve yt-dlp partial files; torrent jobs are re-added from their saved source after restart. Their internal transfer engines and progress details are still different.
5. **Queue coverage is partial.** HTTP, yt-dlp video/stream, and torrent jobs share the configured concurrent-job limit, persisted queue start/stop state, and reorder controls. Per-job priority, unified retry, and recovery behavior remain unfinished.
6. **Documentation was stale.** Older sections described features as missing even though new modules had been added, and advertised browser integration more completely than the native host supports.
7. **Several optional helper flows are not complete.** Proxy and mirror helpers have incomplete IPC wiring, site-login IPC is not exposed by the preload API, and the renderer's URL-refresh callback has no active main-process sender. These modules are not counted as complete product features until they have UI, working IPC, and runtime checks.
8. **Legacy server code remains outside the app.** Trial, activation, payment UI, IPC, and device-ID collection have been removed from the desktop. `api/` still contains old PHP endpoints, but the packaging file list does not include that folder and the desktop no longer calls those endpoints.

## Roadmap

Work through these in order and keep this checklist current as behavior is implemented and verified.

### 1. Make the free product truly unrestricted

- [x] Remove trial startup, paid-tier speed/thread/quality caps, and visible payment/activation prompts from the desktop app.
- [x] Keep update checks available without a paid account.
- [x] Keep legacy server files outside the packaged free desktop product; no license or payment IPC is exposed to the renderer.

### 2. Make the browser bridge dependable

- [x] Implement a native-messaging host mode that forwards requests to the running app or starts the app when closed.
- [x] Generate the native host manifest with the actual install path and extension ID during setup.
- [x] Keep Chrome's download unless the desktop engine confirms that it accepted the request.
- [x] Route Chromium stdio through an independent Windows shim and include it in portable resources.
- [ ] Verify a live Chrome YouTube handoff and quality dialog after browser restart.
- [ ] Add settings for auto-capture, file types, minimum size, and browser fallback behavior.
- [ ] Improve capture reliability for expiring/authenticated HLS/DASH streams and downloads initiated by browser scripts.
- [x] Show queued requests in the popup and let users retry or dismiss them.

### 3. Stabilize the download engine

- [x] Enforce one maximum simultaneous job limit and queue start/stop controls across HTTP, yt-dlp video/audio/stream, and torrent jobs.
- [x] Persist queue pause state across restarts.
- [x] Add shared-queue reordering controls for queued jobs.
- [ ] Add per-job priority independent of queue position.
- [x] Validate HTTP 206 range responses, Content-Range boundaries, known file size, and ETag/Last-Modified consistency when supplied; fall back to one connection when ranges are ignored.
- [x] Write standard HTTP downloads and chunk merges to temporary sibling files, verify their final size, and rename only after completion; pause/cancel waits for active streams to stop.
- [x] Save an enabled-days/time-window HTTP speed schedule from the desktop UI, including overnight windows.
- [ ] Unify retry, timeout, slow-chunk detection, dynamic splitting, speed limiting, and scheduling as one observable scheduler. HTTP range chunks and single-connection transfers retry transient failures and share an aggregate cap, but scheduling and recovery are not unified.
- [ ] Complete crash-safe recovery. HTTP chunk recovery reconciles temp files with byte ranges; yt-dlp video/stream jobs restart as paused and continue from partial files; torrent jobs are re-added from their saved source; single-connection HTTP jobs restart from zero. The queue's stopped/started state persists.
- [x] Add opt-in browser-cookie transfer for HTTP captures, with local encryption and same-origin request scoping.
- [x] Pass opt-in browser cookies to yt-dlp through a temporary Netscape cookie jar and delete it after each process.
- [ ] Support site-specific authorization headers and authenticated media hosts that differ from the source origin.

### 4. Unify live progress and controls

- [x] Show HTTP, video, torrent, and stream jobs in the shared download list with pause/resume/cancel actions.
- [ ] Unify their internal job model and event contract, and report retry state and active connections consistently.
- [ ] Report instantaneous and average speed, bytes, ETA, retry state, and active connections consistently.
- [ ] Add retry and per-job priority to the shared download-list controls; queued-job reorder controls are available.
- [x] Route yt-dlp video/stream and torrent pause, resume, and cancel through the download-list controls; preserve partial media files and recover active jobs after restart.
- [ ] Keep the UI responsive with batched progress updates and avoid rewriting the full list for every chunk event.

### 5. Build a distinct CyberDM extension

- [ ] Keep Manifest V3 and CyberDM branding; do not copy the reference extension’s source, assets, or UI.
- [x] Provide CyberDM-branded actions for a link, links in a selection, page download links, and page media.
- [ ] Add robust media detection, cross-tab/URL duplicate filtering, SPA navigation handling, and clear permission explanations. Repeated handoffs with the same request ID are already deduplicated across app restarts.
- [x] Keep the browser download when the desktop app is unavailable and expose queued requests for retry or dismissal.
- [ ] Cover Chrome and Edge installation and update instructions.

### 6. Integrate and review advanced features

- [ ] Bring mirrors, proxy, FTP/SFTP, extraction, checksums, and conversion jobs into the shared job list where practical. Stream and torrent jobs now use the shared queue and download list.
- [ ] Confirm which features are complete, which are prototypes, and which should be removed before a stable release.
- [ ] Review credentials, API keys, cookie handling, and external network requests for local storage and privacy expectations.
- [ ] Document platform and site limitations honestly; no download manager can bypass DRM or site access controls.

## Architecture map

| Area | Source of truth | Responsibility |
|---|---|---|
| Electron main process | `src/main.js` | Windows, IPC handlers, download engine, video tools, settings, optional subsystems |
| Renderer UI | `src/renderer.js`, `src/index.html`, `src/styles.css` | Download list, dialogs, settings, status/progress, user actions |
| Preload bridge | `src/preload.js` | Exposes a limited `window.cyberDM` API to the renderer |
| Download helpers | `src/chunk-splitter.js`, `src/recovery-manager.js`, `src/checksum.js` | Chunk planning, startup recovery, checksum operations |
| Scheduler | `src/scheduler/`, `src/bandwidth-scheduler.js` | Schedule/profile logic and bandwidth profile application |
| Network/media helpers | `src/*-client.js`, `src/*manager.js`, `src/video-converter.js`, `src/stream-grabber.js` | Protocols and optional download/media features |
| Browser extension | `extension/` | MV3 popup, page scanner/overlay, service worker and capture actions |
| Native messaging setup | `native-host/`, `src/main.js` | Host registration, framed stdin/stdout handling, single-instance forwarding, and download acknowledgement |
| Legacy service files | `api/` | Archived PHP payment/license endpoints, excluded from Windows app packaging and unused by the desktop app |

## Development setup

Requirements: Node.js 18 or newer and Windows for the packaged desktop targets.

```powershell
npm install
npm start
```

The install/build lifecycle runs `scripts/download-tools.js` to obtain media helper binaries. Builds use electron-builder:

```powershell
npm run build
npm run build:portable
npm run build:installer
npm run pack
```

The configured Windows targets are x64 NSIS installer and portable builds. `npm run lint` and `npm run format` are placeholders; no linter or formatter is configured.
Archive extraction dependencies, including `tar`, are production dependencies because the extractor module loads when the desktop app starts; keep them in the packaged runtime dependency tree.

## Tests

Jest tests currently cover chunk splitting, recovery, checksums, and scheduler core behavior. They do not cover Electron IPC, the extension/native host, end-to-end downloads, or installer registration.

```powershell
npm test
```

## Reference comparison

The local IDM reference is a Manifest V2 extension with a persistent background page, broad web request permissions, request-header handling, native messaging, and context actions for links, selected text, and page-wide downloads. CyberDM is Manifest V3 with a service worker, a media overlay/popup, basic page scanning, context actions, opt-in cookie transfer for HTTP downloads, and the new acknowledged handoff.

| Workflow | IDM reference | CyberDM source today | Remaining work |
|---|---|---|---|
| Capture normal browser downloads | Broad download interception | Captures selected file types, optionally includes browser cookies, and leaves Chrome in control unless the app accepts | Add user filters and verify with real Chrome/Edge downloads |
| Download a link from context menu | Link and selected-text actions | Link/media context action | Add selected links and page-wide link collection |
| Detect media on a page | Frame/page request tracking | Video/audio elements, direct links, HLS/DASH URL heuristics routed to yt-dlp, YouTube handoff | Handle expiring URLs, authenticated requests, and dynamic players reliably |
| Talk to the desktop app | Native messaging | Native host mode forwards to the single desktop instance and waits for request acceptance | Verify installed and portable app paths on Windows |
| Permissions | Includes broad request, cookie, and proxy permissions | Uses broad site access, downloads, tabs, scripting, storage, web requests, and cookies | Reduce permanent `<all_urls>` access and request optional site access where practical |

The reference package's background implementation is minified and its assets belong to IDM. CyberDM should match useful workflows with its own code, UI, and branding rather than copying that implementation or its assets.

## License

CyberDM source is MIT licensed. The project’s goal is to keep CyberDM’s desktop and extension features free. Third-party tools and libraries retain their own licenses; see their distribution terms before redistributing builds.
