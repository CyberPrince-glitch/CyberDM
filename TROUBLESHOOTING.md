# CyberDM Troubleshooting Guide

Common issues and solutions for CyberDM.

---

## 🚀 Installation Issues

### Issue: `npm install` fails
**Symptoms:**
- Error during package installation
- Permission denied errors
- Network timeout errors

**Solutions:**
1. **Clear npm cache:**
   ```bash
   npm cache clean --force
   ```

2. **Use administrator/sudo:**
   ```bash
   # Windows (Run as Administrator)
   npm install

   # Linux/Mac
   sudo npm install
   ```

3. **Check Node.js version:**
   ```bash
   node --version  # Should be v18 or higher
   ```

---

### Issue: yt-dlp not found
**Symptoms:**
- "yt-dlp not found" error when downloading videos
- Video download fails immediately

**Solutions:**
1. **Run postinstall script:**
   ```bash
   npm run postinstall
   ```

2. **Check tools folder:**
   - Verify `tools/yt-dlp.exe` exists
   - If missing, download manually from https://github.com/yt-dlp/yt-dlp/releases

3. **Check Windows Defender:**
   - yt-dlp might be blocked by antivirus
   - Add exception for the tools folder

---

## 🎮 Runtime Issues

### Issue: App won't start
**Symptoms:**
- Window doesn't appear
- Process starts but no UI

**Solutions:**
1. **Check for existing process:**
   ```bash
   # Windows
   taskkill /f /im CyberDM.exe

   # Then restart
   npm start
   ```

2. **Clear app data:**
   ```bash
   # Delete Electron app data
   # Windows: %APPDATA%/CyberDM
   # Linux: ~/.config/CyberDM
   # Mac: ~/Library/Application Support/CyberDM
   ```

3. **Check console output:**
   ```bash
   npm start 2>&1 | tee log.txt
   ```

---

### Issue: Downloads fail immediately
**Symptoms:**
- "HTTP 403" or "HTTP 404" errors
- "Connection timeout" errors

**Solutions:**
1. **Check URL accessibility:**
   - Try downloading the URL in browser
   - Some sites block download managers

2. **Update User Agent:**
   - Go to Settings → Connection
   - Change User Agent to browser-like string:
     ```
     Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
     ```

3. **Check firewall/antivirus:**
   - CyberDM needs internet access
   - Add exception if blocked

---

### Issue: Resume not working
**Symptoms:**
- Download restarts from beginning
- "Server doesn't support resume" message

**Solutions:**
1. **Check server support:**
   - Not all servers support resume
   - Look for "Accept-Ranges: bytes" header

2. **Verify chunk metadata:**
   - Check `%APPDATA%/CyberDM/chunks/` folder
   - Metadata should exist for partial downloads

3. **Try single thread:**
   - Some servers don't support multi-thread resume
   - Set threads to 1 in settings

---

## 🌐 Browser Extension Issues

### Issue: Extension not connecting to app
**Symptoms:**
- "CyberDM not running" message
- Downloads don't appear in app

**Solutions:**
1. **Verify native host installation:**
   - Check registry key exists:
     ```
     HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.cyberdm.native
     ```

2. **Check extension ID:**
   - Go to `chrome://extensions/`
   - Copy extension ID
   - Update `native-host/com.cyberdm.native.json`

3. **Restart Chrome:**
   - Native messaging requires browser restart

---

### Issue: Video not detected on page
**Symptoms:**
- Download button doesn't appear
- No videos found on YouTube

**Solutions:**
1. **Refresh the page:**
   - Extension loads after page load
   - Refresh to trigger detection

2. **Check if video is HLS/DASH:**
   - Some streaming videos use DRM
   - These cannot be downloaded

3. **Try manual URL:**
   - Copy video URL
   - Paste in CyberDM directly

---

## 💾 File Issues

### Issue: File conflict dialog not appearing
**Symptoms:**
- File gets overwritten without warning
- Download fails with "file exists"

**Solutions:**
1. **Check conflict mode:**
   - Go to Settings → Download
   - Set "When File Exists" to "Ask every time"

