# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_API_PROXY_AVAILABLE=__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__
ENV VITE_API_PROXY_LOCKED=__VITE_API_PROXY_LOCKED_PLACEHOLDER__
ENV VITE_BACKEND_TASKS_ENABLED=__VITE_BACKEND_TASKS_ENABLED_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__
ENV VITE_DOCKER_LEGACY_API_URL_USED=__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

ENV HOST=0.0.0.0
ENV PORT=80
ENV DEFAULT_API_URL=
ENV API_PROXY_URL=
ENV ENABLE_API_PROXY=false
ENV LOCK_API_PROXY=false
ENV ENABLE_BACKEND_TASKS=false
ENV PUBLIC_DIR=/usr/share/nginx/html

COPY --from=build /app/dist /usr/share/nginx/html
COPY server/image-task-server.mjs /app/server/image-task-server.mjs
COPY --chmod=755 deploy/migrate-api-env.envsh /app/docker-entrypoint.d/05-migrate-api-env.envsh
COPY --chmod=755 deploy/inject-api-url.sh /app/docker-entrypoint.d/40-inject-api-url.sh
COPY --chmod=755 deploy/start.sh /app/start.sh

EXPOSE 80

CMD ["/app/start.sh"]
