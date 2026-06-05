'use strict';
/*
 * flowise adapter — REDUCED builder.
 * Flowise builder UI listens on container port 3000 (Caddy fronts it). The client
 * configures providers/keys inside Flowise's own UI; this panel only links to it.
 */
module.exports = require('./_builder')({ id: 'flowise', label: 'Flowise', productPort: 3000 });
