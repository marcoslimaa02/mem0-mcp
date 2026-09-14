FROM node:lts-alpine
WORKDIR /app
COPY server.js .
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "server.js"]
