# RemesaFlow backend — multi-stage build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Config comes from env vars (NETWORK, PORT, X402_ENABLED, QUOTE_ENGINE, ...).
# The repo-root .env is NOT baked into the image.
EXPOSE 3000
CMD ["node", "dist/index.js"]
