FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
