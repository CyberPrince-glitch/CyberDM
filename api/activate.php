<?php
// CyberDM API — License Activation
// POST: license_key, hwid
require_once __DIR__ . '/config.php';

$data = requireFields(['license_key', 'hwid']);
$db = getDB();

$licenseKey = trim($data['license_key']);
$hwid = trim($data['hwid']);

// Find license
$stmt = $db->prepare('SELECT * FROM licenses WHERE license_key = ?');
$stmt->execute([$licenseKey]);
$license = $stmt->fetch();

if (!$license) {
    respond(['error' => 'Invalid license key', 'valid' => false], 404);
}

if ($license['status'] === 'banned') {
    respond(['error' => 'This license has been banned', 'valid' => false], 403);
}

// Check if already bound to different HWID
if ($license['hwid'] && $license['hwid'] !== $hwid) {
    respond(['error' => 'License already bound to another device', 'valid' => false], 403);
}

// Bind HWID if not bound yet
if (!$license['hwid']) {
    $stmt = $db->prepare('UPDATE licenses SET hwid = ? WHERE license_key = ?');
    $stmt->execute([$hwid, $licenseKey]);
}

// Check expiry
$now = new DateTime();
$expiry = new DateTime($license['expiry_date']);

if ($now > $expiry) {
    // Expired — update status
    $db->prepare('UPDATE licenses SET status = "expired" WHERE license_key = ?')->execute([$licenseKey]);
    
    respond([
        'valid' => true,
        'plan' => 'free',
        'status' => 'expired',
        'expiry_date' => $license['expiry_date'],
        'days_remaining' => 0,
        'message' => 'Your Pro license has expired. Upgrade to continue with full speed.'
    ]);
}

// Update last verified
$db->prepare('UPDATE licenses SET last_verified = NOW() WHERE license_key = ?')->execute([$licenseKey]);

$daysRemaining = $now->diff($expiry)->days;

respond([
    'valid' => true,
    'plan' => $license['plan'],
    'status' => $license['status'],
    'expiry_date' => $license['expiry_date'],
    'days_remaining' => $daysRemaining,
    'message' => 'License activated successfully'
]);
?>
