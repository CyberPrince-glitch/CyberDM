<?php
// CyberDM API — Version Check
// GET — returns latest version info
require_once __DIR__ . '/config.php';

respond([
    'latest_version' => '0.2.0',
    'min_supported' => '0.1.0',
    'force_update' => false,
    'download_url' => 'https://surveymentor.org/CDM/download/CyberDM-Setup.exe',
    'changelog' => 'YouTube quality download, auto-capture, category folders, license system'
]);
?>
