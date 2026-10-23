# The Tierra backend for the ERPNext build. Built from the repository root (not /backend): ERP_BACKEND=erpnext
# reads the erp view SQL (tools/sap-import/sql) and the SAP column list (backend/test/sap-schema.sql) at boot.
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
EXPOSE 3002
CMD ["node", "dist/index.js"]
