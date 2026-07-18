FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# Notifier HTTP/SSE server (Railway injects PORT; 3000 is the local default)
EXPOSE 3000

CMD ["node", "index.js"]
