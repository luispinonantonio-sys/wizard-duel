FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "server.js"]
