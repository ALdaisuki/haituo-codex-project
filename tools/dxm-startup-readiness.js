#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

const SCHEMA_VERSION = 'dxm_startup_readiness.v1';
const DEFAULT_CDP_HTTP_ENDPOINT = 'http://127.0.0.1:19223';
const DEFAULT_WEBBRIDGE_ENDPOINT = 'http://127.0.0.1:10086/command';
const DEFAULT_WEBBRIDGE_SESSION = 'dxm-startup-readiness';

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseArgs(argv) {
  const args = {
    command: argv[2] || 'help',
    asin: '',
    targetUrl: '',
    cdpHttpEndpoint: process.env.DXM_CDP_HTTP_ENDPOINT || DEFAULT_CDP_HTTP_ENDPOINT,
    webbridgeEndpoint: process.env.WEBBRIDGE_ENDPOINT || DEFAULT_WEBBRIDGE_ENDPOINT,
    webbridgeSession: process.env.WEBBRIDGE_SESSION || DEFAULT_WEBBRIDGE_SESSION,
    timeoutMs: Number(process.env.DXM_STARTUP_READINESS_TIMEOUT_MS || 8000),
  };
  const flagMap = {
    '--asin': 'asin',
    '--target-url': 'targetUrl',
    '--cdp-http-endpoint': 'cdpHttpEndpoint',
    '--webbridge-endpoint': 'webbridgeEndpoint',
    '--webbridge-session': 'webbridgeSession',
    '--timeout-ms': 'timeoutMs',
  };
  for (let i = 3; i < argv.length; i += 1) {
    const flag = argv[i];
    const field = flagMap[flag];
    if (!field) throw new Error(`Unsupported option: ${flag || '<missing>'}`);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) throw new Error(`Missing value for option: ${flag}`);
    args[field] = field === 'timeoutMs' ? Number(next) : next;
    i += 1;
  }
  args.asin = compactText(args.asin).toUpperCase();
  args.targetUrl = compactText(args.targetUrl);
  args.cdpHttpEndpoint = compactText(args.cdpHttpEndpoint);
  args.webbridgeEndpoint = compactText(args.webbridgeEndpoint);
  args.webbridgeSession = compactText(args.webbridgeSession);
  return args;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return {
    tool: 'dxm-startup-readiness',
    commands: {
      probe: 'Readonly probe for an already-open Dianxiaomi target through local CDP and fixed WebBridge evidence.',
    },
    options: {
      '--asin': 'Scoped Amazon ASIN for evidence matching.',
      '--target-url': 'Existing Dianxiaomi target URL to match.',
      '--cdp-http-endpoint': `Local CDP HTTP endpoint. Default ${DEFAULT_CDP_HTTP_ENDPOINT}.`,
      '--webbridge-endpoint': `Local WebBridge endpoint. Default ${DEFAULT_WEBBRIDGE_ENDPOINT}.`,
      '--webbridge-session': `WebBridge session name. Default ${DEFAULT_WEBBRIDGE_SESSION}.`,
      '--timeout-ms': 'HTTP timeout in milliseconds.',
    },
    safety: [
      'Uses only local CDP /json/version and /json/list.',
      'Matches existing Dianxiaomi targets; does not navigate or close tabs.',
      'Uses one fixed readonly WebBridge evaluate payload for page/login evidence.',
      'Does not launch Chrome, automate login, edit fields, save, publish, one-click publish, or expose generic CDP/Playwright execution.',
    ],
    schemaVersion: SCHEMA_VERSION,
  };
}

function isLocalHttpEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function isDianxiaomiUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)dianxiaomi\.com$/i.test(url.hostname);
  } catch (_) {
    return false;
  }
}

function sameUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString().replace(/\/$/, '') === b.toString().replace(/\/$/, '');
  } catch (_) {
    return compactText(left) === compactText(right);
  }
}

