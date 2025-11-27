import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

let db: Database.Database | null = null;

function getDbPath(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  
  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  return process.env.DATABASE_URL || path.join(dataDir, 'vapid.db');
}

export function getDatabase(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initializeDatabase(db);
    logger.info('Database initialized', { path: dbPath });
  }
  return db;
}

function initializeDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS vapid_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
      UNIQUE(app_id, endpoint)
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_app_id ON subscriptions(app_id);
    CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key);
  `);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

export default getDatabase;
