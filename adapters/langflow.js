'use strict';
/*
 * langflow adapter — REDUCED builder.
 * Langflow's web UI + API listens on container port 7860 (Caddy fronts it). The
 * client configures providers/keys inside Langflow; this panel only links to it.
 */
module.exports = require('./_builder')({ id: 'langflow', label: 'Langflow', productPort: 7860 });
