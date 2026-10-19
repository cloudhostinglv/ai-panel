# CloudHosting AI Panel: product-aware control panel (Node/Express).
# One image, behaviour selected at runtime by the PRODUCT env var
# (openclaw | hermes | flowise | langflow | dify) via adapters/<product>.js.
# Listens on 8080 inside the container; on the VMs Caddy serves it over HTTPS
# on :8443. The openclaw and hermes adapters only write config files into the
# shared data dir; a host-side service restarts the agent.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
# Build identity, baked by CI (docker build --build-arg GIT_SHA=$GITHUB_SHA). The
# panel reports PANEL_VERSION at /api/version and compares it to the latest commit
# on ai-panel@main to decide whether a panel update is available. Defaults to "dev"
# for local builds so the panel reports "unknown" rather than a false update.
ARG GIT_SHA=dev
ARG BUILD_DATE=
ENV NODE_ENV=production PANEL_PORT=8080 PANEL_VERSION=$GIT_SHA PANEL_BUILD_DATE=$BUILD_DATE
EXPOSE 8080
CMD ["node", "server.js"]
