FROM node:22-alpine AS build
WORKDIR /app
COPY services/frontend/package.json services/frontend/package-lock.json ./
RUN npm ci
COPY services/frontend ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 API_GATEWAY_URL=http://api-gateway:3000
COPY services/frontend/package.json services/frontend/package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["npm", "start"]
