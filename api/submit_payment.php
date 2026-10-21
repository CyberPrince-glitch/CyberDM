<?php
// CyberDM API — Submit Payment
// POST: method, trx_id, amount, screenshot (file)
// Optional: license_key (if existing user)
require_once __DIR__ . '/config.php';

$db = getDB();

// Get form data
$method = $_POST['method'] ?? '';
$trxId = $_POST['trx_id'] ?? '';
$amount = $_POST['amount'] ?? '';
$existingKey = $_POST['license_key'] ?? '';
$hwid = $_POST['hwid'] ?? '';

// Validate
if (!$method || !$trxId || !$amount) {
    respond(['error' => 'Missing required fields: method, trx_id, amount'], 400);
}

if (!in_array($method, ['ltc', 'bkash', 'nagad', 'rocket'])) {
    respond(['error' => 'Invalid payment method'], 400);
}

// Check duplicate trx_id
$stmt = $db->prepare('SELECT id FROM payments WHERE trx_id = ? AND method = ?');
$stmt->execute([$trxId, $method]);
if ($stmt->fetch()) {
    respond(['error' => 'Transaction ID already submitted'], 409);
}

// Handle screenshot upload
$screenshotPath = null;
if (isset($_FILES['screenshot']) && $_FILES['screenshot']['error'] === UPLOAD_ERR_OK) {
    $uploadDir = __DIR__ . '/uploads/';
    if (!is_dir($uploadDir)) mkdir($uploadDir, 0755, true);
    
    $ext = pathinfo($_FILES['screenshot']['name'], PATHINFO_EXTENSION);
    $filename = 'pay_' . time() . '_' . bin2hex(random_bytes(4)) . '.' . $ext;
    $destPath = $uploadDir . $filename;
    
    if (move_uploaded_file($_FILES['screenshot']['tmp_name'], $destPath)) {
        $screenshotPath = 'uploads/' . $filename;
    }
}

// Get or create license key
$licenseKey = $existingKey;
if (!$licenseKey) {
    // Create new license (trial = 7 days free initially)
    $licenseKey = generateLicenseKey();
    $expiryDate = (new DateTime())->modify('+' . TRIAL_DAYS . ' days')->format('Y-m-d H:i:s');
    
    $stmt = $db->prepare('INSERT INTO licenses (license_key, hwid, plan, status, expiry_date) VALUES (?, ?, "trial", "active", ?)');
    $stmt->execute([$licenseKey, $hwid, $expiryDate]);
}

// Insert payment record
$stmt = $db->prepare('INSERT INTO payments (license_key, method, trx_id, screenshot_path, amount, status) VALUES (?, ?, ?, ?, ?, "pending")');
$stmt->execute([$licenseKey, $method, $trxId, $screenshotPath, $amount]);

respond([
    'success' => true,
    'license_key' => $licenseKey,
    'message' => 'Payment submitted! Your license will be activated once verified by admin (usually within 1-2 hours).'
]);
?>
