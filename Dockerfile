FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install --production
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]