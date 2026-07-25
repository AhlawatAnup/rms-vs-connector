// The module 'vscode' contains the VS Code extensibility API
const vscode = require("vscode");

const {
  set_session,
  get_version,
  createTerminal,
  deleteTerminal,
  getTerminalWebSocketUrl,
  getAuthInfo,
} = require("./src/connect.cloud.js");
const JupyterFileSystemProvider = require("./src/Filesystem/JupyterFileSystemProvider.js");
const JupyterPty = require("./src/Terminal/JupyterPty.js");

const SCHEME = "jupyterfs";
const PROFILE_ID = "rms-vs-connector.jupyterTerminal";
const ptyToName = new Map(); // JupyterPty instance -> server-side terminal name

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  // Clean up the server-side terminal session whenever the user closes the
  // VS Code terminal tab, so ptys don't pile up on the Jupyter host. This
  // covers terminals opened either via the command or via the profile
  // (dropdown / "New Terminal"), since both end up creating a JupyterPty.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      const pty = terminal.creationOptions && terminal.creationOptions.pty;
      const name = pty && ptyToName.get(pty);
      if (name) {
        ptyToName.delete(pty);
        deleteTerminal(name).catch((err) =>
          console.error(
            `rms-vs-connector: failed to clean up terminal ${name}`,
            err,
          ),
        );
      }
    }),
  );

  // Establish the session FIRST, and fully await it, before the provider is
  // registered. VS Code awaits the promise returned from activate() before
  // it will try to resolve any already-mounted jupyterfs:/ workspace folder
  // (e.g. right after the forced extension-host restart, or on a normal
  // relaunch). If we register the provider before the session exists, VS
  // Code can fire readDirectory() against an unauthenticated cookie, get
  // back an empty/failed response, and cache that empty tree — which is
  // exactly why only a manual refresh (issued after the session is ready)
  // was populating things correctly.
  try {
    await set_session();
    await get_version();
  } catch (err) {
    console.error("rms-vs-connector: failed to establish session", err);
  }

  const provider = new JupyterFileSystemProvider();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
    }),
  );

  // REGISTER TO CLOUD — kept for manual re-trigger / first-time mount.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.registerCloud",
      async () => {
        vscode.window.showInformationMessage("Register to Cloud Requested!");
        await set_session();
        await get_version();
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
            `Could not start a cloud terminal: ${err.message}`,
          );
          return undefined;
        }

        const wsUrl = getTerminalWebSocketUrl(info.name);
        const pty = new JupyterPty(info.name, wsUrl, getAuthInfo());
        ptyToName.set(pty, info.name);

        return new vscode.TerminalProfile({
          name: `Jupyter: ${info.name}`,
          pty,
        });
      },
    }),
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

  // STATUS BAR ENTRY — one-click affordance in the same visual spot as
  // VS Code's built-in remote indicator (bottom-left).
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.text = "$(cloud) Jupyter Cloud";
  statusBarItem.tooltip = "Connect to Jupyter Cloud";
  statusBarItem.command = "rms-vs-connector.registerCloud";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

async function createJupyterTerminal() {
  let info;
  try {
    info = await createTerminal();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not start a cloud terminal: ${err.message}`,
    );
    return undefined;
  }

  const wsUrl = getTerminalWebSocketUrl(info.name);
  const pty = new JupyterPty(info.name, wsUrl, getAuthInfo());
  ptyToName.set(pty, info.name);

  return vscode.window.createTerminal({
    name: `Jupyter: ${info.name}`,
    pty,
  });
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
      name: "Jupyter Cloud",
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

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
