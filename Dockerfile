FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

RUN npm install && npm run build && npm prune --omit=dev

ENTRYPOINT ["node", "/app/dist/index.js"]
