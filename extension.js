// The module 'vscode' contains the VS Code extensibility API
const vscode = require("vscode");

const {
  configure,
  isConfigured,
  reset,
  set_session,
  get_version,
  createTerminal,
  deleteTerminal,
  getTerminalWebSocketUrl,
  getAuthInfo,
  listSessions,
  deleteSession,
  deleteKernel,
  listTerminals,
} = require("./src/connect.cloud.js");
const {
  ensureConnection,
  clearConnection,
  connectFromRawUrl,
} = require("./src/auth.js");
const JupyterFileSystemProvider = require("./src/Filesystem/JupyterFileSystemProvider.js");
const JupyterPty = require("./src/Terminal/JupyterPty.js");
const {
  startGateway,
  stopGateway,
  events: gatewayEvents,
} = require("./src/Gateway/localGateway.js");

const SCHEME = "jupyterfs";
const PROFILE_ID = "rms-vs-connector.jupyterTerminal";
const JUPYTER_TERMINAL_NAME_RE = /^MAyA: (.+)$/;

// Two status bar items that toggle visibility based on whether a session is
// actually active (not just "configured" — configure() can be called before
// set_session() has actually succeeded). connectStatusBarItem is shown when
// disconnected; terminateStatusBarItem (red) is shown once a session is
// live, and runs terminateSession on click.
let connectStatusBarItem;
let terminateStatusBarItem;
let sessionActive = false;

