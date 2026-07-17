/*
 * openclaw adapter tests. No deps, no framework: `npm test` (or `node test/openclaw-adapter.test.mjs`).
 *
 * The adapter resolves its config dir at MODULE LOAD from OPENCLAW_DATA_DIR, so the env
 * var is set against a fresh temp dir BEFORE the dynamic import below. Everything runs
 * offline against real files; no network, no VM.
 *
 * These lock in behaviour that was verified against the shipped OpenClaw image
 * (ghcr.io/openclaw/openclaw:2026.6.1) — most importantly the MCP config SHAPE. A stray
 * top-level `mcpServers` key is not a cosmetic slip: OpenClaw's root schema is strict, so
 * it rejects the ENTIRE openclaw.json ("Unrecognized key") and takes the gateway, models
 * and channels down with it. Test 9 guards that specifically. Re-verify with:
 *   docker run --rm -v <dir>:/home/node/.openclaw \
 *     -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
 *     --entrypoint openclaw ghcr.io/openclaw/openclaw:2026.6.1 config validate
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
process.env.OPENCLAW_DATA_DIR = dir;
const oc = await import(new URL('../adapters/openclaw.js', import.meta.url));
const A = oc.default;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// pre-seed .env with a foreign line that must survive (round-trip preservation)
fs.writeFileSync(path.join(dir, '.env'), '# comment\nOPENCLAW_GATEWAY_TOKEN=keepme\nexport FOO=bar\n');

// 1. add a telegram token -> .env keeps foreign lines, adds token
await A.addChannel('telegram', '123456789abcdef', '111,222');
let env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
ok(/OPENCLAW_GATEWAY_TOKEN=keepme/.test(env), 'gateway token preserved');
ok(/# comment/.test(env), 'comment preserved');
ok(/export FOO=bar/.test(env), 'export line preserved');
ok(/TELEGRAM_BOT_TOKEN=123456789abcdef/.test(env), 'telegram token written');

// 2. allowFrom carries typed allowed users
let cfg = JSON.parse(fs.readFileSync(path.join(dir, 'openclaw.json'), 'utf8'));
ok(JSON.stringify(cfg.channels.telegram.allowFrom).includes('111'), 'allowedUsers -> allowFrom');

// 3. newline injection in a token is rejected
try { await A.addChannel('discord', 'tok\nEVIL=1', ''); } catch (_) { /* rejected at the input boundary */ }
env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
ok(!/EVIL=1/.test(env), 'newline injection blocked');

// 4. remove channel deletes its token line, keeps foreign
await A.removeChannel('telegram');
env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
ok(!/TELEGRAM_BOT_TOKEN=/.test(env), 'telegram token removed');
ok(/OPENCLAW_GATEWAY_TOKEN=keepme/.test(env), 'gateway token still there after remove');

// 5. fallback gets a unique id; removing by id removes only that one
await A.addFallback('anthropic', 'sk-ant-aaaaaaaa');
await A.addFallback('google', 'gk-bbbbbbbb');
let st = await A.status();
const fbs = st.configured.fallbacks;
ok(fbs.length === 2 && fbs[0].id !== fbs[1].id, 'fallbacks have distinct ids');
await A.removeFallback(fbs[0].id);
st = await A.status();
ok(st.configured.fallbacks.length === 1, 'removeFallback drops exactly one');

// 6. duplicate provider family with a different key is refused
await A.setPrimary('anthropic', 'sk-ant-primary1');
const dup = await A.addFallback('anthropic', 'sk-ant-different');
ok(dup && dup.error, 'duplicate provider-family key refused');

// 7. a foreign .env line whose name collides with an Object.prototype member survives applyAll
const envp = path.join(dir, '.env');
fs.writeFileSync(envp, fs.readFileSync(envp, 'utf8') + 'constructor=myval\n');
await A.setPrimary('anthropic', 'sk-ant-primary1');       // triggers applyAll -> writeEnvUpdates
ok(/^constructor=myval$/m.test(fs.readFileSync(envp, 'utf8')), 'prototype-named foreign env line preserved');

// 8. setPrimary refuses a family that already has a DIFFERENT-key fallback (no silent key swap).
//    A google fallback (gk-bbbbbbbb) survives from test 5; a google primary with another key must be refused.
const primClash = await A.setPrimary('google', 'gk-different-key');
ok(primClash && primClash.error, 'setPrimary refuses same-family fallback clash');

// 9. MCP: a built-in add writes the VERIFIED mcp.servers shape + MCP_<NAME>_KEY
ok(A.capabilities && A.capabilities.mcp === true, 'mcp capability enabled');
const mcpAdd = await A.addMcp({ provider: 'linear', apiKey: 'lin_api_abcdefgh' });
ok(mcpAdd && mcpAdd.add && mcpAdd.add.ok, 'addMcp(linear) applied');
{
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'openclaw.json'), 'utf8'));
  const s = c.mcp && c.mcp.servers && c.mcp.servers.linear;
  ok(!!s && s.url === 'https://mcp.linear.app/mcp' && s.transport === 'streamable-http'
     && s.enabled === true
     && s.headers.Authorization === 'Bearer ${MCP_LINEAR_KEY}', 'mcp.servers.linear written with transport + env-ref header');
  // guards the fatal regression: a top-level mcpServers key invalidates the WHOLE config
  ok(!('mcpServers' in c), 'no top-level mcpServers key (root schema is strict)');
  const e = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  ok(/^MCP_LINEAR_KEY=lin_api_abcdefgh$/m.test(e), 'MCP_LINEAR_KEY written to .env');
}

// 10. MCP: a custom server needs a valid url
const mcpBad = await A.addMcp({ provider: 'custom', apiKey: 'k'.repeat(10), name: 'x', url: 'not-a-url' });
ok(mcpBad && mcpBad.error, 'addMcp(custom) rejects an invalid URL');

// 11. MCP remove drops the server and its stale key from .env
await A.removeMcp('linear');
{
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'openclaw.json'), 'utf8'));
  ok(!(c.mcp && c.mcp.servers && c.mcp.servers.linear), 'removeMcp drops the mcp.servers entry');
  const e = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  ok(!/MCP_LINEAR_KEY=/.test(e), 'removeMcp drops the stale MCP_LINEAR_KEY');
  ok(/OPENCLAW_GATEWAY_TOKEN=keepme/.test(e), 'gateway token still preserved after mcp churn');
}

// 12. custom MCP URL SSRF guard: internal/metadata address + plaintext http refused
const mcpSsrf = await A.addMcp({ provider: 'custom', apiKey: 'k'.repeat(10), name: 'evil', url: 'https://169.254.169.254/latest/meta-data/' });
ok(mcpSsrf && mcpSsrf.error, 'addMcp(custom) blocks an internal/metadata URL');
const mcpHttp = await A.addMcp({ provider: 'custom', apiKey: 'k'.repeat(10), name: 'plain', url: 'http://mcp.example.com/mcp' });
ok(mcpHttp && mcpHttp.error, 'addMcp(custom) refuses plaintext http');

// 13. two custom names that normalize to the same MCP_<NAME>_KEY: the second is refused
const okName = await A.addMcp({ provider: 'custom', apiKey: 'key-aaaa1111', name: 'my-github', url: 'https://mcp.example.com/a' });
ok(okName && okName.add && okName.add.ok, 'addMcp(custom my-github) applied');
const clashName = await A.addMcp({ provider: 'custom', apiKey: 'key-bbbb2222', name: 'my_github', url: 'https://mcp.example.com/b' });
ok(clashName && clashName.error, 'addMcp refuses a separator-collision name (my_github vs my-github)');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
