# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates fontconfig fonts-dejavu-core fonts-noto-core \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
# Convert npm lockfile → pnpm lockfile, then install with BuildKit cache
RUN pnpm import
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY prisma ./prisma
COPY public ./public
COPY src ./src
# `pnpm run build` = prisma generate + tsc (see package.json scripts)
RUN pnpm run build
RUN pnpm prune --prod

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates fontconfig fonts-dejavu-core fonts-noto-core \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/public ./public
# Ensure upload directories exist even if `public/` is absent from the git checkout.
RUN mkdir -p /app/public/images/products /app/public/images/stores

EXPOSE 3001
CMD ["node", "dist/index.js"]
