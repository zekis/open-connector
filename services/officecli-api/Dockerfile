FROM node:24-bookworm-slim

ARG OFFICECLI_VERSION=1.0.123

LABEL org.opencontainers.image.title="Open Connector OfficeCLI API" \
      org.opencontainers.image.description="Authenticated HTTP facade for OfficeCLI" \
      org.opencontainers.image.source="https://github.com/oomol-lab/open-connector"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libicu72 python3 python3-openpyxl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --omit=dev --allow-scripts=@officecli/officecli "@officecli/officecli@${OFFICECLI_VERSION}" \
    && OFFICECLI_SKIP_UPDATE=1 officecli --version \
    && npm cache clean --force \
    && mkdir -p /app /documents \
    && chown -R node:node /app /documents

COPY --chown=node:node services/officecli-api/server.mjs /app/server.mjs
COPY --chown=node:node services/officecli-api/duplicate-worksheet.py /app/duplicate-worksheet.py

ENV NODE_ENV=production \
    HOME=/tmp/officecli-home \
    XDG_CACHE_HOME=/tmp/officecli-cache \
    DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/officecli-dotnet \
    OFFICECLI_API_PORT=3030 \
    OFFICECLI_BATCH_ALLOW_STDIN_REDIRECT=1 \
    OFFICECLI_DOCUMENT_ROOT=/documents \
    OFFICECLI_RESIDENT_FLUSH=each \
    OFFICECLI_SKIP_UPDATE=1

USER node
WORKDIR /app
EXPOSE 3030

CMD ["node", "/app/server.mjs"]
