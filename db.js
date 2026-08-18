const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 创建数据库文件
const dbPath = path.join(__dirname, 'budget.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('✅ SQLite 数据库连接成功');
    initTables();
  }
});

// 初始化数据表
function initTables() {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    create_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 账单表，绑定user_id
  db.run(`CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT,
    amount REAL,
    category TEXT,
    date TEXT,
    remark TEXT,
    create_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
}

module.exports = db;