// Tracks which kernel a given notebook is using, so we can shut that kernel
// down automatically when the notebook is closed. Keyed by notebook URI
// string. Populated via a heuristic: whenever the gateway observes a new
// kernel WebSocket connect, we assume it belongs to whichever notebook is
// currently the active editor — reliable for the common case of working
// with one notebook at a time, less so with several open simultaneously.
const kernelByNotebook = new Map();

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  // Create the status bar items FIRST — handleSessionError (which can fire
  // during the very first session check below) touches these, so they must
  // exist before anything that might call it.
  connectStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  connectStatusBarItem.text = "$(cloud) MAyA";
  connectStatusBarItem.tooltip = "Connect to MAyA";
  connectStatusBarItem.command = "rms-vs-connector.registerCloud";
  context.subscriptions.push(connectStatusBarItem);

  terminateStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  terminateStatusBarItem.text = "$(circle-slash) Terminate Session";
  terminateStatusBarItem.tooltip = "End the current MAyA session";
  terminateStatusBarItem.command = "rms-vs-connector.terminateSession";
  // VS Code's built-in error colors — the same red used for problem/error
  // indicators elsewhere in the status bar, so it reads as "this ends
  // something" without needing a custom color.
  terminateStatusBarItem.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.errorBackground",
  );
  terminateStatusBarItem.color = new vscode.ThemeColor(
    "statusBarItem.errorForeground",
  );
  context.subscriptions.push(terminateStatusBarItem);

  refreshStatusBar(); // starts in the "disconnected" state

  // DEEP LINK HANDLER — lets a button on the MAyA web platform open VS
  // Code and connect automatically, via a link like:
  //   vscode://<publisher>.<extension-name>/connect?maya_url=<encoded-url>
  // VS Code only routes here if this extension is installed; if it isn't,
  // VS Code's own core shows an install prompt automatically, and if VS
  // Code itself isn't installed, the browser just does nothing with an
  // unregistered custom scheme — no extra detection code needed for either
  // of those cases.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => handleIncomingUri(uri, context),
    }),
  );

  // Clean up the server-side terminal session whenever the user closes the
  // VS Code terminal tab, so ptys don't pile up on the Jupyter host. This
  // covers terminals opened either via the command or via the profile
  // (dropdown / "New Terminal"), since both name the terminal "Jupyter: <id>".
  //
  // Matched by name rather than by comparing terminal.creationOptions.pty
  // object identity — terminals created via a TerminalProfile can go
  // through extra serialization that breaks reference equality, which
  // would silently skip cleanup entirely.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      const match = terminal.name.match(JUPYTER_TERMINAL_NAME_RE);
      if (!match) return;

      const name = match[1];
      console.log(
        `rms-vs-connector: terminal "${terminal.name}" closed, deleting server session ${name}`,
      );

      deleteTerminal(name)
        .then(() =>
          console.log(`rms-vs-connector: deleted server terminal ${name}`),
        )
        .catch((err) =>
          console.error(
            `rms-vs-connector: failed to clean up terminal ${name}`,
            err,
          ),
        );
    }),
  );

  // Track which kernel belongs to which notebook — see kernelByNotebook's
  // comment above for the heuristic. This listener just records the
  // association; actual cleanup happens in onDidCloseNotebookDocument below.
  const kernelConnectedListener = ({ kernelId }) => {
    const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
    if (!activeNotebook) return;

    const uriKey = activeNotebook.uri.toString();
    console.log(
      `rms-vs-connector: kernel ${kernelId} associated with notebook ${uriKey}`,
    );
    kernelByNotebook.set(uriKey, kernelId);
  };
  gatewayEvents.on("kernelConnected", kernelConnectedListener);
  context.subscriptions.push(
    new vscode.Disposable(() =>
      gatewayEvents.off("kernelConnected", kernelConnectedListener),
    ),
  );

  // Shut down the kernel a notebook was using the moment its tab closes —
  // this is what actually solves the "orphaned kernel" garbage buildup,
  // since VS Code's Jupyter extension has no built-in equivalent for
  // notebooks opened through a virtual filesystem like ours.
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      const uriKey = notebook.uri.toString();
      const kernelId = kernelByNotebook.get(uriKey);
      if (!kernelId) return;

      kernelByNotebook.delete(uriKey);
      console.log(
        `rms-vs-connector: notebook ${uriKey} closed, shutting down kernel ${kernelId}`,
      );

      deleteKernel(kernelId)
        .then(() =>
          console.log(`rms-vs-connector: shut down kernel ${kernelId}`),
        )
        .catch((err) =>
          console.error(
            `rms-vs-connector: failed to shut down kernel ${kernelId}`,
            err,
          ),
        );
    }),
  );

  // Resolve the cloud connection FIRST — from storage if this user has
  // connected before, otherwise via the input box prompt. Everything else
  // (session setup, the FS provider, terminals) depends on connect.cloud.js
  // being configured, so this has to happen before anything tries to use it.
  const connection = await ensureConnection(context);
  if (!connection) {
    vscode.window.showWarningMessage(
      "MAyA: no connection configured. Run 'Connect to MAyA' from the Command Palette when you're ready.",
    );
  } else {
    configure(connection);
  }

  // Establish the session FIRST, and fully await it, before the provider is
  // registered. VS Code awaits the promise returned from activate() before
  // it will try to resolve any already-mounted jupyterfs:/ workspace folder
  // (e.g. right after the forced extension-host restart, or on a normal
  // relaunch). If we register the provider before the session exists, VS
  // Code can fire readDirectory() against an unauthenticated cookie, get
  // back an empty/failed response, and cache that empty tree — which is
  // exactly why only a manual refresh (issued after the session is ready)
  // was populating things correctly.
  if (isConfigured()) {
    try {
      await set_session();
      await get_version();
      sessionActive = true;
      refreshStatusBar();
      await restoreExistingTerminals();
    } catch (err) {
      await handleSessionError(context, err);
    }
  }

  const provider = new JupyterFileSystemProvider();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
    }),
  );

  // REGISTER TO CLOUD — sets up the session (prompting for a connection URL
  // first, if none is configured yet), then mounts the FS.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.registerCloud",
      async () => {
        if (!isConfigured()) {
          const conn = await ensureConnection(context, { forcePrompt: true });
          if (!conn) return; // user cancelled the prompt
          configure(conn);
        }

        try {
          await set_session();
          await get_version();
        } catch (err) {
          await handleSessionError(context, err);
          return;
        }

        sessionActive = true;
        refreshStatusBar();

        vscode.window.showInformationMessage("Connected to MAyA.");

        // If no workspace folder exists yet at all, mountWorkspace() below
        // is about to trigger VS Code's forced extension-host restart
        // (its documented behavior the very first time a folder is added
        // to an empty window). That restart tears down this entire
        // process — including any terminal WebSocket connections we just
        // opened — leaving dead, unresponsive terminal tabs behind even
        // though "WS OPEN" appeared to succeed moments before. So: skip
        // restoration in THIS doomed pass entirely, and let the next
        // (post-restart, now-stable) activation's own initial-connection
        // check restore terminals cleanly instead.
        const aboutToRestart =
          (vscode.workspace.workspaceFolders || []).length === 0;
        if (!aboutToRestart) {
          await restoreExistingTerminals();
        }

        mountWorkspace();
        // Safety net: if the folder was already mounted from a previous
        // session and VS Code cached an empty/stale tree, force it to
        // re-query now that the session is confirmed fresh — so the user
        // never has to click the manual refresh button themselves.
        await vscode.commands.executeCommand(
          "workbench.files.action.refreshFilesExplorer",
        );
      },
    ),
  );

  // CHANGE CONNECTION — full teardown of the current session, then
  // re-prompts for a new URL and reconnects. Use this to switch to a
  // different cloud machine.
  context.subscriptions.push(
    vscode.commands.registerCommand("rms-vs-connector.changeConnection", () =>
      terminateAndReconnect(context, {
        successMessage: "Connected to new MAyA machine.",
      }),
    ),
  );

  // TERMINATE SESSION — clears the server-side session state we're holding
  // (cookie + xsrf token), clears the persisted connection (globalState +
  // SecretStorage), unmounts the workspace folder so stale content isn't
  // left showing, then immediately prompts for a new URL. If the user
  // cancels that prompt, the extension is left fully disconnected rather
  // than silently falling back to the old session.
  context.subscriptions.push(
    vscode.commands.registerCommand("rms-vs-connector.terminateSession", () =>
      terminateAndReconnect(context, {
        successMessage: "Session terminated and reconnected.",
      }),
    ),
  );

  // Optional: explicit unmount command
  context.subscriptions.push(
    vscode.commands.registerCommand("rms-vs-connector.unmount", () => {
      unmountWorkspace();
    }),
  );

  // OPEN CLOUD TERMINAL — spins up a real shell on the Jupyter server and
  // streams it into a VS Code terminal panel via a Pseudoterminal.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.openTerminal",
      async () => {
        const terminal = await createJupyterTerminal();
        if (terminal) terminal.show();
      },
    ),
  );

  // TERMINAL PROFILE — makes the Jupyter terminal selectable from the
  // dropdown arrow next to "+" in the terminal panel, from
  // "Terminal: Select Default Profile", and (if set as default) from a
  // plain Terminal > New Terminal menu-bar click — no command required.
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
      provideTerminalProfile: async () => {
        let info;
        try {
          info = await createTerminal();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Could not start a MAyA terminal: ${err.message}`,
          );
          return undefined;
        }

        const wsUrl = getTerminalWebSocketUrl(info.name);
        const pty = new JupyterPty(info.name, wsUrl, getAuthInfo());

        return new vscode.TerminalProfile({
          name: `MAyA: ${info.name}`,
          pty,
        });
      },
    }),
  );

  // START NOTEBOOK GATEWAY — spins up a local proxy (127.0.0.1) that
  // injects the cookie/xsrf/token auth on every request AND every kernel
  // WebSocket, so VS Code's built-in Jupyter extension can connect via its
  // normal "Existing Jupyter Server" flow without ever needing to know
  // about the cookie-based session handshake our backend requires.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.startNotebookGateway",
      async () => {
        if (!isConfigured()) {
          vscode.window.showWarningMessage(
            "Connect to MAyA first, then start the notebook gateway.",
          );
          return;
        }

        let url;
        try {
          url = await startGateway();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Could not start the notebook gateway: ${err.message}`,
          );
          return;
        }

        const choice = await vscode.window.showInformationMessage(
          `Notebook gateway running. Paste this URL into "Existing Jupyter Server": ${url}`,
          "Copy URL",
        );
        if (choice === "Copy URL") {
          await vscode.env.clipboard.writeText(url);
        }
      },
    ),
  );

  // SHUT DOWN ALL KERNELS — manual safety net for anything the automatic
  // per-notebook cleanup missed (crashes, force-quit, etc). Kills EVERY
  // running session on the server, same as the browser's own "Shut Down
  // All" button — this is not selective, so warn clearly before doing it.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.shutDownAllKernels",
      async () => {
        if (!isConfigured()) {
          vscode.window.showWarningMessage("Connect to MAyA first.");
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          "This will shut down EVERY running kernel/session on the server — including any active in the browser or used by other people. Continue?",
          { modal: true },
          "Shut Down All",
        );
        if (confirm !== "Shut Down All") return;

        let sessions;
        try {
          sessions = await listSessions();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Could not list sessions: ${err.message}`,
          );
          return;
        }

        const results = await Promise.allSettled(
          sessions.map((s) => deleteSession(s.id)),
        );
        const failures = results.filter((r) => r.status === "rejected").length;

        kernelByNotebook.clear();

        if (failures > 0) {
          vscode.window.showWarningMessage(
            `Shut down ${sessions.length - failures} of ${sessions.length} sessions (${failures} failed).`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Shut down ${sessions.length} session(s).`,
          );
        }
      },
    ),
  );

  // DOWNLOAD TO LOCAL — right-click a file or folder in Explorer to save a
  // real copy to disk. Works for both because it reuses the provider's own
  // readFile/readDirectory through vscode.workspace.fs, so all the
  // base64/text/notebook decoding logic stays in one place.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.downloadFile",
      async (uri) => {
        // Fall back to the active editor's file if invoked from the
        // Command Palette instead of a right-click (uri will be undefined).
        uri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          vscode.window.showWarningMessage("No file selected to download.");
          return;
        }

        let stat;
        try {
          stat = await vscode.workspace.fs.stat(uri);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Could not read "${uri.path}": ${err.message}`,
          );
          return;
        }

        if (stat.type === vscode.FileType.Directory) {
          await downloadFolder(uri);
        } else {
          await downloadFile(uri);
        }
      },
    ),
  );
}

// Shows exactly one of the two status bar items, based on whether a
// session is actually active — not just "configured" (configure() runs
// before set_session() has confirmed it actually succeeded).
function refreshStatusBar() {
  if (sessionActive) {
    connectStatusBarItem.hide();
    terminateStatusBarItem.show();
  } else {
    terminateStatusBarItem.hide();
    connectStatusBarItem.show();
  }
}

// Full teardown of the current session (in-memory cookie/xsrf +
// connect.cloud's configured creds, via reset()), the persisted connection
// (globalState + SecretStorage, via clearConnection()), and the mounted
// workspace folder — then immediately re-prompts for a new connection URL.
// Shared by both "Change Cloud Connection" and "Terminate Session", which
// are the same operation under two names.
// Handles a vscode://<publisher>.<name>/connect?maya_url=<encoded> deep
// link — connects directly using the supplied URL, with no input box.
async function handleIncomingUri(uri, context) {
  const params = new URLSearchParams(uri.query);
  const mayaUrl = params.get("maya_url");

  if (!mayaUrl) {
    vscode.window.showWarningMessage(
      "MAyA: this link is missing a connection URL (expected a maya_url parameter).",
    );
    return;
  }

  let connection;
  try {
    connection = await connectFromRawUrl(context, mayaUrl);
  } catch (err) {
    vscode.window.showErrorMessage(
      `MAyA: invalid connection link — ${err.message}`,
    );
    return;
  }

  configure(connection);

  try {
    await set_session();
    await get_version();
  } catch (err) {
    await handleSessionError(context, err);
    return;
  }

  sessionActive = true;
  refreshStatusBar();

  const aboutToRestart = (vscode.workspace.workspaceFolders || []).length === 0;
  if (!aboutToRestart) {
    await restoreExistingTerminals();
  }

  mountWorkspace();
  await vscode.commands.executeCommand(
    "workbench.files.action.refreshFilesExplorer",
  );
  vscode.window.showInformationMessage("Connected to MAyA via link.");
}

async function terminateAndReconnect(
  context,
  { successMessage, isAutoRecovery = false },
) {
  reset();
  sessionActive = false;
  refreshStatusBar();
  await clearConnection(context);
  unmountWorkspace();

  const conn = await ensureConnection(context, { forcePrompt: true });
  if (!conn) {
    // User cancelled — leave things fully disconnected rather than
    // reconnecting to whatever was there before.
    vscode.window.showInformationMessage(
      "Disconnected. Run 'Connect to MAyA' when you're ready to reconnect.",
    );
    return;
  }

  configure(conn);

  try {
    await set_session();
    await get_version();
  } catch (err) {
    if (isAutoRecovery) {
      // We got here BECAUSE a previous session failed and auto-reset.
      // If the freshly-entered link ALSO fails, don't loop back into
      // handleSessionError again — just report it plainly and stop.
      console.error(
        "rms-vs-connector: auto-recovery reconnect also failed",
        err,
      );
      vscode.window.showErrorMessage(
        `Still couldn't connect with the new link: ${err.message || err}`,
      );
      return;
    }
    await handleSessionError(context, err);
    return;
  }

  sessionActive = true;
  refreshStatusBar();

  // Same guard as registerCloud. Note: this path always unmounts the
  // workspace folder earlier in this function (see unmountWorkspace()
  // above), so workspaceFolders will always be empty here — meaning
  // mountWorkspace() below will always trigger a restart for this
  // particular flow, and terminal restoration will always be deferred to
  // the next (post-restart) activation. That's expected and fine.
  const aboutToRestart = (vscode.workspace.workspaceFolders || []).length === 0;
  if (!aboutToRestart) {
    await restoreExistingTerminals();
  }

  mountWorkspace();
  await vscode.commands.executeCommand(
    "workbench.files.action.refreshFilesExplorer",
  );
  vscode.window.showInformationMessage(successMessage);
}

