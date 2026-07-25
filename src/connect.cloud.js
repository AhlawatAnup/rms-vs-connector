const CLOUD_URL = "http://127.0.0.1:3000";
const TOKEN =
  "382ac7ebf58c8fc0ac8d5a26c534e61bbe49681cb359b7e9bcb36b346e18f336";

function authHeaders(extra = {}) {
  return {
    Cookie: global.sessionCookie,
    Authorization: `token ${TOKEN}`,
    ...extra,
  };
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

function encodePath(path) {
  // Encode each segment individually so slashes are preserved as separators
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
