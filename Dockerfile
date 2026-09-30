# RelayPay support agent: voice webhook server + Claude Agent SDK + MCP server, one container.
# Built by Render from render.yaml. Secrets are set in the Render dashboard, never baked in.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc

FROM node:24-slim
ENV NODE_ENV=production \
    VOICE_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The knowledge base and the widget are read at runtime from the project root.
COPY assets ./assets
COPY public ./public
# The fallback logs land here when Supabase is unreachable. The container's disk is
# ephemeral, so these survive only until the next deploy or restart.
RUN mkdir -p logs && chown -R node:node /app
USER node
EXPOSE 10000
CMD ["node", "dist/src/server/main.js"]
