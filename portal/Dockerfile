FROM node:22.23.3-alpine AS base
RUN npm install --global pnpm@10.27.0
# Lets pnpm reshape node_modules without asking for confirmation.
ENV CI=true
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

FROM base AS plugin
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @dcs/plugin... \
  && pnpm --filter @dcs/plugin build

FROM base AS runtime
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod --filter @dcs/portal...
COPY --from=plugin /repo/plugin/dist /repo/portal/plugin-dist
WORKDIR /repo/portal
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "src/main.ts"]
