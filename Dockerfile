FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg

FROM oven/bun:1.3.13 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile
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
# execでBunをPID 1にしてdocker stopのSIGTERMを直接受け取らせる。
# --accept-data-loss は旧 schema (Message table 等) が残った volume で起動するときに
# 破壊的変更を許可するため。本サービスの DB は upload metadata のみで、起動時の
# 整合は失った行を sweeper / S3 で補修できるので非対話で進めてよい
CMD ["sh", "-c", "bun run db:push --accept-data-loss && exec bun run ./index.js"]
