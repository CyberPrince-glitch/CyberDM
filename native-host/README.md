# CyberDM Browser Bridge

The Chrome/Edge extension uses Chromium Native Messaging to deliver accepted HTTP/HTTPS links to the CyberDM desktop app.

## Install

1. Install or build CyberDM so `CyberDM.exe` exists.
2. Load the `resources\extension` folder beside the installed `CyberDM.exe` in `chrome://extensions` or `edge://extensions`. In a source checkout, load the repository's `extension/` folder instead.
3. Copy the extension ID shown by the browser.
4. Run `resources\native-host\install-host.bat` and enter the extension ID and the full path to `CyberDM.exe` if prompted. In a source checkout, run `native-host\install-host.bat`.
5. Restart the browser.

The installer writes the native-host manifest under `%LOCALAPPDATA%\CyberDM` and registers it for the current Windows user in Chrome and Edge. Administrator access should not be required.

## Message flow

The manifest launches `native-host-shim.exe` without command-line arguments. The installer saves the configured `CyberDM.exe` path in `%LOCALAPPDATA%\CyberDM\cyberdm-app-path.txt`, so the browser does not need to pass paths through its native-host command line. The shim reads and validates Chromium's size-prefixed input frame, writes the request under `%APPDATA%\cyberdm\native-requests`, and launches CyberDM with only the generated request ID on the command line. It waits for the desktop app's acknowledgement and returns it as a correctly framed native-messaging response. This keeps request URLs and cookies out of process arguments and avoids Electron's unreliable Windows GUI stdin pipe. If CyberDM is already running, Electron forwards the request ID to the existing instance using its single-instance event. The desktop process consumes the request and stores accepted downloads in normal history.

The shim reserves stdout for the size-prefixed JSON reply; diagnostics remain on stderr.

The extension cancels its Chrome download only after it receives a positive native-host acknowledgement. If the host cannot start, Chrome keeps its original download and the extension stores the request as pending.

Each extension handoff also carries a stable client request ID. Automatic Chrome downloads derive it from the browser extension ID and Chrome download ID; collected links use a batch ID plus an item index. The desktop stores successful handoff results and records the ID on accepted jobs, so a repeated message after a lost acknowledgement returns the original acceptance instead of creating another job. The transport request ID remains separate and is used only to locate the local request/acknowledgement files.

## Scope and limitations

- This bridge currently hands off HTTP/HTTPS file URLs to the standard download engine.
- When the user enables **Include browser cookies** in the extension, cookies are forwarded for the requested source URL. HTTP downloads use encrypted desktop storage and same-origin scoping; yt-dlp gets a temporary cookie file that is deleted after metadata lookup or download. Site-specific authorization headers and cross-origin media hosts are not supported yet.
- Link/page collection sends up to eight HTTP/HTTPS URLs in one native message. The desktop probes and queues each URL; any individual failures are saved in the extension's retry list.
- Video-page requests are accepted into a persisted handoff queue and open the app's quality-selection dialog. A video download begins after the user chooses a format.
- The extension ID in the manifest must match the installed extension exactly.
- The registered executable path must match the actual CyberDM installation path.
