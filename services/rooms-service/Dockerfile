FROM node:20-alpine
WORKDIR /app

# shared package (linked via "file:../../packages/shared")
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js

# service manifest
COPY services/rooms-service/package.json /app/services/rooms-service/package.json

WORKDIR /app/services/rooms-service
RUN npm install --omit=dev --install-links

COPY services/rooms-service /app/services/rooms-service

EXPOSE 3003
CMD ["node", "index.js"]
