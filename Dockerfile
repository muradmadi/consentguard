FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npx turbo run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages ./packages
RUN npm ci --omit=dev --ignore-scripts
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
