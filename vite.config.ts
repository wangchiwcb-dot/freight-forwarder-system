import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: { port: 5173, strictPort: false, proxy: { '/api/v2': 'http://127.0.0.1:8790' } },
  build: {
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
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
