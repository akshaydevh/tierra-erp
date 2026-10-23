# The Tierra backend, built from the repository root: the erp view SQL (tools/sap-import/sql) and the SAP column
# list (backend/test/sap-schema.sql) are read at boot when ERP_BACKEND=erpnext. Railway's backend service builds
# this (root directory "/"); its start command is `cd backend && node dist/index.js`, so the image keeps the repo
# layout under /app and starts from /app.
FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV TZ=Asia/Kolkata
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/assets ./assets
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/drizzle ./drizzle
COPY backend/test/sap-schema.sql ./test/sap-schema.sql
COPY tools/sap-import/sql /app/tools/sap-import/sql
RUN npm run build
ENV NODE_ENV=production
WORKDIR /app
EXPOSE 3002
CMD ["sh", "-c", "cd backend && node dist/index.js"]
