FROM node:20-alpine
WORKDIR /app

COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js
COPY services/operations-service/package.json /app/services/operations-service/package.json

WORKDIR /app/services/operations-service
RUN npm install --omit=dev --install-links

COPY services/operations-service /app/services/operations-service
COPY db/migrations/005_phase1_operations.sql /app/db/migrations/005_phase1_operations.sql

EXPOSE 3007
CMD ["node", "index.js"]
