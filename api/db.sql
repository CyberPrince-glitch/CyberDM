-- CyberDM License & Payment System Database
-- Deploy to MySQL on surveymentor.org

CREATE DATABASE IF NOT EXISTS cyberdm_license CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cyberdm_license;

-- Licenses table
CREATE TABLE IF NOT EXISTS licenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    license_key VARCHAR(64) NOT NULL UNIQUE,
    hwid VARCHAR(128) DEFAULT NULL,
    email VARCHAR(128) DEFAULT NULL,
    plan ENUM('free','pro','trial') NOT NULL DEFAULT 'trial',
    status ENUM('active','expired','banned') NOT NULL DEFAULT 'active',
    expiry_date DATETIME NOT NULL,
    last_verified DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_license_key (license_key),
    INDEX idx_hwid (hwid),
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    license_key VARCHAR(64) NOT NULL,
    method ENUM('ltc','bkash','nagad','rocket') NOT NULL,
    trx_id VARCHAR(128) NOT NULL,
    screenshot_path VARCHAR(255) DEFAULT NULL,
    amount DECIMAL(10,2) NOT NULL,
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    admin_note TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME DEFAULT NULL,
    INDEX idx_status (status),
    INDEX idx_license (license_key),
    FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
) ENGINE=InnoDB;
