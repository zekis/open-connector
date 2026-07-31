FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci --ignore-scripts \
  && node node_modules/@anthropic-ai/claude-code/install.cjs
COPY tsconfig.json vitest.config.ts vitest.setup.ts ./
COPY .oxfmtrc.json .oxlintrc.json ./
COPY migrations ./migrations
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
RUN npm run generate:catalog
RUN npm run build
RUN npm run build --workspace web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OOMOL_CONNECT_DATA_DIR=/app/data
ENV PATH=/app/node_modules/.bin:$PATH
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && node node_modules/@anthropic-ai/claude-code/install.cjs
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY migrations ./migrations
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist

VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
CMD ["node", "src/server/index.ts"]
