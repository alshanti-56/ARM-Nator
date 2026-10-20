FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/media-companion
COPY tools/media-companion/ ./

ENV MEDIA_COMPANION_HOST=127.0.0.1 \
    MEDIA_COMPANION_PORT=4321

EXPOSE 4321
USER node
CMD ["node", "server.mjs"]
