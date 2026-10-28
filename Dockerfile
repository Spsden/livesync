FROM node:22-bookworm-slim AS build
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY scripts ./scripts
COPY --from=build /app/dist/client ./dist/client

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "server/index.js"]