// Maps set_session() failures to what should happen next. Pure network
// errors (server unreachable) don't touch the saved connection — the
// credentials are probably still fine, it's just a connectivity blip.
// Everything else (expired session, invalid/unverified request, wrong
// machine, etc.) means the saved link itself is no longer usable, so we
// automatically wipe it and walk straight into the "enter a new link"
// prompt — no button to click, no way to get stuck on a dead connection
// with no path forward.
async function handleSessionError(context, err) {
  console.error("rms-vs-connector: session setup failed", err);

  sessionActive = false;
  refreshStatusBar();

  if (err.status === "NETWORK") {
    vscode.window.showErrorMessage(err.message);
    return;
  }

  let reason;
  switch (err.status) {
    case 400:
      reason = "Connection details are incomplete or malformed.";
      break;
    case 403:
      reason = "Session expired or this connection is no longer verified.";
      break;
    case 404:
      reason = "No such machine found for this connection.";
      break;
    default:
      reason = err.message || "Failed to set up the cloud session.";
  }

  vscode.window.showWarningMessage(
    `${reason} Clearing the saved connection — enter a new link to reconnect.`,
  );

  await terminateAndReconnect(context, {
    successMessage: "Reconnected with new credentials.",
    isAutoRecovery: true,
  });
}

async function createJupyterTerminal() {
  let info;
  try {
    info = await createTerminal();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not start a MAyA terminal: ${err.message}`,
    );
    return undefined;
  }

  return attachToTerminal(info.name);
}

// Opens a VS Code terminal tab wired to an ALREADY-EXISTING server-side
// terminal session, rather than creating a new one — used both by
// createJupyterTerminal (right after it creates one) and by
// restoreExistingTerminals (for sessions that already existed before this
// activation, e.g. a long-running job left over from hours ago).
function attachToTerminal(name) {
  const wsUrl = getTerminalWebSocketUrl(name);
  const pty = new JupyterPty(name, wsUrl, getAuthInfo());

  return vscode.window.createTerminal({
    name: `MAyA: ${name}`,
    pty,
  });
}

// Finds terminal sessions already running on the server (e.g. one left
// over from before a disconnect) and opens a VS Code terminal tab for each
// one that isn't already represented in this window — so reconnecting
// doesn't strand a long-running job with no visible terminal.
async function restoreExistingTerminals() {
  let sessions;
  try {
    sessions = await listTerminals();
  } catch (err) {
    console.error("rms-vs-connector: failed to list existing terminals", err);
    return;
  }

  if (!sessions || sessions.length === 0) return;

  const alreadyOpen = new Set(
    vscode.window.terminals
      .map((t) => t.name.match(JUPYTER_TERMINAL_NAME_RE))
      .filter(Boolean)
      .map((match) => match[1]),
  );

  let restoredCount = 0;
  let lastRestored = null;
  for (const session of sessions) {
    if (alreadyOpen.has(session.name)) continue;
    lastRestored = attachToTerminal(session.name);
    restoredCount++;
  }

  if (restoredCount > 0) {
    // Without this, reattached terminals sit created-but-inert in the
    // terminal dropdown — nothing wrong with them, but if the user is
    // looking at whatever terminal panel was already open (not specifically
    // one of these), it looks exactly like "nothing happened."
    lastRestored.show();

    vscode.window.showInformationMessage(
      `Reattached ${restoredCount} existing MAyA terminal${restoredCount === 1 ? "" : "s"} still running on the server. Check the terminal dropdown (▾ next to +) for entries starting with "MAyA:" if you had more than one.`,
    );
  }
}

async function downloadFile(uri) {
  const name = uri.path.split("/").filter(Boolean).pop() || "download";

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(name),
    saveLabel: "Download",
  });
  if (!saveUri) return; // user cancelled

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${name}...`,
      },
      async () => {
        const data = await vscode.workspace.fs.readFile(uri);
        await vscode.workspace.fs.writeFile(saveUri, data);
      },
    );
    vscode.window.showInformationMessage(`Downloaded ${name}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
  }
}

async function downloadFolder(uri) {
  const name = uri.path.split("/").filter(Boolean).pop() || "download";

  const targets = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Download Into",
  });
  if (!targets || targets.length === 0) return; // user cancelled

  const destRoot = vscode.Uri.joinPath(targets[0], name);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading "${name}"...`,
        cancellable: false,
      },
      async (progress) => {
        await copyDirRecursive(uri, destRoot, progress);
      },
    );
    vscode.window.showInformationMessage(`Downloaded folder "${name}"`);
  } catch (err) {
    vscode.window.showErrorMessage(`Folder download failed: ${err.message}`);
  }
}

