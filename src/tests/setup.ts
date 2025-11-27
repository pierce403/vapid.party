import path from 'path';
import fs from 'fs';

// Use test environment
process.env.NODE_ENV = 'test';

// Use in-memory database for tests
const testDbPath = path.join('/tmp', 'vapid-test.db');

beforeEach(() => {
  // Clean up test database before each test
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  
  // Also clean up WAL files
  if (fs.existsSync(testDbPath + '-wal')) {
    fs.unlinkSync(testDbPath + '-wal');
  }
  if (fs.existsSync(testDbPath + '-shm')) {
    fs.unlinkSync(testDbPath + '-shm');
  }
  
  // Set environment variable for test database
  process.env.DATABASE_URL = testDbPath;
  process.env.DATA_DIR = '/tmp';
  process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests
});

afterAll(() => {
  // Clean up test database after all tests
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  if (fs.existsSync(testDbPath + '-wal')) {
    fs.unlinkSync(testDbPath + '-wal');
  }
  if (fs.existsSync(testDbPath + '-shm')) {
    fs.unlinkSync(testDbPath + '-shm');
  }
});
