# node 22: @anthropic-ai/sdk needs a supported runtime, and 18 is past end-of-life.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# Notifier HTTP/SSE server (Railway injects PORT; 3000 is the local default)
EXPOSE 3000

CMD ["node", "index.js"]
