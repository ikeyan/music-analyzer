FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg

FROM oven/bun:1.3.13 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY prisma/ ./prisma/
COPY prisma.config.ts ./
RUN bun run db:generate
COPY tsconfig.json vite.config.ts ./
COPY app/ ./app/
RUN bun run build

FROM oven/bun:1.3.13-slim AS runtime
WORKDIR /app
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
# server (root: "./")とdb:pushでCWDを揃えるためdist/を/appに展開
COPY --from=builder /app/dist/ ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/app/generated ./app/generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts /app/package.json ./
RUN mkdir -p /data
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=file:/data/dev.db
EXPOSE 3000
# execでBunをPID 1にしてdocker stopのSIGTERMを直接受け取らせる
CMD ["sh", "-c", "bun run db:push && exec bun run ./index.js"]
