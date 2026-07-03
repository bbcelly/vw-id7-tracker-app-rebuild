# Build: compile the frontend and the server
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# Runtime: server dist + production deps + built frontend, nothing else
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    DB_PATH=/app/data/tracker.db \
    PORT=3000
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/web/dist /app/web/dist
VOLUME /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
