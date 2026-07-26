// These used to be hardcoded. They're now set once, at activation, via
// configure() — fed by whatever the user enters through src/auth.js's
// connection prompt (or whatever was previously persisted for them).
let CLOUD_URL = null;
let TOKEN = null;
let MIG_ID = null;
let REQUEST_ID = null;

exports.configure = ({ origin, token, migId, requestId }) => {
  CLOUD_URL = origin;
  TOKEN = token;
  MIG_ID = migId;
  REQUEST_ID = requestId;
};

exports.isConfigured = () =>
  Boolean(CLOUD_URL && TOKEN && MIG_ID && REQUEST_ID);

// Fully clears both the configured connection AND the in-memory session
// state (cookie + xsrf token) picked up from a previous set_session() call.
// Without this, switching connections would leave the old server's cookie
// sitting in global.sessionCookie until the next set_session() happened to
// overwrite it.
exports.reset = () => {
  CLOUD_URL = null;
  TOKEN = null;
  MIG_ID = null;
  REQUEST_ID = null;
  global.sessionCookie = null;
  global.xsrfToken = null;
};

function assertConfigured() {
  if (!exports.isConfigured()) {
    throw new Error(
      "connect.cloud: not configured yet — run 'Connect to Cloud' first.",
    );
  }
}

function authHeaders(extra = {}) {
  assertConfigured();
  const headers = {
    Cookie: global.sessionCookie,
    Authorization: `token ${TOKEN}`,
    ...extra,
  };

  // Jupyter Server's default CSRF protection requires the _xsrf cookie's
  // value to also be echoed back as this header on any state-changing
  // request (POST/PUT/DELETE/PATCH). GET requests don't need it, but
  // sending it unconditionally is harmless.
  if (global.xsrfToken) {
    headers["X-XSRFToken"] = global.xsrfToken;
  }

  return headers;
}

function extractXsrfToken(cookieHeader) {
  const match = cookieHeader && cookieHeader.match(/(?:^|;\s*)_xsrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// SET SESSIONS
// Throws on failure — with `.status` (HTTP status code, or "NETWORK" if the
// request itself couldn't be made) and `.message` (the server's own message
// when available) — so the caller can show the user something meaningful
// instead of this failing silently.
exports.set_session = async () => {
  assertConfigured();
  console.log("Setting Up Session");

  let res;
  try {
    res = await fetch(CLOUD_URL + "/notebook/proxy/set-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        migid: MIG_ID,
        requestId: REQUEST_ID,
      }),
    });
  } catch (err) {
    const netErr = new Error(
      "Could not reach the cloud server. Check the URL and your network connection.",
    );
    netErr.status = "NETWORK";
    throw netErr;
  }

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const cookieHeader = setCookie
      .split(/,(?=\s*\w+=)/)
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    global.sessionCookie = cookieHeader;

    const xsrf = extractXsrfToken(cookieHeader);
    if (xsrf) {
      global.xsrfToken = xsrf;
    }
  }

  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    // response wasn't JSON — fall through with data = {}
  }

  if (!res.ok) {
    const err = new Error(
      data.message || `Session setup failed (${res.status})`,
    );
    err.status = res.status;
    throw err;
  }

  console.log("Session Setup OK");
};

// GET VERSION OF THE APP
exports.get_version = async () => {
  try {
    const res = await fetch(CLOUD_URL + "/notebook/api/", {
      method: "GET",
      headers: authHeaders(),
    });

    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const data = await res.json();
      console.log("Application Version:", data.version);
    }
  } catch (err) {
    console.error("Request failed:", err);
  }
};

// ---------------------------------------------------------------------------
// CONTENTS API — used by both the old tree provider and the new FS provider
// ---------------------------------------------------------------------------

// GET metadata + content for a path (file OR directory)
// Jupyter returns { type: 'directory'|'file'|'notebook', format, content, ... }
exports.get_notebook_contents = async (path = "") => {
  return exports.getContents(path);
};

