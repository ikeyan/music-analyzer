import { createRoute } from 'honox/factory'
import { prisma } from '../lib/prisma'

export default createRoute(async (c) => {
  const message = await prisma.message.findFirst({
    orderBy: { id: 'asc' },
  })
  const text = message?.content ?? 'Hello, World!'

  return c.render(
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{text}</h1>
      <p>music-analyzer / bun + hono + honox + react + prisma + sqlite</p>
    </main>,
    { title: 'music-analyzer' },
  )
})
