<?php
// CyberDM API — License Verification
// POST: license_key, hwid
require_once __DIR__ . '/config.php';

$data = requireFields(['license_key', 'hwid']);
$db = getDB();

$licenseKey = trim($data['license_key']);
$hwid = trim($data['hwid']);

// Find license
$stmt = $db->prepare('SELECT * FROM licenses WHERE license_key = ? AND hwid = ?');
$stmt->execute([$licenseKey, $hwid]);
$license = $stmt->fetch();

if (!$license) {
    respond(['valid' => false, 'plan' => 'free', 'message' => 'License not found or HWID mismatch']);
}

if ($license['status'] === 'banned') {
    respond(['valid' => false, 'plan' => 'free', 'message' => 'License banned']);
}

// Check expiry
$now = new DateTime();
$expiry = new DateTime($license['expiry_date']);

if ($now > $expiry) {
    $db->prepare('UPDATE licenses SET status = "expired", plan = "free" WHERE license_key = ?')->execute([$licenseKey]);
    respond([
        'valid' => true,
        'plan' => 'free',
        'status' => 'expired',
        'days_remaining' => 0,
        'message' => 'License expired'
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
    'message' => 'License valid'
]);
?>
