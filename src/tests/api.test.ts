import request from 'supertest';
import { createApp } from '../app';
import { closeDatabase } from '../db/database';
import { resetVapidConfig } from '../services/notifications';

describe('API Endpoints', () => {
  let app: ReturnType<typeof createApp>;
  
  beforeEach(() => {
    // Reset VAPID config for fresh state
    resetVapidConfig();
    // Re-initialize the app for each test to ensure clean state
    app = createApp();
  });
  
  afterEach(() => {
    closeDatabase();
  });
  
  describe('GET /api/health', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('healthy');
      expect(response.body.data.timestamp).toBeDefined();
    });
  });
  
  describe('GET /api/vapid/public-key', () => {
    it('should return VAPID public key', async () => {
      const response = await request(app).get('/api/vapid/public-key');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.publicKey).toBeDefined();
      expect(typeof response.body.data.publicKey).toBe('string');
      expect(response.body.data.publicKey.length).toBeGreaterThan(0);
    });
    
    it('should return the same public key on subsequent requests', async () => {
      const response1 = await request(app).get('/api/vapid/public-key');
      const response2 = await request(app).get('/api/vapid/public-key');
      
      expect(response1.body.data.publicKey).toBe(response2.body.data.publicKey);
    });
  });
  
  describe('POST /api/apps', () => {
    it('should create a new app', async () => {
      const response = await request(app)
        .post('/api/apps')
        .send({ name: 'Test App' });
      
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBeDefined();
      expect(response.body.data.name).toBe('Test App');
      expect(response.body.data.apiKey).toBeDefined();
      expect(response.body.data.apiKey).toMatch(/^vp_/);
    });
    
    it('should reject empty name', async () => {
      const response = await request(app)
        .post('/api/apps')
        .send({ name: '' });
      
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('App name is required');
    });
    
    it('should reject missing name', async () => {
      const response = await request(app)
        .post('/api/apps')
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
    
    it('should reject name over 255 characters', async () => {
      const longName = 'a'.repeat(256);
      const response = await request(app)
        .post('/api/apps')
        .send({ name: longName });
      
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('App name must be 255 characters or less');
    });
  });
  
  describe('GET /api/apps/me', () => {
    it('should return app info with valid API key', async () => {
      // First create an app
      const createResponse = await request(app)
        .post('/api/apps')
        .send({ name: 'My App' });
      
      const apiKey = createResponse.body.data.apiKey;
      
      // Then get app info
      const response = await request(app)
        .get('/api/apps/me')
        .set('X-API-Key', apiKey);
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe('My App');
    });
    
    it('should reject request without API key', async () => {
      const response = await request(app).get('/api/apps/me');
      
      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Missing X-API-Key header');
    });
    
    it('should reject invalid API key', async () => {
      const response = await request(app)
        .get('/api/apps/me')
        .set('X-API-Key', 'invalid-key');
      
      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid API key');
    });
  });
  
  describe('POST /api/subscriptions', () => {
    let apiKey: string;
    
    beforeEach(async () => {
      const createResponse = await request(app)
        .post('/api/apps')
        .send({ name: 'Subscription Test App' });
      apiKey = createResponse.body.data.apiKey;
    });
    
    it('should create a subscription', async () => {
      const response = await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test',
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUH...',
            auth: 'tBHItJI5svbpez7Kk...'
          }
        });
      
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBeDefined();
      expect(response.body.data.endpoint).toBe('https://fcm.googleapis.com/fcm/send/test');
    });
    
    it('should reject subscription without endpoint', async () => {
      const response = await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUH...',
            auth: 'tBHItJI5svbpez7Kk...'
          }
        });
      
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
    
    it('should reject subscription with invalid endpoint URL', async () => {
      const response = await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          endpoint: 'not-a-valid-url',
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUH...',
            auth: 'tBHItJI5svbpez7Kk...'
          }
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid endpoint URL');
    });
    
    it('should reject subscription without keys', async () => {
      const response = await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test'
        });
      
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
    
    it('should reject subscription without API key', async () => {
      const response = await request(app)
        .post('/api/subscriptions')
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test',
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUH...',
            auth: 'tBHItJI5svbpez7Kk...'
          }
        });
      
      expect(response.status).toBe(401);
    });
  });
  
  describe('GET /api/subscriptions', () => {
    let apiKey: string;
    
    beforeEach(async () => {
      const createResponse = await request(app)
        .post('/api/apps')
        .send({ name: 'List Subscriptions App' });
      apiKey = createResponse.body.data.apiKey;
    });
    
    it('should list subscriptions for an app', async () => {
      // Create a subscription first
      await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test1',
          keys: {
            p256dh: 'key1',
            auth: 'auth1'
          }
        });
      
      await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test2',
          keys: {
            p256dh: 'key2',
            auth: 'auth2'
          }
        });
      
      const response = await request(app)
        .get('/api/subscriptions')
        .set('X-API-Key', apiKey);
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
    });
    
    it('should return empty array when no subscriptions exist', async () => {
      const response = await request(app)
        .get('/api/subscriptions')
        .set('X-API-Key', apiKey);
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(0);
    });
  });
  
  describe('POST /api/notifications/send', () => {
    let apiKey: string;
    let subscriptionId: string;
    
    beforeEach(async () => {
      const createResponse = await request(app)
        .post('/api/apps')
        .send({ name: 'Notification Test App' });
      apiKey = createResponse.body.data.apiKey;
      
      const subResponse = await request(app)
        .post('/api/subscriptions')
        .set('X-API-Key', apiKey)
        .send({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test',
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUH...',
            auth: 'tBHItJI5svbpez7Kk...'
          }
        });
      subscriptionId = subResponse.body.data.id;
    });
    
    it('should reject notification without payload', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .set('X-API-Key', apiKey)
        .send({
          subscriptionId
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid notification payload');
    });
    
    it('should reject notification without title', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .set('X-API-Key', apiKey)
        .send({
          subscriptionId,
          payload: {
            body: 'Test body'
          }
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid notification payload');
    });
    
    it('should reject notification without subscriptionId or endpoint', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .set('X-API-Key', apiKey)
        .send({
          payload: {
            title: 'Test Title'
          }
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Either subscriptionId or');
    });
    
    it('should reject notification for non-existent subscription', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .set('X-API-Key', apiKey)
        .send({
          subscriptionId: 'non-existent-id',
          payload: {
            title: 'Test Title'
          }
        });
      
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Subscription not found');
    });
  });
  
  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/api/unknown');
      
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Not found');
    });
  });
});
