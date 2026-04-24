# Lightweight test image for music-analyzer. Runs the vite dev server so the
# stack boots quickly without a full prod build. Not intended for production.
FROM oven/bun:1.3.11

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json vite.config.ts .oxlintrc.json .oxfmtrc.json ./
COPY app ./app

RUN mkdir -p /data
ENV DATABASE_URL=file:/data/dev.db

EXPOSE 5173

# Generate the prisma client, push the schema, seed, then start vite bound to
# all interfaces so Caddy can reach it over the compose network.
CMD ["sh", "-c", "bun run db:generate && bun run db:push && bun run db:seed && bun run dev --host 0.0.0.0 --port 5173"]
