# OPflow backend — one image, two processes: PROCESS_TYPE=api (default) or worker.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
RUN addgroup -S opflow && adduser -S opflow -G opflow
COPY --from=build --chown=opflow:opflow /app/node_modules ./node_modules
COPY --from=build --chown=opflow:opflow /app/dist ./dist
COPY --chown=opflow:opflow package.json ./
# Demo servers keep uploaded files here (real servers use R2); the app user must be able to write it.
RUN mkdir -p /app/.uploads && chown opflow:opflow /app/.uploads
USER opflow
EXPOSE 3000
# Render and Fly set PORT themselves; the API reads it.
# The worker runs the same image with PROCESS_TYPE=worker (see fly.toml).
CMD ["sh", "-c", "if [ \"$PROCESS_TYPE\" = worker ]; then node dist/worker.js; else node dist/main.js; fi"]
