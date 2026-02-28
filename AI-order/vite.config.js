// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000, // 確保 vite 跑在 3000
    proxy: {
      // 代理所有 /xumm, /create-order, /buy, /redeem, /ai-order 的請求
      // 從 http://localhost:3000/xumm/login 
      // 轉發到 http://localhost:3001/xumm/login
      '/xumm': 'http://localhost:3001',
      '/create-order': 'http://localhost:3001',
      '/buy': 'http://localhost:3001',
      '/redeem': 'http://localhost:3001',
      '/ai-order': 'http://localhost:3001',
    },
  },
});