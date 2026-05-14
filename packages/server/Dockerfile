FROM node:18-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci
RUN npx turbo run build --filter=@consentguard/server

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
RUN cd packages/server && npm install --production
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
