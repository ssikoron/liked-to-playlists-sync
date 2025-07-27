# syntax=docker/dockerfile:1

########## Build deps ##########
FROM node:22-slim AS deps
WORKDIR /app
# Use pnpm via Corepack
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

########## Build app ##########
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

########## Runtime ##########
FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
# Install only production deps for a smaller image
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile
# Copy compiled code
COPY --from=build /app/dist ./dist
# Persist state on the host
VOLUME ["/app/.data"]
CMD ["node", "dist/index.js"]
