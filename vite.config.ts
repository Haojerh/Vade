import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    // Fix HMR connection drops over Tailscale HTTPS
    hmr: {
      protocol: 'wss',
      clientPort: 5173,
    },
    proxy: {
      '/api': {
        // Change to https if your backend is also using SSL
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Keep origin matching your local development proxy target
            proxyReq.setHeader('origin', 'http://127.0.0.1:5173');
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
