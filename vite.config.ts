import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: false },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[/\\](?:antd|@ant-design|@rc-component|rc-[^/\\]+)[/\\]/.test(id)) return 'antd';
          if (/[/\\](?:react|react-dom|react-router|react-router-dom|scheduler)[/\\]/.test(id)) return 'react';
          if (/[/\\]zod[/\\]/.test(id)) return 'validation';
        },
      },
    },
  },
});
