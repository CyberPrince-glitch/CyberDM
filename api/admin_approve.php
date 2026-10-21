<?php
// CyberDM API — Admin Approve Payment
// POST: payment_id, admin_key
require_once __DIR__ . '/config.php';

$data = requireFields(['payment_id', 'admin_key']);
$db = getDB();

// Verify admin key
if ($data['admin_key'] !== ADMIN_KEY && $data['admin_key'] !== ADMIN_PASSWORD) {
    respond(['error' => 'Unauthorized'], 403);
}

$paymentId = (int)$data['payment_id'];

// Get payment
$stmt = $db->prepare('SELECT * FROM payments WHERE id = ?');
$stmt->execute([$paymentId]);
$payment = $stmt->fetch();

if (!$payment) {
    respond(['error' => 'Payment not found'], 404);
}

if ($payment['status'] !== 'pending') {
    respond(['error' => 'Payment already ' . $payment['status']], 400);
}

// Approve payment
$db->prepare('UPDATE payments SET status = "approved", reviewed_at = NOW() WHERE id = ?')->execute([$paymentId]);

// Activate/extend license
$expiryDate = (new DateTime())->modify('+' . PRO_DAYS . ' days')->format('Y-m-d H:i:s');

$stmt = $db->prepare('SELECT * FROM licenses WHERE license_key = ?');
$stmt->execute([$payment['license_key']]);
$license = $stmt->fetch();

if ($license) {
    // If license is still active/pro, extend from current expiry
    if ($license['status'] === 'active' && $license['plan'] === 'pro') {
        $currentExpiry = new DateTime($license['expiry_date']);
        $now = new DateTime();
        if ($currentExpiry > $now) {
            $expiryDate = $currentExpiry->modify('+' . PRO_DAYS . ' days')->format('Y-m-d H:i:s');
        }
    }
    
    $db->prepare('UPDATE licenses SET plan = "pro", status = "active", expiry_date = ? WHERE license_key = ?')
       ->execute([$expiryDate, $payment['license_key']]);
} else {
    // Create new license
    $db->prepare('INSERT INTO licenses (license_key, plan, status, expiry_date) VALUES (?, "pro", "active", ?)')
       ->execute([$payment['license_key'], $expiryDate]);
}

respond([
    'success' => true,
    'message' => 'Payment approved. License activated until ' . $expiryDate,
    'license_key' => $payment['license_key'],
    'expiry_date' => $expiryDate
]);
?>