async function copyDirRecursive(srcUri, destUri, progress) {
  await vscode.workspace.fs.createDirectory(destUri);
  const entries = await vscode.workspace.fs.readDirectory(srcUri);

  for (const [entryName, type] of entries) {
    const childSrc = vscode.Uri.joinPath(srcUri, entryName);
    const childDest = vscode.Uri.joinPath(destUri, entryName);

    if (type === vscode.FileType.Directory) {
      await copyDirRecursive(childSrc, childDest, progress);
    } else {
      progress.report({ message: entryName });
      const data = await vscode.workspace.fs.readFile(childSrc);
      await vscode.workspace.fs.writeFile(childDest, data);
    }
  }
}

function mountWorkspace() {
  const rootUri = vscode.Uri.parse(`${SCHEME}:/`);

  const existingFolders = vscode.workspace.workspaceFolders || [];
  const alreadyMounted = existingFolders.some((f) => f.uri.scheme === SCHEME);
  if (alreadyMounted) {
    console.log(
      "rms-vs-connector: jupyterfs folder already mounted",
      existingFolders,
    );
    return;
  }

  const ok = vscode.workspace.updateWorkspaceFolders(
    existingFolders.length,
    0,
    {
      uri: rootUri,
      name: "MAyA",
    },
  );

  console.log(
    "rms-vs-connector: updateWorkspaceFolders returned",
    ok,
    "workspaceFolders now:",
    vscode.workspace.workspaceFolders,
  );
}

function unmountWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  const index = folders.findIndex((f) => f.uri.scheme === SCHEME);
  if (index !== -1) {
    vscode.workspace.updateWorkspaceFolders(index, 1);
  }
}

function deactivate() {
  return stopGateway();
}

module.exports = {
  activate,
  deactivate,
};
