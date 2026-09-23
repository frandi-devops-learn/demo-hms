FROM node:20-alpine
WORKDIR /app

# shared package (linked via "file:../../packages/shared")
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js

# service manifest
COPY services/bookings-service/package.json /app/services/bookings-service/package.json

WORKDIR /app/services/bookings-service
RUN npm install --omit=dev --install-links

COPY services/bookings-service /app/services/bookings-service

EXPOSE 3004
CMD ["node", "index.js"]