function requestJson(method, endpoint, body, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (error) {
      resolve({ ok: false, status: 'invalid_url', error: String(error && error.message ? error.message : error) });
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : '';
    const request = client.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
        : {},
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, data: JSON.parse(text) });
        } catch (error) {
          resolve({ ok: false, status: 'json_parse_failed', statusCode: response.statusCode, raw: text.slice(0, 500), error: String(error && error.message ? error.message : error) });
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => {
      resolve({ ok: false, status: error && error.message === 'timeout' ? 'timeout' : 'request_failed', error: String(error && error.message ? error.message : error) });
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function cdpUrl(base, path) {
  const url = new URL(base);
  return new URL(path, `${url.protocol}//${url.host}`).toString();
}

async function readCdp(cdpHttpEndpoint, timeoutMs) {
  const versionUrl = cdpUrl(cdpHttpEndpoint, '/json/version');
  const listUrl = cdpUrl(cdpHttpEndpoint, '/json/list');
  const version = await requestJson('GET', versionUrl, null, timeoutMs);
  if (!version.ok) {
    return {
      ok: false,
      cdp: {
        ok: false,
        endpoint: cdpHttpEndpoint,
        version_url: versionUrl,
        list_url: listUrl,
        error: version.status || version.error || 'cdp_version_unavailable',
      },
      targets: [],
    };
  }
  const list = await requestJson('GET', listUrl, null, timeoutMs);
  if (!list.ok || !Array.isArray(list.data)) {
    return {
      ok: false,
      cdp: {
        ok: false,
        endpoint: cdpHttpEndpoint,
        version_url: versionUrl,
        list_url: listUrl,
        browser: version.data && version.data.Browser || '',
        protocol_version: version.data && version.data['Protocol-Version'] || '',
        error: list.status || list.error || 'cdp_target_list_unavailable',
      },
      targets: [],
    };
  }
  return {
    ok: true,
    cdp: {
      ok: true,
      endpoint: cdpHttpEndpoint,
      version_url: versionUrl,
      list_url: listUrl,
      browser: version.data.Browser || '',
      protocol_version: version.data['Protocol-Version'] || '',
      web_socket_debugger_url_present: Boolean(version.data.webSocketDebuggerUrl),
    },
    targets: list.data,
  };
}

function normalizeTarget(target) {
  return {
    target_id: target.id || target.targetId || '',
    type: target.type || '',
    title: target.title || '',
    url: target.url || '',
    attached: Boolean(target.attached),
    websocket_present: Boolean(target.webSocketDebuggerUrl),
  };
}

function selectTarget(targets, targetUrl) {
  const dianxiaomiTargets = targets
    .filter((target) => target && target.type === 'page' && isDianxiaomiUrl(target.url || ''))
    .map(normalizeTarget);
  const exact = dianxiaomiTargets.filter((target) => sameUrl(target.url, targetUrl));
  const contained = exact.length ? exact : dianxiaomiTargets.filter((target) => {
    const targetText = compactText(target.url);
    return targetText.includes(targetUrl) || targetUrl.includes(targetText);
  });
  if (!contained.length) {
    return { targets: dianxiaomiTargets, selectedTarget: null, status: 'dxm_startup_probe_no_target', blockers: ['target_not_found'] };
  }
  if (contained.length > 1) {
    return { targets: dianxiaomiTargets, selectedTarget: null, status: 'dxm_startup_probe_ambiguous_target', blockers: ['ambiguous_target'] };
  }
  return { targets: dianxiaomiTargets, selectedTarget: contained[0], status: '', blockers: [] };
}

function fixedPageEvidenceScript(asin) {
  return `(() => {
    const expectedAsin = ${JSON.stringify(asin)};
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const bodyText = norm(document.body && document.body.innerText).slice(0, 2500);
    const lower = bodyText.toLowerCase();
    const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
    const hasLoginText = /登录|扫码|login|sign in/i.test(bodyText);
    const hasDxmMarker = /店小秘|产品|采集|待发布|速卖通|刊登|Dianxiaomi/i.test(bodyText);
    const hasReadonlyPreflight = typeof window.__DXM_AUTOMATION_V1_READONLY_PREFLIGHT__ === 'function';
    return JSON.stringify({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodySnippet: bodyText.slice(0, 1000),
      hasPasswordInput,
      hasLoginText,
      hasDxmMarker,
      hasReadonlyPreflight,
      asinVisible: expectedAsin ? lower.includes(expectedAsin.toLowerCase()) : false
    });
  })()`;
}

function extractWebBridgeValue(payload) {
  const data = payload && payload.data;
  if (!data) return null;
  if (data.value != null) return data.value;
  if (data.data && data.data.value != null) return data.data.value;
  if (data.result && data.result.value != null) return data.result.value;
  if (data.type && data.value != null) return data.value;
  return null;
}

async function readPageEvidence(args, selectedTarget) {
  if (!args.webbridgeEndpoint) {
    return { ok: false, status: 'webbridge_endpoint_missing', page: null, raw: null };
  }
  if (!isLocalHttpEndpoint(args.webbridgeEndpoint)) {
    return { ok: false, status: 'webbridge_non_local_endpoint_rejected', page: null, raw: null };
  }
  const find = await requestJson('POST', args.webbridgeEndpoint, {
    action: 'find_tab',
    args: { url: selectedTarget.url, active: false },
    session: args.webbridgeSession,
  }, args.timeoutMs);
  if (!find.ok) return { ok: false, status: 'webbridge_find_tab_failed', page: null, raw: find };
  const evaluated = await requestJson('POST', args.webbridgeEndpoint, {
    action: 'evaluate',
    args: { code: fixedPageEvidenceScript(args.asin) },
    session: args.webbridgeSession,
  }, args.timeoutMs);
  if (!evaluated.ok) return { ok: false, status: 'webbridge_evaluate_failed', page: null, raw: evaluated };
  try {
    return { ok: true, status: 'ok', page: JSON.parse(extractWebBridgeValue(evaluated) || '{}'), raw: { find, evaluated } };
  } catch (error) {
    return { ok: false, status: 'webbridge_evidence_parse_failed', page: null, raw: evaluated, error: String(error && error.message ? error.message : error) };
  }
}

function loginFromPage(page) {
  if (!page) return { status: 'unknown', confidence: 0, markers: [] };
  const markers = [];
  if (page.hasPasswordInput) markers.push('password_input');
  if (page.hasLoginText) markers.push('login_text');
  if (page.hasDxmMarker) markers.push('dianxiaomi_page_marker');
  if (page.hasPasswordInput || page.hasLoginText) return { status: 'login_required', confidence: 0.86, markers };
  if (page.hasDxmMarker) return { status: 'logged_in', confidence: 0.82, markers };
  return { status: 'unknown', confidence: 0.35, markers };
}

function baseEnvelope(args) {
  return {
    schema_version: SCHEMA_VERSION,
    input: {
      asin: args.asin,
      target_url: args.targetUrl,
      cdp_http_endpoint: args.cdpHttpEndpoint,
      webbridge_endpoint: args.webbridgeEndpoint,
      webbridge_session: args.webbridgeSession,
    },
    cdp: {
      ok: false,
      endpoint: args.cdpHttpEndpoint,
    },
    targets: [],
    selected_target: null,
    page: null,
    login: {
      status: 'unknown',
      confidence: 0,
      markers: [],
    },
    readonly_evidence: {
      target_url_matched: false,
      asin_visible: false,
      has_readonly_preflight: false,
    },
    blockers: [],
    warnings: [],
    evidence_refs: [
      {
        kind: 'script',
        source: 'tools/dxm-startup-readiness.js',
        summary: 'Fixed readonly startup readiness probe',
      },
    ],
  };
}

async function probeStartupReadiness(args) {
  const envelope = baseEnvelope(args);
  if (!args.asin) {
    return { ok: false, status: 'dxm_startup_probe_invalid_scope', ...envelope, blockers: ['asin_missing'] };
  }
  if (!args.targetUrl || !isDianxiaomiUrl(args.targetUrl)) {
    return { ok: false, status: 'dxm_startup_probe_invalid_scope', ...envelope, blockers: ['dianxiaomi_target_url_missing'] };
  }
  if (!isLocalHttpEndpoint(args.cdpHttpEndpoint)) {
    return { ok: false, status: 'dxm_startup_probe_invalid_cdp_endpoint', ...envelope, blockers: ['local_cdp_endpoint_required'] };
  }

  const cdp = await readCdp(args.cdpHttpEndpoint, args.timeoutMs);
  envelope.cdp = cdp.cdp;
  if (!cdp.ok) {
    return { ok: false, status: 'dxm_startup_probe_cdp_unavailable', ...envelope, blockers: ['cdp_unavailable'] };
  }

  const selected = selectTarget(cdp.targets, args.targetUrl);
  envelope.targets = selected.targets;
  envelope.selected_target = selected.selectedTarget;
  if (!selected.selectedTarget) {
    return { ok: false, status: selected.status, ...envelope, blockers: selected.blockers };
  }

  const pageEvidence = await readPageEvidence(args, selected.selectedTarget);
  if (!pageEvidence.ok) {
    return {
      ok: false,
      status: 'dxm_startup_probe_readonly_unavailable',
      ...envelope,
      page: {
        url: selected.selectedTarget.url,
        title: selected.selectedTarget.title,
        source: 'cdp_target_list',
      },
      readonly_evidence: {
        target_url_matched: true,
        asin_visible: false,
        has_readonly_preflight: false,
      },
      blockers: ['readonly_evidence_unavailable'],
      warnings: [pageEvidence.status],
    };
  }

  const login = loginFromPage(pageEvidence.page);
  const readonlyEvidence = {
    target_url_matched: sameUrl(pageEvidence.page.href || selected.selectedTarget.url, args.targetUrl),
    asin_visible: Boolean(pageEvidence.page.asinVisible),
    has_readonly_preflight: Boolean(pageEvidence.page.hasReadonlyPreflight),
  };
  const blockers = [];
  const warnings = [];
  if (login.status === 'login_required') blockers.push('login_required');
  if (!readonlyEvidence.target_url_matched) blockers.push('target_url_mismatch');
  if (!readonlyEvidence.asin_visible) warnings.push('asin_not_visible_in_readonly_probe');
  if (!readonlyEvidence.has_readonly_preflight) warnings.push('readonly_preflight_function_missing');

  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'dxm_startup_probe_login_required' : 'dxm_startup_probe_ready',
    ...envelope,
    page: pageEvidence.page,
    login,
    readonly_evidence: readonlyEvidence,
    blockers,
    warnings,
    evidence_refs: [
      ...envelope.evidence_refs,
      {
        kind: 'cdp',
        source: `${args.cdpHttpEndpoint}/json/list`,
        summary: 'Existing Dianxiaomi targets enumerated through local CDP',
      },
      {
        kind: 'webbridge',
        source: args.webbridgeEndpoint,
        summary: 'Fixed readonly page evidence evaluated through WebBridge',
      },
    ],
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.command === 'help') return output(usage());
    if (args.command !== 'probe') throw new Error(`Unsupported command: ${args.command}`);
    return output(await probeStartupReadiness(args));
  } catch (error) {
    output({ ok: false, status: 'dxm_startup_probe_tool_error', error: String(error && error.message ? error.message : error) });
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  SCHEMA_VERSION,
  parseArgs,
  probeStartupReadiness,
  selectTarget,
  isLocalHttpEndpoint,
  isDianxiaomiUrl,
};
