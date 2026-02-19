import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/register':       'http://localhost:3000',
      '/login':          'http://localhost:3000',
      '/chat':           'http://localhost:3000',
      '/meal-plan':      'http://localhost:3000',
      '/shopping-list':  'http://localhost:3000',
      '/affiliate-link': 'http://localhost:3000',
    },
  },
})
