# Lightweight test image for music-analyzer. Runs the vite dev server so the
# stack boots quickly without a full prod build. Not intended for production.
FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg

FROM oven/bun:1.4.0

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

WORKDIR /app

# Install deps first for better layer caching.
# proxy-ca.crt は sandbox の MITM proxy CA (scripts/setup-sandbox.ts が stage する)。
# glob なので CI 等の未 stage 時はマッチせず、NODE_EXTRA_CA_CERTS も不在ファイルを
# 指すが bun は built-in CA にフォールバックする。
COPY package.json bun.lock proxy-ca.crt* ./
COPY patches/ ./patches/
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    NODE_EXTRA_CA_CERTS="$PWD/proxy-ca.crt" bun install --frozen-lockfile

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json vite.config.ts .oxlintrc.json .oxfmtrc.json ./
COPY app ./app

RUN mkdir -p /data
ENV DATABASE_URL=file:/data/dev.db
ENV NODE_ENV=development

EXPOSE 5173

# Generate the prisma client, push the schema, seed, then start vite bound to
# all interfaces so Caddy can reach it over the compose network.
CMD ["sh", "-c", "bun run db:generate && bun run db:push --accept-data-loss && bun run db:seed && bun run dev --host 0.0.0.0 --port 5173"]