exports.getContents = async (path = "") => {
  const res = await fetch(
    CLOUD_URL + "/notebook/api/contents/" + encodePath(path),
    {
      method: "GET",
      headers: authHeaders(),
    },
  );

  if (res.status === 404) {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Jupyter API error ${res.status} for GET ${path}`);
    err.code = "EIO";
    throw err;
  }

  const content_type = res.headers.get("content-type");
  if (content_type?.includes("application/json")) {
    return res.json();
  }

  const err = new Error("Unexpected response type from server");
  err.code = "EIO";
  throw err;
};

// CREATE / SAVE (PUT) — used for both "create new file/folder" and "save changes"
// body: { type: 'file'|'directory'|'notebook', format?: 'text'|'base64'|'json', content?, path }
exports.putContents = async (path, body) => {
  const res = await fetch(
    CLOUD_URL + "/notebook/api/contents/" + encodePath(path),
    {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = new Error(`Jupyter API error ${res.status} for PUT ${path}`);
    err.code = "EIO";
    throw err;
  }

  return res.json();
};

// DELETE a file or directory
exports.deleteContents = async (path) => {
  const res = await fetch(
    CLOUD_URL + "/notebook/api/contents/" + encodePath(path),
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );

  if (!res.ok && res.status !== 204) {
    const err = new Error(`Jupyter API error ${res.status} for DELETE ${path}`);
    err.code = "EIO";
    throw err;
  }
};

// RENAME / MOVE (PATCH) — Jupyter contents API supports moving by PATCHing
// the OLD path with { path: newPath }
exports.renameContents = async (oldPath, newPath) => {
  const res = await fetch(
    CLOUD_URL + "/notebook/api/contents/" + encodePath(oldPath),
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: newPath }),
    },
  );

  if (!res.ok) {
    const err = new Error(
      `Jupyter API error ${res.status} for PATCH ${oldPath} -> ${newPath}`,
    );
    err.code = "EIO";
    throw err;
  }

  return res.json();
};

// Convenience wrappers kept for backward compatibility with existing commands
exports.createFolder = async (parent, name) => {
  const targetPath = parent ? `${parent}/${name}` : name;
  return exports.putContents(targetPath, {
    type: "directory",
    path: targetPath,
  });
};

exports.createFile = async (parent, name) => {
  const targetPath = parent ? `${parent}/${name}` : name;
  return exports.putContents(targetPath, {
    type: "file",
    format: "text",
    content: "",
    path: targetPath,
  });
};

// ---------------------------------------------------------------------------
// TERMINALS API — real OS shells on the Jupyter server, streamed over
// WebSocket using the terminado protocol (['stdout', data], ['stdin', data],
// ['set_size', rows, cols, height, width]).
// ---------------------------------------------------------------------------

// Lists all terminal sessions currently running on the server — used to
// reattach VS Code terminal tabs to sessions that outlived a disconnect
// (e.g. a long-running job started hours ago, before VS Code reconnected).
exports.listTerminals = async () => {
  const res = await fetch(CLOUD_URL + "/notebook/api/terminals", {
    method: "GET",
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to list terminals: ${res.status}`);
  }

  return res.json();
};

// Create a new terminal session on the server. Returns { name, ... }.
exports.createTerminal = async () => {
  const res = await fetch(CLOUD_URL + "/notebook/api/terminals", {
    method: "POST",
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to create terminal: ${res.status}`);
  }

  return res.json();
};

// Kill a terminal session on the server (frees the pty on the remote host).
exports.deleteTerminal = async (name) => {
  await fetch(
    CLOUD_URL + `/notebook/api/terminals/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
};

// Build the WebSocket URL for a given terminal name. Verify this path
// against your actual proxy — check the browser DevTools Network tab (WS
// filter) while opening a terminal in the Jupyter web UI, and adjust the
// "/notebook/terminals/websocket/" segment if your proxy uses a different
// prefix.
exports.getTerminalWebSocketUrl = (name) => {
  const wsBase = CLOUD_URL.replace(/^http/, "ws");
  return `${wsBase}/notebook/terminals/websocket/${encodeURIComponent(name)}`;
};

// ---------------------------------------------------------------------------
// KERNELS / SESSIONS — cleanup for notebook kernels started through the
// local notebook gateway. VS Code's Jupyter extension starts a NEW kernel
// session every time it (re)connects to a notebook opened through our
// virtual filesystem (it can't verify jupyterfs:// paths are stable across
// reopens, so it can't safely reuse an existing session) — these functions
// let us tidy those up instead of leaving them running forever.
// ---------------------------------------------------------------------------

// Lists all live kernel sessions on the server — same data the browser's
// own "Shut Down All" kernel panel is built from.
exports.listSessions = async () => {
  const res = await fetch(CLOUD_URL + "/notebook/api/sessions", {
    method: "GET",
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to list sessions: ${res.status}`);
  }

  return res.json();
};

// Deleting a session also shuts down its associated kernel — standard
// Jupyter Server cascade behavior, so this is normally all you need.
exports.deleteSession = async (sessionId) => {
  await fetch(
    CLOUD_URL + `/notebook/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
};

// Direct kernel shutdown, for cases where we only have a kernel id (from
// watching the gateway's WebSocket traffic) rather than a session id.
exports.deleteKernel = async (kernelId) => {
  await fetch(
    CLOUD_URL + `/notebook/api/kernels/${encodeURIComponent(kernelId)}`,
    {
      method: "DELETE",
      headers: authHeaders(),
    },
  );
};

// The pty layer needs the same cookie/token used for regular HTTP calls.
exports.getAuthInfo = () => ({
  cookie: global.sessionCookie,
  token: TOKEN,
  xsrfToken: global.xsrfToken,
});

// The local notebook gateway needs the raw origin as a proxy target.
exports.getOrigin = () => CLOUD_URL;

function encodePath(path) {
  // Encode each segment individually so slashes are preserved as separators
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
