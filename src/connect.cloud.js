const CLOUD_URL = "http://127.0.0.1:3000";
const TOKEN =
  "382ac7ebf58c8fc0ac8d5a26c534e61bbe49681cb359b7e9bcb36b346e18f336";

function authHeaders(extra = {}) {
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
exports.set_session = async () => {
  try {
    console.log("Setting Up Session");
    const res = await fetch(CLOUD_URL + "/notebook/proxy/set-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        migid: "Mig-2",
        requestId: "6a639a430729040d619d58ba",
      }),
    });

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

    const data = await res.json();
    if (res.ok) {
      console.log("Session Setup OK");
    } else {
      console.log(data.message || "Failed to initialize session");
    }
  } catch (err) {
    console.error(err);
  }
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

exports.putContents = async (path, body) => {
  // body: { type: 'file'|'directory'|'notebook', format?: 'text'|'base64'|'json', content?, path }
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

exports.deleteContents = async (path) => {
  // DELETE a file or directory
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

exports.renameContents = async (oldPath, newPath) => {
  // RENAME / MOVE (PATCH) — Jupyter contents API supports moving by PATCHing
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

// The pty layer needs the same cookie/token used for regular HTTP calls.
exports.getAuthInfo = () => ({
  cookie: global.sessionCookie,
  token: TOKEN,
  xsrfToken: global.xsrfToken,
});

function encodePath(path) {
  // Encode each segment individually so slashes are preserved as separators
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
