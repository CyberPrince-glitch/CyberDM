<?php
// CyberDM API — Admin List Payments & Licenses
// GET: admin_key
require_once __DIR__ . '/config.php';

$adminKey = $_GET['admin_key'] ?? $_POST['admin_key'] ?? '';
if ($adminKey !== ADMIN_KEY && $adminKey !== ADMIN_PASSWORD) {
    respond(['error' => 'Unauthorized'], 403);
}

$db = getDB();

// Get all payments
$payments = $db->query('SELECT * FROM payments ORDER BY created_at DESC')->fetchAll();

// Get all licenses
$licenses = $db->query('SELECT * FROM licenses ORDER BY created_at DESC')->fetchAll();

// Stats
$pending = $db->query("SELECT COUNT(*) as c FROM payments WHERE status='pending'")->fetch()['c'];
$approved = $db->query("SELECT COUNT(*) as c FROM payments WHERE status='approved'")->fetch()['c'];
$totalLicenses = $db->query("SELECT COUNT(*) as c FROM licenses")->fetch()['c'];
$activePro = $db->query("SELECT COUNT(*) as c FROM licenses WHERE plan='pro' AND status='active'")->fetch()['c'];

respond([
    'payments' => $payments,
    'licenses' => $licenses,
    'stats' => [
        'pending' => $pending,
        'approved' => $approved,
        'total_licenses' => $totalLicenses,
        'active_pro' => $activePro
    ]
]);
?>
