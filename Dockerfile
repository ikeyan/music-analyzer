FROM oven/bun:1.3.11 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY prisma/ ./prisma/
COPY prisma.config.ts ./
# prisma.config.ts reads env("DATABASE_URL") at load. `db:generate` only emits
# the client (no DB I/O), so a dummy URL is enough here; compose env supplies
# the real one at runtime.
RUN DATABASE_URL=file:/tmp/build.db bun run db:generate
COPY tsconfig.json vite.config.ts ./
COPY app/ ./app/
RUN bun run build

FROM oven/bun:1.3.11-slim AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/app/generated ./app/generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts /app/package.json ./
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# `db:push` syncs the schema to the SQLite file on every start (no-op when
# already up-to-date). Migrations are not yet versioned in this repo; switch
# to `migrate deploy` once they are.
CMD ["sh", "-c", "bun run db:push && bun run ./dist/index.js"]
