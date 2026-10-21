# Changelog

## [1.0.4] - 2026-10-14

### Fixed
- Auto-captured downloads now reuse an existing record for the same normalized source URL instead of creating repeated copies.
- Repeated captures resume paused or failed downloads; active/queued downloads are left alone.
- Completed downloads are skipped while their saved file exists. If that file was removed, a new capture is allowed.

## [1.0.3] - 2026-10-14

### Performance and startup
- Start the main window during the splash phase and close the splash as soon as the app is ready instead of waiting through a fixed 3.5-second delay.
- Reserve separate layout space for the splash developer credit and remove animated particles and continuous splash effects.
- Use an opaque, initially hidden main window to reduce compositor work and prevent the splash/main window overlap.
- Load renderer settings and download history concurrently, attach event listeners first, skip background polling while hidden, and refresh history every 15 seconds without overlapping requests.
- Use a cached download-row map for in-place updates and asynchronous debug-log writes.
- Defer optional archive, conversion, stream-quality, FTP, and SFTP modules until a user calls those features.

All notable changes to CyberDM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.2] - 2026-10-11

### Fixed
- Prevented extension download bursts from launching many heavy Electron instances at once with early single-instance locking, a native-host launch gate, and a bounded extension handoff queue.
- Changed restart recovery to re-queue interrupted transfers through the normal concurrency scheduler instead of starting every incomplete download directly.
- Pruned expired native-message request and acknowledgement files on app startup.
- Capped HTTP downloads at eight chunk connections each and lowered fresh-install defaults to four chunks and two concurrent downloads.
- Lowered Windows packaging compression memory use to avoid a multi-gigabyte 7-Zip build spike.

## [0.5.1] - 2026-03-21

### Added
- **Maya AI Assistant** 💜 — Sweet, flirty AI companion powered by Gemini API
  - Real-time chat with Gemini 2.0 Flash
  - Text-to-Speech (Web Speech API with female voice)
  - Movie search & recommendations
  - Personalized download notifications
  - User provides their own API key in Settings
- **Torrent Downloads** — Full torrent support via WebTorrent
  - Magnet link support
  - `.torrent` file/URL support
  - Real-time progress with peers, speed, ETA
- **Chrome Extension v2.0**
  - YouTube: sends page URL to yt-dlp (no more blob URL failures)
  - File size detection via HEAD requests
  - Proper resolution labels (1080p, 720p, etc.)
  - Auto-scan on popup open
  - Download button directly triggers CyberDM app

### Fixed
- Payment submission: switched to `application/x-www-form-urlencoded`
- Field mapping: `trxId` → `trx_id`
- Admin panel: Approve/Reject now accept password as auth
- yt-dlp updated to 2026.03.17 (YouTube global fix)
- High-quality YouTube downloads now merge audio+video
- Mobile price updated to 20 TK/month

---

## [0.2.0-beta] - 2026-03-19

### Added
- Initial beta release
- Multi-threaded downloads with smart chunk management
- Resume support for interrupted downloads
- Chrome extension with native messaging & media detection
- Clipboard monitoring for URL detection
- File conflict resolution (ask/rename/overwrite/skip)
- Dark neon glassmorphism UI
- Speed graph visualization
- System tray integration
- Smart notifications on completion
- Settings persistence

### Added (Session 2 — 2026-03-19)
- **License + Payment System** — Complete monetization with manual approval
  - 7-day free trial on first install (full Pro features)
  - HWID-bound licensing (1 device per license)
  - PHP API backend with MySQL (activate, verify, submit_payment, version)
  - Admin panel for payment approval/rejection with screenshot preview
  - Payment: LTC ($1/month), bKash/Nagad/Rocket (10 TK/month)
  - Soft restrictions for free users: 50% speed, 4 threads max, 2s delay
  - API failover (primary → backup)
  - Offline grace period (3 days)
  - Background license verification every 24-48h
  - Upgrade to Pro dialog with payment info + submit form
  - License badge in toolbar (FREE/TRIAL/PRO)
- **Update Version Control** — Gradual update system
  - `/version.php` API endpoint
  - Optional update notification popup
  - Force update blocking for unsupported versions
- **Chrome Auto-Capture (IDM-style)** — Automatically intercepts Chrome downloads
  - Detects files by extension (video, audio, archives, software, documents)
  - Detects by MIME type and file size (>100KB)
  - Cancels Chrome's download and sends URL to CyberDM
  - Toggle on/off from extension popup
  - Shows notification when download is captured
- **YouTube Quality Download** — yt-dlp integration with quality selection dialog (144p-4K)
  - Detects YouTube, Vimeo, TikTok, Facebook, Instagram, Twitter, Dailymotion, Bilibili URLs
  - Shows all available formats with resolution, codec, file size
  - Audio-only extraction to MP3 with automatic conversion
  - Real-time download progress tracking from yt-dlp
- **Category-Based Auto Folders** — Downloads auto-sort into subfolders:
  - `Videos/` — MP4, MKV, AVI, WebM, MOV, FLV
  - `Music/` — MP3, FLAC, AAC, OGG, WAV, M4A
  - `Documents/` — PDF, DOC, DOCX, XLS, TXT, EPUB
  - `Programs/` — EXE, MSI, DMG, APK
  - `Archives/` — ZIP, RAR, 7Z, TAR, ISO
- **File Category Detection** — `detectCategory()` function identifies file types from extension and content-type
- **Open File Button** — Hover on completed downloads to see ▶ Open and 📁 Folder buttons
- **Double-click to Open** — Double-click a completed download row to open the file
- **Completion Sound Effect** — Ascending 4-note C major chord chime (C5→E5→G5→C6)
- **Splash Screen** — Animated logo with developer credit (Cyber Prince)
- **Onboarding Tutorial** — 5-slide first-run tutorial
- **CyberDM Logo** — Custom round cyberpunk-themed logo

### Fixed (Session 2 — 2026-03-19)
- **Critical: Download Failure** — `finalUrl` was storing only path instead of full URL
- **Critical: NaN file sizes** — Property name mismatches between main/renderer (camelCase vs snake_case)
- **UI Flickering** — Replaced full DOM rebuilds with debounced `requestAnimationFrame` + in-place updates
- **App Identity** — Notification now shows "CyberDM" instead of "electron.app.CyberDM" (`setAppUserModelId`)
- **Thread Count Bug** — Multi-threaded downloads were capped at 3 instead of configured thread count
- **Redirect Handling** — Fixed relative redirect URLs in download functions
- **formatSize Crash** — Hardened against undefined/NaN/Infinity values
- **Duplicate IPC Handler** — Removed duplicate `app:open-extension-folder` registration
- **Show in Folder Bug** — Fixed double-joining of file paths
- **Extension Format Detection** — Shows proper file format (MP3 Audio, MP4 File) instead of "Unknown VIDEO"
- **CDN Compatibility** — Added Referer headers for streaming server compatibility

### Documentation
- Created comprehensive README.md
- Created DEBUGGING_REPORT.md
- Created LOGIC_VERIFICATION_REPORT.md
- Created API_DOCUMENTATION.md
- Created TROUBLESHOOTING.md

---

## Planned Features

### [0.2.0] - Coming Soon
- Download scheduler with calendar
- Queue management with priorities
- Bandwidth scheduling
- FTP/FTPS support
- Proxy configuration
- Download authentication
- Checksum verification
- Import/Export download list

### [1.0.0] - Future
- Auto-start with Windows
- Download history statistics
- Speed test integration
- Cloud sync settings
- Plugin system

---

**Developer**: Cyber Prince
**Last Updated**: 2026-03-19
