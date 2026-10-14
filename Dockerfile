FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["npm", "start"]
