FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm build && pnpm v2:build

FROM build AS production-deps
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production V2_HOST=0.0.0.0 V2_PORT=8790
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8790
CMD ["node", "dist-server/index.js"]

FROM nginx:1.28-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/v2/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
