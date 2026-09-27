FROM node:22.23.3-alpine
RUN npm install --global pnpm@10.27.0
# Lets pnpm reshape node_modules without asking for confirmation.
ENV CI=true
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# The lockfile resolves the web SDK to the vendored build.
COPY plugin/vendor plugin/vendor
RUN pnpm fetch --prod
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod --filter @dcs/policy...
WORKDIR /repo/policy
ENV NODE_ENV=production
USER node
EXPOSE 3001
CMD ["node", "src/main.ts"]
