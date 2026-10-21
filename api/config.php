<?php
// CyberDM API Configuration
// IMPORTANT: Update these values for your server

// Database
define('DB_HOST', 'localhost');
define('DB_NAME', 'cyberdm_license');
define('DB_USER', 'root');           // Change this
define('DB_PASS', '');               // Change this

// Admin
define('ADMIN_KEY', 'CyberDM_Admin_2026');  // Change this - used for admin API calls
define('ADMIN_PASSWORD', 'cyberprince');     // Change this - used for admin panel login

// License
define('TRIAL_DAYS', 7);
define('PRO_DAYS', 30);
define('LICENSE_SECRET', 'CDM_LIC_SECRET_2026');  // Used for HMAC

// CORS
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Database connection
function getDB() {
    try {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER,
            DB_PASS,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
            ]
        );
        return $pdo;
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Database connection failed']);
        exit;
    }
}

// Generate unique license key
function generateLicenseKey() {
    return 'CDM-' . strtoupper(bin2hex(random_bytes(4))) . '-' . strtoupper(bin2hex(random_bytes(4))) . '-' . strtoupper(bin2hex(random_bytes(4)));
}

// Response helper
function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

// Validate required fields
function requireFields($fields) {
    $data = json_decode(file_get_contents('php://input'), true);
    if (!$data) $data = $_POST;
    
    foreach ($fields as $field) {
        if (empty($data[$field])) {
            respond(['error' => "Missing required field: $field"], 400);
        }
    }
    return $data;
}
?>
