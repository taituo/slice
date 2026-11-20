# One image for every Node service (api, worker, mcp, simulator); the command picks the role.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/workflows/package.json packages/workflows/
COPY packages/api/package.json packages/api/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
ARG BUILD_ID=dev
ENV BUILD_ID=${BUILD_ID}
EXPOSE 4000 4100
CMD ["npx", "tsx", "packages/api/src/server.ts"]
