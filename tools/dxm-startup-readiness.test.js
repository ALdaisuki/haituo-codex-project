#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const {
  SCHEMA_VERSION,
  parseArgs,
  probeStartupReadiness,
  selectTarget,
  isLocalHttpEndpoint,
  isDianxiaomiUrl,
} = require('./dxm-startup-readiness');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function makeServer(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          body = null;
        }
      }
      const result = handler(req, body);
      res.statusCode = result.statusCode || 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result.body));
    });
  });
}

async function withServers({ targets, pageEvidence }, fn) {
  const cdpServer = makeServer((req) => {
    if (req.url === '/json/version') {
      return {
        body: {
          Browser: 'Chrome/fixture',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fixture',
        },
      };
    }
    if (req.url === '/json/list') {
      return { body: targets };
    }
    return { statusCode: 404, body: { error: 'not_found' } };
  });
  const webbridgeServer = makeServer((req, body) => {
    if (body && body.action === 'find_tab') return { body: { ok: true, data: { url: targets[0] && targets[0].url } } };
    if (body && body.action === 'evaluate') return { body: { ok: true, data: { value: JSON.stringify(pageEvidence) } } };
    return { statusCode: 400, body: { ok: false, error: 'unsupported_action' } };
  });
  const cdpEndpoint = await listen(cdpServer);
  const webbridgeEndpoint = `${await listen(webbridgeServer)}/command`;
  try {
    return await fn(cdpEndpoint, webbridgeEndpoint);
  } finally {
    await close(cdpServer);
    await close(webbridgeServer);
  }
}

function args(overrides = {}) {
  return {
    command: 'probe',
    asin: 'B000000000',
    targetUrl: 'https://www.dianxiaomi.com/web/smt/edit?id=123',
    cdpHttpEndpoint: 'http://127.0.0.1:19223',
    webbridgeEndpoint: 'http://127.0.0.1:10086/command',
    webbridgeSession: 'test-session',
    timeoutMs: 2000,
    ...overrides,
  };
}

const target = {
  id: 'target-1',
  type: 'page',
  title: 'Dianxiaomi edit',
  url: 'https://www.dianxiaomi.com/web/smt/edit?id=123',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-1',
};

assert.strictEqual(isLocalHttpEndpoint('http://127.0.0.1:19223'), true);
assert.strictEqual(isLocalHttpEndpoint('http://localhost:19223'), true);
assert.strictEqual(isLocalHttpEndpoint('https://127.0.0.1:19223'), false);
assert.strictEqual(isLocalHttpEndpoint('http://example.com:19223'), false);
assert.strictEqual(isDianxiaomiUrl('https://www.dianxiaomi.com/web/smt/edit?id=123'), true);
assert.strictEqual(isDianxiaomiUrl('https://example.com/web/smt/edit?id=123'), false);

assert.throws(
  () => parseArgs(['node', 'tool', 'probe', '--script', 'evil.js']),
  /Unsupported option/
);

assert.deepStrictEqual(
  selectTarget([target], 'https://www.dianxiaomi.com/web/smt/edit?id=123').selectedTarget.target_id,
  'target-1'
);
assert.strictEqual(
  selectTarget([], 'https://www.dianxiaomi.com/web/smt/edit?id=123').status,
  'dxm_startup_probe_no_target'
);
assert.strictEqual(
  selectTarget([target, { ...target, id: 'target-2' }], 'https://www.dianxiaomi.com/web/smt/edit?id=123').status,
  'dxm_startup_probe_ambiguous_target'
);

(async () => {
  await withServers({
    targets: [target],
    pageEvidence: {
      href: target.url,
      title: 'Dianxiaomi edit',
      readyState: 'complete',
      bodySnippet: '店小秘 产品 B000000000 待发布',
      hasPasswordInput: false,
      hasLoginText: false,
      hasDxmMarker: true,
      hasReadonlyPreflight: true,
      asinVisible: true,
    },
  }, async (cdpEndpoint, webbridgeEndpoint) => {
    const result = await probeStartupReadiness(args({ cdpHttpEndpoint: cdpEndpoint, webbridgeEndpoint }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'dxm_startup_probe_ready');
    assert.strictEqual(result.schema_version, SCHEMA_VERSION);
    assert.strictEqual(result.cdp.ok, true);
    assert.strictEqual(result.selected_target.target_id, 'target-1');
    assert.strictEqual(result.login.status, 'logged_in');
    assert.strictEqual(result.readonly_evidence.target_url_matched, true);
    assert.strictEqual(result.readonly_evidence.asin_visible, true);
    assert.strictEqual(result.blockers.length, 0);
  });

  await withServers({
    targets: [],
    pageEvidence: {},
  }, async (cdpEndpoint, webbridgeEndpoint) => {
    const result = await probeStartupReadiness(args({ cdpHttpEndpoint: cdpEndpoint, webbridgeEndpoint }));

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'dxm_startup_probe_no_target');
    assert.deepStrictEqual(result.blockers, ['target_not_found']);
    assert.strictEqual(result.selected_target, null);
  });

  await withServers({
    targets: [target, { ...target, id: 'target-2' }],
    pageEvidence: {},
  }, async (cdpEndpoint, webbridgeEndpoint) => {
    const result = await probeStartupReadiness(args({ cdpHttpEndpoint: cdpEndpoint, webbridgeEndpoint }));

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'dxm_startup_probe_ambiguous_target');
    assert.deepStrictEqual(result.blockers, ['ambiguous_target']);
  });

  await withServers({
    targets: [target],
    pageEvidence: {
      href: target.url,
      title: 'Dianxiaomi login',
      readyState: 'complete',
      bodySnippet: '登录 扫码',
      hasPasswordInput: true,
      hasLoginText: true,
      hasDxmMarker: false,
      hasReadonlyPreflight: false,
      asinVisible: false,
    },
  }, async (cdpEndpoint, webbridgeEndpoint) => {
    const result = await probeStartupReadiness(args({ cdpHttpEndpoint: cdpEndpoint, webbridgeEndpoint }));

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'dxm_startup_probe_login_required');
    assert.deepStrictEqual(result.blockers, ['login_required']);
    assert.strictEqual(result.login.status, 'login_required');
  });

  const invalid = await probeStartupReadiness(args({ cdpHttpEndpoint: 'http://example.com:19223' }));
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.status, 'dxm_startup_probe_invalid_cdp_endpoint');
  assert.deepStrictEqual(invalid.blockers, ['local_cdp_endpoint_required']);

  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'dxm-startup-readiness.js'),
    'probe',
    '--asin',
    'B000000000',
    '--target-url',
    target.url,
    '--cdp-http-endpoint',
    'http://example.com:19223',
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0);
  const cliResult = JSON.parse(cli.stdout);
  assert.strictEqual(cliResult.status, 'dxm_startup_probe_invalid_cdp_endpoint');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
