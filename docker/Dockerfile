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

FROM saynaai/sayna@sha256:6ec99b4e1c1c1255c57305ecb5b9bf1647723d7400f350baa21470b9106b259b AS sayna

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OOMOL_CONNECT_DATA_DIR=/app/data
ENV OOMOL_CONNECT_SAYNA_EMBEDDED=true
ENV LD_LIBRARY_PATH=/opt/sayna
ENV PATH=/app/node_modules/.bin:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates libssl3 libstdc++6 libva2 libva-drm2 libx11-6 libxext6 libxrandr2 \
  libxcomposite1 libxdamage1 libxfixes3 libglib2.0-0 libgbm1 libdrm2 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && node node_modules/@anthropic-ai/claude-code/install.cjs
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY scripts/start-container.ts ./scripts/start-container.ts
COPY migrations ./migrations
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist
COPY --from=sayna /app/sayna /opt/sayna/sayna
COPY --from=sayna /app/libonnxruntime.so* /opt/sayna/
COPY --from=sayna /app/cache /opt/sayna/cache
COPY LICENSE.txt /usr/share/doc/sayna/LICENSE

VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
CMD ["node", "scripts/start-container.ts"]
