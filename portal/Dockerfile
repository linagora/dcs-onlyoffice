FROM node:22.23.3-alpine
RUN npm install --global pnpm@10.27.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod --filter @dcs/portal...
WORKDIR /repo/portal
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "src/main.ts"]
