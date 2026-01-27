FROM oven/bun:1.1

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY docs ./docs

RUN bun install --production

ENTRYPOINT ["bun", "/app/src/index.ts"]
