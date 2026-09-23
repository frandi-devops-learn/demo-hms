FROM node:20-alpine
WORKDIR /app

# shared package (linked via "file:../../packages/shared")
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/index.js /app/packages/shared/index.js

# service manifest
COPY services/api-gateway/package.json /app/services/api-gateway/package.json

WORKDIR /app/services/api-gateway
RUN npm install --omit=dev --install-links

COPY services/api-gateway /app/services/api-gateway

EXPOSE 3000
CMD ["node", "index.js"]
