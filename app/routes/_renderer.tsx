import { reactRenderer } from '@hono/react-renderer'

export default reactRenderer(({ children, title }) => {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {import.meta.env.PROD ? (
          <script type="module" src="/static/client.js" />
        ) : (
          <script type="module" src="/app/client.ts" />
        )}
        <title>{title ?? 'music-analyzer'}</title>
      </head>
      <body>{children}</body>
    </html>
  )
})
