const vscode = require("vscode");
const {
  getContents,
  putContents,
  deleteContents,
  renameContents,
} = require("../connect.cloud");

// Extensions that must round-trip as base64, everything else is treated as text.
// Extend this list to match whatever binary formats your users work with.
const BINARY_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "ico",
  "zip",
  "gz",
  "tar",
  "7z",
  "rar",
  "exe",
  "dll",
  "so",
  "bin",
  "xlsx",
  "docx",
  "pptx",
  "mp3",
  "mp4",
  "wav",
  "avi",
  "mov",
  "ttf",
  "woff",
  "woff2",
]);

function extOf(path) {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i + 1).toLowerCase();
}

function isBinary(path) {
  return BINARY_EXTENSIONS.has(extOf(path));
}

function isNotebook(path) {
  return extOf(path) === "ipynb";
}

// Strip any leading slash — VS Code URIs are absolute ("/foo/bar"),
// the Jupyter contents API uses paths relative to root ("foo/bar").
function toServerPath(uri) {
  return uri.path.replace(/^\/+/, "");
}

class JupyterFileSystemProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
    // Simple in-memory cache so consecutive stat() calls for the same
    // directory listing don't all hit the network. Cleared on any write.
    this._dirCache = new Map();
  }

  // ---- required no-op/simple members -------------------------------------

  watch(_uri, _options) {
    // The Jupyter REST API has no push notifications, so there is nothing
    // to actually watch. Returning a disposable satisfies the interface.
    // If you need live updates across clients, poll here and fire
    // this._emitter.fire([...]) on changes.
    return new vscode.Disposable(() => {});
  }

  // ---- stat / directory listing -------------------------------------------

  async stat(uri) {
    const serverPath = toServerPath(uri);

    if (serverPath === "") {
      // Root of the mounted filesystem
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
    }

    let data;
    try {
      data = await getContents(serverPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw err;
    }

    return this._toFileStat(data);
  }

  _toFileStat(data) {
    const type =
      data.type === "directory"
        ? vscode.FileType.Directory
        : vscode.FileType.File;

    return {
      type,
      ctime: data.created ? Date.parse(data.created) : 0,
      mtime: data.last_modified ? Date.parse(data.last_modified) : Date.now(),
      size: data.size || 0,
    };
  }

  async readDirectory(uri) {
    const serverPath = toServerPath(uri);
    let data;
    try {
      data = await getContents(serverPath);
    } catch (err) {
      console.error(
        `rms-vs-connector: readDirectory("${serverPath}") failed`,
        err,
      );
      vscode.window.showErrorMessage(
        `Jupyter FS: failed to list "${serverPath || "/"}" — ${err.message}`,
      );
      if (err.code === "ENOENT") {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.Unavailable(uri);
    }

    if (data.type !== "directory") {
      throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    const entries = data.content.map((item) => [
      item.name,
      item.type === "directory"
        ? vscode.FileType.Directory
        : vscode.FileType.File,
    ]);

    console.log(`readDirectory("${serverPath || "/"}") ->`, entries);

    this._dirCache.set(serverPath, entries);
    return entries;
  }

  // ---- read / write --------------------------------------------------------

  async readFile(uri) {
    const serverPath = toServerPath(uri);
    let data;
    try {
      data = await getContents(serverPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw err;
    }

    if (data.type === "directory") {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    if (data.format === "base64") {
      return Buffer.from(data.content, "base64");
    }

    if (data.type === "notebook") {
      // content comes back as a parsed JSON object per nbformat
      return Buffer.from(JSON.stringify(data.content, null, 1), "utf8");
    }

    // format === 'text'
    return Buffer.from(data.content ?? "", "utf8");
  }

  async writeFile(uri, content, options) {
    const serverPath = toServerPath(uri);

    // Check existence to honor create/overwrite semantics.
    let exists = true;
    try {
      await getContents(serverPath);
    } catch (err) {
      if (err.code === "ENOENT") {
        exists = false;
      } else {
        throw err;
      }
    }

    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (exists && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    const buffer = Buffer.from(content);

    let body;
    if (isNotebook(serverPath)) {
      const text = buffer.toString("utf8").trim();
      let notebookContent;

      if (!text) {
        // Brand-new, still-empty .ipynb (e.g. Explorer > New File writes a
        // 0-byte file before any real content exists). There's nothing to
        // parse yet — substitute a minimal valid nbformat skeleton instead
        // of calling JSON.parse on an empty string, which throws exactly
        // "Unexpected end of JSON input".
        notebookContent = {
          cells: [],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        };
      } else {
        try {
          notebookContent = JSON.parse(text);
        } catch (err) {
          throw vscode.FileSystemError.Unavailable(
            `Invalid notebook JSON in ${serverPath}: ${err.message}`,
          );
        }
      }

      body = {
        type: "notebook",
        format: "json",
        content: notebookContent,
        path: serverPath,
      };
    } else if (isBinary(serverPath)) {
      body = {
        type: "file",
        format: "base64",
        content: buffer.toString("base64"),
        path: serverPath,
      };
    } else {
      body = {
        type: "file",
        format: "text",
        content: buffer.toString("utf8"),
        path: serverPath,
      };
    }

    await putContents(serverPath, body);
    this._invalidateParent(serverPath);

    this._emitter.fire([
      {
        type: exists
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }

  // ---- create / delete / rename ---------------------------------------------

  async createDirectory(uri) {
    const serverPath = toServerPath(uri);
    await putContents(serverPath, {
      type: "directory",
      path: serverPath,
    });
    this._invalidateParent(serverPath);
    this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri, _options) {
    const serverPath = toServerPath(uri);
    await deleteContents(serverPath);
    this._invalidateParent(serverPath);
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri, newUri, options) {
    const oldPath = toServerPath(oldUri);
    const newPath = toServerPath(newUri);

    if (!options.overwrite) {
      try {
        await getContents(newPath);
        // it exists and overwrite=false
        throw vscode.FileSystemError.FileExists(newUri);
      } catch (err) {
        if (err.code !== "ENOENT" && !(err instanceof vscode.FileSystemError)) {
          throw err;
        }
        if (err instanceof vscode.FileSystemError) throw err;
        // ENOENT is what we want — target doesn't exist, proceed
      }
    }

    await renameContents(oldPath, newPath);
    this._invalidateParent(oldPath);
    this._invalidateParent(newPath);

    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  _invalidateParent(serverPath) {
    const parent = serverPath.includes("/")
      ? serverPath.slice(0, serverPath.lastIndexOf("/"))
      : "";
    this._dirCache.delete(parent);
  }
}

module.exports = JupyterFileSystemProvider;
