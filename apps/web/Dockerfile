FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hearth/web build

FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/docker-entrypoint.sh /hearth-entrypoint.sh
RUN chmod +x /hearth-entrypoint.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV PORT=80
EXPOSE 80
ENTRYPOINT ["/hearth-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
