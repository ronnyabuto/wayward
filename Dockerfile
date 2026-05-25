FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
VOLUME ["/app/data"]
CMD ["node", "src/bot.js"]
