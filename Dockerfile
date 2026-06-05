# CloudHosting AI Panel — product-aware control panel (Node/Express).
# One image, behaviour selected at runtime by the PRODUCT env var
# (openclaw | hermes | flowise | langflow | dify) via adapters/<product>.js.
# Runs behind Caddy (panel on :8443). NOTE: the openclaw adapter calls the
# host `openclaw` CLI + `systemctl --user`, which only works when the panel
# runs NATIVELY on the host (not in this container); this image is for the
# hermes/builder adapters (config-write / open-product models).
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production PANEL_PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
