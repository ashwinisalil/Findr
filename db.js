const mysql = require('mysql2/promise');

// ---------------------------------------------------------
// CONNECTION POOL
// Update these values to match your local MySQL/XAMPP setup.
// The database itself (e.g. "findr") must already exist —
// run `CREATE DATABASE findr;` in phpMyAdmin once before starting the server.
// ---------------------------------------------------------
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',           // set this to your MySQL root/user password if you have one
  database: 'findr',
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------------------------------------------------------
// TABLE SETUP — runs once on server start, safe to run repeatedly
// ---------------------------------------------------------
async function initDb() {
  // USERS
  // `points` added to support the reward points / leaderboard feature in the new frontend.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      zprnId VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'student',
      points INT DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ITEMS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      itemName VARCHAR(150) NOT NULL,
      description TEXT NULL,
      category VARCHAR(50) NULL,
      location VARCHAR(150) NULL,
      imageUrl LONGTEXT NULL,
      contactInfo VARCHAR(150) NULL,
      status VARCHAR(20) DEFAULT 'lost',
      reportedBy INT NOT NULL,
      dateReported DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolvedAt DATETIME NULL,
      FOREIGN KEY (reportedBy) REFERENCES users(id)
    )
  `);

  // CLAIMS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id INT AUTO_INCREMENT PRIMARY KEY,
      itemId INT NOT NULL,
      claimantId INT NOT NULL,
      claimMessage TEXT NULL,
      contactInfo VARCHAR(150) NULL,
      status VARCHAR(20) DEFAULT 'pending',
      dateClaimed DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (itemId) REFERENCES items(id),
      FOREIGN KEY (claimantId) REFERENCES users(id)
    )
  `);

  // CATEGORIES — fixed list, matches the `categories` array in the frontend exactly.
  // If you rename/add a category here, update the frontend's `categories` array to match.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL
    )
  `);
  const defaultCategories = ['Bag', 'Clothing', 'Documents', 'Electronics', 'ID Card', 'Keys', 'Other'];
  for (const name of defaultCategories) {
    await pool.query('INSERT IGNORE INTO categories (name) VALUES (?)', [name]);
  }

  // ADMIN_LOGS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      adminId INT NOT NULL,
      action VARCHAR(100) NOT NULL,
      itemId INT NULL,
      itemName VARCHAR(150) NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (adminId) REFERENCES users(id)
    )
  `);

  console.log('Database tables ready.');
}

module.exports = { pool, initDb };