2. **Verify file permissions:**
   - Ensure write access to download folder
   - Try different download location

---

### Issue: Download completes but file is corrupted
**Symptoms:**
- File won't open
- Wrong file size

**Solutions:**
1. **Disable multi-threading:**
   - Some servers don't handle chunks correctly
   - Set threads to 1

2. **Check disk space:**
   - Ensure enough free space
   - Temporary files need space during download

3. **Verify with checksum:**
   - Compare file size with expected
   - Re-download if different

---

## 🔔 Notification Issues

### Issue: No completion notifications
**Symptoms:**
- Download finishes but no notification
- No sound played

**Solutions:**
1. **Check Windows notification settings:**
   - Settings → System → Notifications
   - Ensure CyberDM is allowed

2. **Check app settings:**
   - Settings → General
   - Enable "Show notification when download completes"

3. **Check sound settings:**
   - System volume not muted
   - App has permission to play sounds

---

## 🐌 Performance Issues

### Issue: Slow download speeds
**Symptoms:**
- Speed much slower than browser
- Speed drops over time

**Solutions:**
1. **Increase thread count:**
   - Settings → Download
   - Set threads to 16 or 32

2. **Check speed limit:**
   - Ensure speed limit is 0 (unlimited)

3. **Disable other network apps:**
   - VPNs can slow downloads
   - Other downloads consume bandwidth

4. **Try different server:**
   - Some servers throttle download managers
   - Use browser if server blocks multi-threading

---

### Issue: High CPU/Memory usage
**Symptoms:**
- System slows down
- App becomes unresponsive

**Solutions:**
1. **Reduce concurrent downloads:**
   - Settings → Download
   - Lower "Max Concurrent Downloads"

2. **Reduce thread count:**
   - High thread count uses more resources
   - Try 8 threads instead of 32

3. **Close other apps:**
   - Free up system resources
   - Especially other Electron apps

---

## 🔄 Update Issues

### Issue: Settings lost after update
**Symptoms:**
- Download path reset
- Preferences not saved

**Solutions:**
1. **Backup settings:**
   - Export before updating
   - Located in `%APPDATA%/CyberDM/config.json`

2. **Check permissions:**
   - Ensure app can write to app data folder

---

## 🐛 Debug Mode

### Enable Debug Logging

1. **Set environment variable:**
   ```bash
   # Windows
   set DEBUG=cyberdm:*
   npm start

   # Linux/Mac
   DEBUG=cyberdm:* npm start
   ```

2. **Check console output:**
   - Look for [DEBUG] messages
   - Check chunk download progress
   - Monitor speed calculations

---

## 📊 Log Files

### Location of Log Files

**Windows:**
```
%APPDATA%/CyberDM/logs/
```

**Linux:**
```
~/.config/CyberDM/logs/
```

**Mac:**
```
~/Library/Application Support/CyberDM/logs/
```

### Enable File Logging

Add to `src/main.js`:
```javascript
const log = require('electron-log');
log.transports.file.level = 'debug';
```

---

## 🆘 Getting Help

If issue persists:

1. **Check documentation:**
   - [README.md](./README.md)
   - [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
   - [LOGIC_VERIFICATION_REPORT.md](./LOGIC_VERIFICATION_REPORT.md)

2. **Gather information:**
   - CyberDM version
   - Windows version
   - Error messages
   - Steps to reproduce

3. **Check for updates:**
   - Update yt-dlp: `npm run postinstall`
   - Update CyberDM to latest version

---

## ✅ Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "URL_EXPIRED" | Video URL expired | Refresh page and try again |
| "HTTP 403" | Access forbidden | Try different URL or User Agent |
| "HTTP 404" | File not found | Check URL is correct |
| "Connection timeout" | Server not responding | Increase timeout in settings |
| "yt-dlp not found" | Video downloader missing | Run `npm run postinstall` |
| "File in use" | File locked by another app | Close app using the file |
| "Disk full" | No space left | Free up disk space |

---

**Last Updated**: 2026-03-19
