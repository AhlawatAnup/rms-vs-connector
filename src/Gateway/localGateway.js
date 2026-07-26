const http = require("http");
const https = require("https");
const { URL } = require("url");
const { EventEmitter } = require("events");
const { getAuthInfo, getOrigin } = require("../connect.cloud.js");

// Fires 'kernelConnected' with { kernelId, sessionId } whenever a kernel
// WebSocket upgrade is observed — extension.js listens to this to track
// which kernel a currently-open notebook is using, for cleanup on close.
const events = new EventEmitter();

const KERNEL_CHANNEL_RE = /\/api\/kernels\/([^/]+)\/channels/;

// Bridges VS Code's built-in Jupyter extension (which only knows how to send
// a plain ?token=... query param) to a backend that actually requires a
// cookie-based session + XSRF header on every request. This local server:
//   1. Listens on 127.0.0.1 on an OS-assigned free port.
//   2. Forwards every HTTP request AND every WebSocket (kernel channels)
//      to the real server, injecting Cookie / Authorization / X-XSRFToken
//      on the way out — the exact same headers our own authHeaders() adds
//      for file/terminal access.
//   3. The extension points VS Code's "Existing Jupyter Server" picker at
//      this local URL instead of the real one; from VS Code's perspective
//      it's talking to a normal, already-authenticated Jupyter server.
//
// Implemented with Node's built-in http/https modules directly rather than
// the http-proxy package — http-proxy (old, effectively unmaintained)
// produced immediate "socket hang up" / ECONNRESET errors against this
// server's HTTPS endpoint, while plain Node http(s) requests (what fetch()
// uses under the hood, and what the rest of this codebase relies on
// successfully) work fine. Hand-rolling avoids whatever TLS/SNI handling
// gap that older library has.
let server = null;
let port = null;

function isRunning() {
  return Boolean(server && server.listening);
}

function getGatewayUrl() {
  if (!isRunning()) return null;
  // The path here needs to match wherever your proxy exposes the standard
  // Jupyter API — the rest of this codebase consistently uses "/notebook",
  // so that's the default.
  //
  // IMPORTANT: this must be the REAL API token, not a placeholder. VS
  // Code's Jupyter extension remembers whatever token is in this URL and
  // echoes it on every subsequent request against this server, including
  // the kernel-channel WebSocket. Jupyter Server's WebSocket auth path
  // appears to validate this token argument directly (browser WebSocket
  // clients can't set custom headers, so — same reasoning as the _xsrf
  // query param — Jupyter checks it via the URL for WS specifically). A
  // wrong token here can fail WS auth even though REST calls still work,
  // since REST endpoints likely accept the cookie as an alternative.
  const auth = getAuthInfo();
  const token = auth.token || "";
  return `http://127.0.0.1:${port}/notebook/?token=${encodeURIComponent(token)}`;
}

function clientFor(protocol) {
  return protocol === "https:" ? https : http;
}

// Builds the outgoing header set: copy everything the incoming request
// had (preserving whatever VS Code's Jupyter extension sends — Accept,
// Sec-WebSocket-*, etc.), drop Host (let the target set its own), then
// stamp our real auth on top, overriding anything the extension guessed.
function buildForwardHeaders(req, targetUrl) {
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = targetUrl.hostname;

  // VS Code's Jupyter extension sends an Origin referencing our LOCAL
  // gateway (127.0.0.1), not the real server. If the real server (or a WAF
  // in front of it) validates Origin on WebSocket upgrades — standard
  // cross-site-websocket-hijacking protection — a mismatched Origin gets
  // silently dropped rather than cleanly rejected, which looks exactly
  // like an indefinite hang. Rewrite it to the real origin, same as
  // http-proxy's changeOrigin option used to do.
  if (headers.origin) {
    headers.origin = targetUrl.origin;
  }
  if (headers.referer) {
    headers.referer = `${targetUrl.origin}/`;
  }

  const auth = getAuthInfo();
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.token) headers.authorization = `token ${auth.token}`;
  if (auth.xsrfToken) headers["x-xsrftoken"] = auth.xsrfToken;

  return headers;
}

