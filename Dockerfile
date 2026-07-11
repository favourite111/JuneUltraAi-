FROM node:24-slim AS builder

# Install pnpm
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy library packages
COPY lib/api-zod ./lib/api-zod
COPY lib/db ./lib/db

# Copy the API server
COPY artifacts/api-server ./artifacts/api-server

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Build the API server
RUN pnpm --filter @workspace/api-server run build

# --- Production image ---
FROM node:24-slim

WORKDIR /app

# node_modules is required at runtime for native/externalized deps
# (e.g. argon2) that esbuild does not bundle into dist/index.mjs.
# dist must stay nested under artifacts/api-server so Node's module
# resolution (which walks up from the importing file) finds
# artifacts/api-server/node_modules -- pnpm does not hoist argon2 to
# the workspace root node_modules.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
