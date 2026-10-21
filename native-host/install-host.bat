@echo off
setlocal
title CyberDM Browser Bridge Setup

set "HOST_NAME=com.cyberdm.native"
set "HOST_DIR=%LOCALAPPDATA%\CyberDM"
set "HOST_MANIFEST=%HOST_DIR%\%HOST_NAME%.json"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
set "EDGE_REG_KEY=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
set "APP_PATH=%ProgramFiles%\CyberDM\CyberDM.exe"

echo CyberDM browser bridge setup
echo.
set /p EXTENSION_ID=Enter the CyberDM extension ID from chrome://extensions/: 
if "%EXTENSION_ID%"=="" (
  echo An extension ID is required.
  exit /b 1
)

if not exist "%APP_PATH%" (
  echo The default app path was not found: "%APP_PATH%"
  set /p APP_PATH=Enter the full path to CyberDM.exe: 
)
if not exist "%APP_PATH%" (
  echo CyberDM.exe was not found: "%APP_PATH%"
  exit /b 1
)

if not exist "%HOST_DIR%" mkdir "%HOST_DIR%"
if errorlevel 1 exit /b 1

set "CYBERDM_EXTENSION_ID=%EXTENSION_ID%"
set "CYBERDM_APP_PATH=%APP_PATH%"
set "CYBERDM_SHIM_SOURCE=%~dp0native-host-shim.exe"
set "CYBERDM_SHIM_PATH=%HOST_DIR%\native-host-shim.exe"
set "CYBERDM_APP_PATH_FILE=%HOST_DIR%\cyberdm-app-path.txt"
set "CYBERDM_HOST_SOURCE=%~dp0com.cyberdm.native.json"
set "CYBERDM_HOST_MANIFEST=%HOST_MANIFEST%"
if not exist "%CYBERDM_SHIM_SOURCE%" (
  echo The CyberDM native host shim is missing: "%CYBERDM_SHIM_SOURCE%"
  exit /b 1
)
copy /y "%CYBERDM_SHIM_SOURCE%" "%CYBERDM_SHIM_PATH%" >nul
if errorlevel 1 (
  echo Failed to install the native host shim.
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$extensionId = $env:CYBERDM_EXTENSION_ID; if ($extensionId -notmatch '^[a-p]{32}$') { Write-Error 'Invalid Chrome/Edge extension ID'; exit 2 }; $manifest = Get-Content -Raw -LiteralPath $env:CYBERDM_HOST_SOURCE | ConvertFrom-Json; $manifest.path = $env:CYBERDM_SHIM_PATH; $manifest.args = @(); $manifest.allowed_origins = @('chrome-extension://' + $extensionId + '/'); $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:CYBERDM_HOST_MANIFEST -Encoding ascii"
if errorlevel 1 (
  echo Failed to create the native host manifest.
  exit /b 1
)
Set-Content -LiteralPath "%CYBERDM_APP_PATH_FILE%" -Value "%CYBERDM_APP_PATH%" -Encoding ascii
if errorlevel 1 (
  echo Failed to save the CyberDM executable path.
  exit /b 1
)

reg add "%REG_KEY%" /ve /t REG_SZ /d "%HOST_MANIFEST%" /f >nul
if errorlevel 1 (
  echo Failed to register the Chrome native host.
  exit /b 1
)

reg add "%EDGE_REG_KEY%" /ve /t REG_SZ /d "%HOST_MANIFEST%" /f >nul
if errorlevel 1 (
  echo Chrome was registered, but Edge registration failed.
  exit /b 1
)

echo.
echo CyberDM browser bridge installed for extension %EXTENSION_ID%.
echo Restart Chrome or Edge before using the extension.
pause
endlocal
