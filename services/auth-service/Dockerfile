FROM node:20-alpine
WORKDIR /app

# shared package (linked via "file:../../packages/shared")
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js

# service manifest
COPY services/auth-service/package.json /app/services/auth-service/package.json

WORKDIR /app/services/auth-service
RUN npm install --omit=dev --install-links

COPY services/auth-service /app/services/auth-service

EXPOSE 3001
CMD ["node", "index.js"]
