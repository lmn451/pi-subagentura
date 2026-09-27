"use strict";

const fs = require("node:fs");

const logPath = process.env.SUBAGENTURA_E2E_NETWORK_LOG;
const telemetryLogPath = process.env.SUBAGENTURA_E2E_TELEMETRY_LOG;

function record(entry) {
  if (!logPath) return;
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, timestamp: 0, ...entry })}\n`,
    { mode: 0o600 },
  );
}

const LOOPBACK =
  /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$|^(?:https?:\/\/)?(?:localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i;

/**
 * A UNIX-socket or loopback attempt is not egress. Both are still denied — this
 * suite has no reason to open either — but they are labelled so a future
 * IPC-over-socket failure cannot be misreported as "network denial was invoked".
 */
function scopeOfHost(host) {
  return LOOPBACK.test(String(host)) ? "local" : "egress";
}

const HTTP_METHODS = new Set([
  "node:http.request",
  "node:http.get",
  "node:https.request",
  "node:https.get",
]);

const NET_CONNECT_METHODS = new Set([
  "node:net.connect",
  "node:net.createConnection",
  "node:net.Socket.connect",
  "node:tls.TLSSocket.connect",
]);

const TLS_CONNECT_METHODS = new Set([
  "node:tls.connect",
  "node:tls.createConnection",
]);

function optionsFromUrl(value) {
  let url = value;
  if (typeof value === "string") {
    try {
      url = new URL(value);
    } catch {
      return { host: value };
    }
  }
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const options = {
    ...url,
    protocol: url.protocol,
    hostname,
    path: `${url.pathname || ""}${url.search || ""}`,
    href: url.href,
  };
  if (url.port !== "") options.port = Number(url.port);
  return options;
}

function normalizeHttpOptions(args) {
  const input = args[0];
  if (input instanceof URL || typeof input === "string") {
    const derived = optionsFromUrl(input);
    const explicit =
      args[1] && typeof args[1] === "object" ? args[1] : undefined;
    return explicit ? { ...derived, ...explicit } : derived;
  }
  return input && typeof input === "object" ? input : {};
}

function normalizeNetOptions(args) {
  const input = args[0];
  if (input && typeof input === "object") return input;
  if (typeof input === "string" && !(Number(input) >= 0)) {
    return { path: input };
  }
  const options = { port: input };
  if (typeof args[1] === "string") options.host = args[1];
  return options;
}

function normalizeTlsOptions(args) {
  const options = { ...normalizeNetOptions(args) };
  const explicit =
    args[1] && typeof args[1] === "object"
      ? args[1]
      : args[2] && typeof args[2] === "object"
        ? args[2]
        : undefined;
  return explicit ? Object.assign(options, explicit) : options;
}

function transportFromHttp(args) {
  const options = normalizeHttpOptions(args);
  if (options.socketPath) return { type: "ipc" };
  return {
    type: "host",
    host: options.hostname || options.host || "localhost",
  };
}

function transportFromNet(args) {
  const options = normalizeNetOptions(args);
  if (options.path) return { type: "ipc" };
  return { type: "host", host: options.host || "localhost" };
}

function transportFromTls(args) {
  const options = normalizeTlsOptions(args);
  if (options.socket) return { type: "custom" };
  if (options.path) return { type: "ipc" };
  return { type: "host", host: options.host || "localhost" };
}

function transportFromGeneric(args) {
  const input = args[0];
  if (input instanceof URL) return { type: "host", host: input.hostname };
  if (input && typeof input === "object") {
    if (input.url != null) return transportFromGeneric([input.url]);
    if (input.socketPath || input.path) return { type: "ipc" };
    return {
      type: "host",
      host: input.hostname ?? input.host ?? "outbound connection",
    };
  }
  if (typeof input === "number") {
    return {
      type: "host",
      host: typeof args[1] === "string" ? args[1] : "localhost",
    };
  }

  const text = String(input ?? "");
  try {
    const url = new URL(text);
    if (url.hostname) return { type: "host", host: url.hostname };
  } catch {
    /* not a URL */
  }
  if (text.startsWith("/") || text.startsWith("./")) return { type: "ipc" };
  return { type: "host", host: text };
}

function scopeOf(kind, args) {
  const transport = HTTP_METHODS.has(kind)
    ? transportFromHttp(args)
    : NET_CONNECT_METHODS.has(kind)
      ? transportFromNet(args)
      : TLS_CONNECT_METHODS.has(kind)
        ? transportFromTls(args)
        : transportFromGeneric(args);
  if (transport.type === "ipc") return "local";
  if (transport.type === "custom") return "egress";
  return scopeOfHost(transport.host);
}

function deny(kind, args) {
  let detail;
  try {
    detail = JSON.stringify(args);
  } catch {
    detail = args.map(String).join(", ");
  }
  record({
    kind,
    scope: scopeOf(kind, args),
    detail: detail || "outbound connection",
  });
  throw new Error(`subagentura terminal E2E forbids network access: ${kind}`);
}

// Positive control: proves to assertNoNetwork() that this preload actually
// applied to the process under test. Without it an empty log is ambiguous.
record({ kind: "armed" });

function patchMethods(target, moduleName, names) {
  for (const name of names) {
    if (typeof target?.[name] !== "function") continue;
    target[name] = (...args) => deny(`${moduleName}.${name}`, args);
  }
}

if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    if (
      telemetryLogPath &&
      url === "https://us.i.posthog.com/i/v0/e/" &&
      args[1]?.method === "POST" &&
      typeof args[1]?.body === "string"
    ) {
      fs.appendFileSync(telemetryLogPath, `${args[1].body}\n`, { mode: 0o600 });
      return new Response(null, { status: 200 });
    }
    return deny("fetch", args);
  };
}

if (typeof globalThis.WebSocket === "function") {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: class DeniedWebSocket {
      constructor(...args) {
        deny("WebSocket", args);
      }
    },
  });
}

for (const moduleName of ["node:http", "node:https"]) {
  patchMethods(require(moduleName), moduleName, ["request", "get"]);
}

const http2 = require("node:http2");
patchMethods(http2, "node:http2", ["connect"]);

const net = require("node:net");
patchMethods(net, "node:net", ["connect", "createConnection"]);
patchMethods(net.Socket?.prototype, "node:net.Socket", ["connect"]);

const tls = require("node:tls");
patchMethods(tls, "node:tls", ["connect", "createConnection"]);
patchMethods(tls.TLSSocket?.prototype, "node:tls.TLSSocket", ["connect"]);

const dgram = require("node:dgram");
patchMethods(dgram, "node:dgram", ["createSocket"]);
patchMethods(dgram.Socket?.prototype, "node:dgram.Socket", [
  "bind",
  "connect",
  "send",
]);

const dnsMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
const dns = require("node:dns");
patchMethods(dns, "node:dns", dnsMethods);
patchMethods(dns.promises, "node:dns.promises", dnsMethods);
patchMethods(require("node:dns/promises"), "node:dns/promises", dnsMethods);
