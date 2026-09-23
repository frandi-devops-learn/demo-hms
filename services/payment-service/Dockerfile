FROM node:20-alpine
WORKDIR /app

COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js
COPY services/payment-service/package.json /app/services/payment-service/package.json

WORKDIR /app/services/payment-service
RUN npm install --omit=dev --install-links

COPY services/payment-service /app/services/payment-service

EXPOSE 3006
CMD ["node", "index.js"]
