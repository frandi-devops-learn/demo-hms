FROM node:20-alpine
WORKDIR /app

# shared package (linked via "file:../../packages/shared")
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js

# service manifest
COPY services/notifications-service/package.json /app/services/notifications-service/package.json

WORKDIR /app/services/notifications-service
RUN npm install --omit=dev --install-links

COPY services/notifications-service /app/services/notifications-service

EXPOSE 3005
CMD ["node", "index.js"]
