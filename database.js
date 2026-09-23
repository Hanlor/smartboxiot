const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'smartbox.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Lỗi kết nối CSDL SQLite:', err.message);
  } else {
    console.log('📦 Đã kết nối thành công tới CSDL SQLite (smartbox.db)');
  }
});

db.serialize(() => {
  // 1. Bảng Lockers Chuẩn
  db.run(`
    CREATE TABLE IF NOT EXISTS lockers (
      id INTEGER PRIMARY KEY,
      status TEXT DEFAULT 'AVAILABLE',
      door_closed INTEGER DEFAULT 1,
      has_item INTEGER DEFAULT 0,
      shipment_id TEXT,
      sender_phone TEXT,
      recipient_phone TEXT,
      qr_token TEXT,
      reserved_at INTEGER
    )
  `);

  // 2. Bảng Shipments Chuẩn
  db.run(`
    CREATE TABLE IF NOT EXISTS shipments (
      shipment_id TEXT PRIMARY KEY,
      locker_id INTEGER,
      sender_phone TEXT,
      recipient_phone TEXT,
      qr_token TEXT,
      status TEXT DEFAULT 'PENDING',
      created_at INTEGER,
      occupied_at INTEGER,
      completed_at INTEGER,
      aborted_at INTEGER
    )
  `);

  // 3. Bảng OTPs Chuẩn
  db.run(`
    CREATE TABLE IF NOT EXISTS otps (
      otp_code TEXT PRIMARY KEY,
      locker_id INTEGER,
      shipment_id TEXT,
      recipient_phone TEXT,
      expires_at INTEGER,
      used INTEGER DEFAULT 0
    )
  `);

  // Khởi tạo sẵn 3 tủ nếu bảng rỗng
  db.get("SELECT COUNT(*) AS count FROM lockers", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO lockers (id, status) VALUES (1, 'AVAILABLE'), (2, 'AVAILABLE'), (3, 'AVAILABLE')");
    }
  });
});

module.exports = db;