FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "dist/index.js"]
