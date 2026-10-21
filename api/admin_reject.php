<?php
// CyberDM API — Admin Reject Payment
// POST: payment_id, admin_key, reason (optional)
require_once __DIR__ . '/config.php';

$data = requireFields(['payment_id', 'admin_key']);
$db = getDB();

if ($data['admin_key'] !== ADMIN_KEY && $data['admin_key'] !== ADMIN_PASSWORD) {
    respond(['error' => 'Unauthorized'], 403);
}

$paymentId = (int)$data['payment_id'];
$reason = $data['reason'] ?? 'Payment rejected by admin';

$stmt = $db->prepare('SELECT * FROM payments WHERE id = ?');
$stmt->execute([$paymentId]);
$payment = $stmt->fetch();

if (!$payment) {
    respond(['error' => 'Payment not found'], 404);
}

if ($payment['status'] !== 'pending') {
    respond(['error' => 'Payment already ' . $payment['status']], 400);
}

$db->prepare('UPDATE payments SET status = "rejected", admin_note = ?, reviewed_at = NOW() WHERE id = ?')
   ->execute([$reason, $paymentId]);

respond([
    'success' => true,
    'message' => 'Payment rejected'
]);
?>
