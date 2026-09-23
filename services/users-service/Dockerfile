FROM node:20-alpine
WORKDIR /app

# shared package (linked via "file:../../packages/shared")
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js

# service manifest
COPY services/users-service/package.json /app/services/users-service/package.json

WORKDIR /app/services/users-service
RUN npm install --omit=dev --install-links

COPY services/users-service /app/services/users-service

EXPOSE 3002
CMD ["node", "index.js"]
