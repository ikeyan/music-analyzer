import build from '@hono/vite-build/bun'
import bunAdapter from '@hono/vite-dev-server/bun'
import honox from 'honox/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  if (mode === 'client') {
    return {
      build: {
        rollupOptions: {
          input: ['/app/client.ts'],
          output: {
            entryFileNames: 'static/client.js',
            chunkFileNames: 'static/assets/[name]-[hash].js',
            assetFileNames: 'static/assets/[name].[ext]',
          },
        },
        emptyOutDir: false,
        manifest: true,
      },
    }
  }

  return {
    ssr: {
      external: [
        '@prisma/client',
        '.prisma/client',
        'react',
        'react-dom',
        'react-dom/server',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
    plugins: [
      honox({
        devServer: { adapter: bunAdapter },
        client: { input: ['/app/client.ts'] },
      }),
      build({ entry: 'app/server.ts' }),
    ],
  }
})
