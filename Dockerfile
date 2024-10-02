# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app
RUN bunx @puppeteer/browsers install chrome@stable

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile
COPY . .
RUN bun build --minify --target bun --outfile=server.js src/server.ts

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS release
COPY --from=install /temp/dev/server.js .

USER bun
EXPOSE 3000/tcp
ENTRYPOINT ["bun", "server.js"]