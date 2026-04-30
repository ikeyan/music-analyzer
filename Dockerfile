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
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "./dist/index.js"]
