'use strict';
/*
 * dify adapter — REDUCED builder.
 * Dify ships its own nginx (container port 80) that fans out to api/web/plugin/files.
 * The client configures model providers inside Dify's console; this panel only
 * links to it.
 */
module.exports = require('./_builder')({ id: 'dify', label: 'Dify', productPort: 80 });