function startGateway() {
  if (isRunning()) {
    return Promise.resolve(getGatewayUrl());
  }

  const target = getOrigin();
  if (!target) {
    return Promise.reject(
      new Error(
        "Not connected — configure a connection before starting the gateway.",
      ),
    );
  }

  server = http.createServer((req, res) => {
    let targetUrl;
    try {
      targetUrl = new URL(req.url, target);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request URL");
      return;
    }

    const client = clientFor(targetUrl.protocol);
    const forwardReq = client.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: buildForwardHeaders(req, targetUrl),
      },
      (forwardRes) => {
        res.writeHead(forwardRes.statusCode, forwardRes.headers);
        forwardRes.pipe(res);
      },
    );

    forwardReq.on("error", (err) => {
      console.error("rms-vs-connector gateway: proxy error", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end(`Gateway proxy error: ${err.message}`);
    });

    req.pipe(forwardReq);
  });

  // Kernel channels (and anything else WebSocket-based) come through here.
  server.on("upgrade", (req, clientSocket, _head) => {
    console.log(`rms-vs-connector gateway: incoming WS upgrade for ${req.url}`);

    const kernelMatch = req.url.match(KERNEL_CHANNEL_RE);
    if (kernelMatch) {
      let sessionId = null;
      try {
        sessionId = new URL(req.url, "http://placeholder").searchParams.get(
          "session_id",
        );
      } catch (err) {
        // ignore — sessionId stays null
      }
      events.emit("kernelConnected", { kernelId: kernelMatch[1], sessionId });
    }

    let targetUrl;
    try {
      targetUrl = new URL(req.url, target);
    } catch (err) {
      clientSocket.destroy();
      return;
    }

    // Jupyter's kernel-channel WebSocket handler checks XSRF via a QUERY
    // PARAMETER, not a header — real browser clients can't set custom
    // headers on a WebSocket handshake at all, so Jupyter Server is written
    // to expect it here instead. We already send it as a header (which
    // covers our own REST calls and apparently the terminal WS handler),
    // but the kernel-channel handler specifically rejects without this.
    const auth = getAuthInfo();
    if (auth.xsrfToken) {
      targetUrl.searchParams.set("_xsrf", auth.xsrfToken);
    }
    // Same idea for the token — overwrite whatever VS Code sent (possibly
    // a stale/bogus cached value from before this fix) with the real one.
    if (auth.token) {
      targetUrl.searchParams.set("token", auth.token);
    }

    const client = clientFor(targetUrl.protocol);
    const forwardReq = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: buildForwardHeaders(req, targetUrl),
    });

    forwardReq.on("upgrade", (forwardRes, forwardSocket, forwardHead) => {
      console.log(
        `rms-vs-connector gateway: WS upgrade succeeded for ${req.url}`,
      );
      const statusLine = `HTTP/1.1 ${forwardRes.statusCode} ${forwardRes.statusMessage || "Switching Protocols"}\r\n`;
      const headerLines = Object.entries(forwardRes.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");

      clientSocket.write(`${statusLine}${headerLines}\r\n\r\n`);

      if (forwardHead && forwardHead.length) {
        forwardSocket.unshift(forwardHead);
      }

      forwardSocket.pipe(clientSocket);
      clientSocket.pipe(forwardSocket);
    });

    // THIS WAS MISSING: if the target responds with an ordinary HTTP
    // response instead of upgrading (e.g. a 403 from a WAF rejecting the
    // request), neither 'upgrade' nor 'error' fires — without this
    // handler, the response sits unconsumed and the client sees an
    // indefinite hang with no error at all, which matches exactly what
    // was being reported.
    forwardReq.on("response", (forwardRes) => {
      let body = "";
      forwardRes.on("data", (chunk) => {
        body += chunk;
      });
      forwardRes.on("end", () => {
        console.error(
          `rms-vs-connector gateway: WS upgrade REJECTED for ${req.url} — target responded ${forwardRes.statusCode} instead of upgrading. Full body below:\n${body}`,
        );
        clientSocket.end(
          `HTTP/1.1 ${forwardRes.statusCode} ${forwardRes.statusMessage || "Upgrade Rejected"}\r\n\r\n`,
        );
      });
    });

    forwardReq.on("error", (err) => {
      console.error("rms-vs-connector gateway: websocket proxy error", err);
      clientSocket.destroy();
    });

    forwardReq.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      console.log(
        `rms-vs-connector gateway: listening on 127.0.0.1:${port}, forwarding to ${target}`,
      );
      resolve(getGatewayUrl());
    });
    server.on("error", (err) => {
      server = null;
      port = null;
      reject(err);
    });
  });
}

function stopGateway() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      port = null;
      resolve();
    });
  });
}

module.exports = {
  startGateway,
  stopGateway,
  isRunning,
  getGatewayUrl,
  events,
};
