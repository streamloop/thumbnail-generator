# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app
USER root
RUN apt update

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
WORKDIR /temp/dev
COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile
RUN bunx @puppeteer/browsers install chrome@stable --install-deps
COPY . .
RUN bun build --minify --target bun --outfile=server.js src/server.ts

EXPOSE 3000/tcp
ENTRYPOINT ["bun", "server.js"]