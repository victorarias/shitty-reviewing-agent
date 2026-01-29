FROM oven/bun:1.1

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
COPY scripts ./scripts

RUN bun install --production

ENTRYPOINT ["bun", "/app/src/index.ts"]
