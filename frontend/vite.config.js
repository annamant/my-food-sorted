import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth':           'http://localhost:3000',
      '/chat':           'http://localhost:3000',
      '/meal-plans':     'http://localhost:3000',
      '/shopping-lists': 'http://localhost:3000',
    },
  },
})
