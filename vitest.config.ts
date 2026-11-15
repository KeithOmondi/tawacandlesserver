import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node', testTimeout: 60000, hookTimeout: 120000, fileParallelism: false,
    env: {
      NODE_ENV: 'test', DATABASE_URL: '', MPESA_MODE: 'mock', BREVO_API_KEY: '', SENDER_EMAIL: '', LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
      DATA_ENCRYPTION_KEY: 'test-encryption-key-test-encryption-key-123',
      APP_URL: 'http://localhost:5173', ADMIN_REQUIRE_MFA: 'true', UPLOAD_DIR: '.test-uploads',
    },
  },
})
