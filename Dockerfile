FROM oven/bun:1.1

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY schemas ./schemas
COPY scripts ./scripts

RUN if command -v apt-get >/dev/null; then \
    apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*; \
  elif command -v apk >/dev/null; then \
    apk add --no-cache git; \
  else \
    echo "No supported package manager found for git install" && exit 1; \
  fi

RUN bun install --production

ENTRYPOINT ["bun", "/app/src/index.ts"]
