# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app
USER root
RUN apt update

FROM ghcr.io/streamloop/ffmpeg:2 as ffmpeg
# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
WORKDIR /temp/dev
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe

COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile
COPY . .
RUN bun build --minify --target bun --outfile=server.js src/server-ffmpeg.ts

EXPOSE 3000/tcp
ENTRYPOINT ["bun", "server.js"]