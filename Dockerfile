# syntax=docker/dockerfile:1
FROM node:lts-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts
RUN npm run build

FROM node:lts-alpine AS runner
WORKDIR /app
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
RUN npm install -g supergateway
ENV NODE_ENV=production
EXPOSE 8000
CMD ["sh", "-c", "supergateway --stdio \"node build/index.js\" --outputTransport streamableHttp --stateful --sessionTimeout 3600000 --port ${PORT:-8000}"]
