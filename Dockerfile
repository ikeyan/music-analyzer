FROM oven/bun:1.3.13 AS builder
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

FROM oven/bun:1.3.13-slim AS runtime
WORKDIR /app
# Flatten dist/ into /app so the bundled server resolves /static/* (relative
# to CWD via root: "./") AND db:push and the server share the same CWD; this
# keeps any relative DATABASE_URL pointing at the same SQLite file.
COPY --from=builder /app/dist/ ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/app/generated ./app/generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts /app/package.json ./
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=3000
# `/data` is the conventional mount point for the SQLite file; compose / `docker
# run -v` is expected to attach a persistent volume there. The default makes
# the image self-starting for ad-hoc `docker run` too.
ENV DATABASE_URL=file:/data/dev.db
EXPOSE 3000
# `db:push` syncs the SQLite schema (no-op when already up-to-date; migrations
# aren't versioned yet, switch to `migrate deploy` once they are). `exec` so
# Bun becomes PID 1 and receives SIGTERM from `docker stop` directly.
CMD ["sh", "-c", "bun run db:push && exec bun run ./index.js"]
