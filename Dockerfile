# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 CACHE_DIR=/data/cache PATH="/usr/local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates curl unzip gosu \
    && rm -rf /var/lib/apt/lists/*
# YTDLP_REFRESH is a cache-busting token (pass `--build-arg YTDLP_REFRESH=$(date +%Y%U)`
# from CI so this layer's hash changes every week). Without it, BuildKit would serve the
# pip layer from the GHA cache unchanged and yt-dlp would silently rot — YouTube rotates
# its nsig solver regularly, so a stale yt-dlp breaks audio extraction. The weekly cron
# additionally builds with `no-cache: true` to guarantee a fresh fetch.
ARG YTDLP_REFRESH=unset
ENV YTDLP_REFRESH=${YTDLP_REFRESH}
# bgutil-ytdlp-pot-provider is the client-side plugin that talks to the optional
# `bgutil-pot` sidecar (PO_TOKEN_PROVIDER_URL). yt-dlp[default] alone cannot use the
# sidecar; the plugin is auto-discovered at runtime and only activates when the
# `youtubepot-bgutilhttp:base_url=…` extractor-arg is supplied by the app.
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" bgutil-ytdlp-pot-provider \
    && yt-dlp --version
# Pin Deno to a specific release and verify its SHA256 instead of piping a remote installer
# into sh (curl|sh would run unverified, unpinned code as root and freeze any compromised
# artifact into the GHA layer cache). Pinned-zip-plus-checksum is reproducible and integrity-checked.
ARG DENO_VERSION=2.1.4
ARG DENO_SHA256=54a81939cccb2af114c4d0a68a554cf4a04b1f08728e70f663f83781de19d785
RUN curl -fsSL -o /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
    && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
    && unzip -o /tmp/deno.zip -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/deno \
    && rm -f /tmp/deno.zip \
    && deno --version
WORKDIR /app
RUN useradd --create-home --uid 10001 app && mkdir -p "${CACHE_DIR}" && chown -R app:app "${CACHE_DIR}" /app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# NOTE: no `USER app` here — the entrypoint starts as root only to chown the
# mounted cache volume (which may be root-owned), then drops to 'app' via gosu.
VOLUME ["/data/cache"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
