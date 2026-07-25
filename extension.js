const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  set_session,
  get_version,
  get_notebook_contents,
  createFolder,
  createFile,
} = require("./src/connect.cloud.js");

const JupyterTreeProvider = require("./src/Filesystem/JupyterTreeProvider.js");
const TMP_DIR = path.join(os.tmpdir(), "rms-vs-connector");

/**
 * @param {vscode.ExtensionContext} context
 */

function activate(context) {
  // ACTIVATE THE TREE REPO
  const tree = new JupyterTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("jupyterExplorer", tree),
  );

  // REGISTER OPEN FILE
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.openFile",
      async (item) => {
        const data = await get_notebook_contents(item.path);

        if (data.format === "base64") {
          // Binary file (pdf, png, jpg, zip, etc.) — decode and open via a real viewer
          const buffer = Buffer.from(data.content, "base64");
          const tmpDir = path.join(os.tmpdir(), "rms-vs-connector");
          fs.mkdirSync(tmpDir, { recursive: true });
          const tmpPath = path.join(tmpDir, data.name); // keep original filename/extension
          fs.writeFileSync(tmpPath, buffer);

          const uri = vscode.Uri.file(tmpPath);
          // Let VS Code pick the right viewer based on extension (PDF viewer ext, image preview, etc.)
          await vscode.commands.executeCommand("vscode.open", uri);
          return;
        }

        if (data.type === "notebook") {
          // .ipynb content comes back as a JSON object, not a string
          const doc = await vscode.workspace.openTextDocument({
            language: "json",
            content: JSON.stringify(data.content, null, 2),
          });
          await vscode.window.showTextDocument(doc);
          return;
        }

        // Plain text file
        const doc = await vscode.workspace.openTextDocument({
          language: guessLanguage(data.name), // e.g. based on extension
          content: data.content,
        });
        await vscode.window.showTextDocument(doc);
      },
    ),
  );

  // CREATE FOLDER
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.newFolder",
      async (item) => {
        const name = await vscode.window.showInputBox({
          prompt: "Folder name",
        });

        if (!name) return;

        await createFolder(item.path, name);

        tree.refresh(await get_notebook_contents());
      },
    ),
  );

  // CREATE FILE
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rms-vs-connector.newFile",
      async (item) => {
        const name = await vscode.window.showInputBox({
          prompt: "File name",
        });

        if (!name) return;

        await createFile(item.path, name);

        tree.refresh(await get_notebook_contents());
      },
    ),
  );

  // REGISTER TO CLOUD
  const disposable = vscode.commands.registerCommand(
    "rms-vs-connector.registerCloud",
    async function () {
      vscode.window.showInformationMessage("Register to Cloud Requested!");
      await set_session();
      await get_version();
      const data = await get_notebook_contents();
      console.log(data);
      tree.refresh(data);
    },
  );

  context.subscriptions.push(disposable);
}

function deactivate() {
  try {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
      console.log("rms-vs-connector: cleaned up temp files");
    }
  } catch (err) {
    // Don't let cleanup failure block deactivation
    console.error("rms-vs-connector: failed to clean temp dir", err);
  }
}

function guessLanguage(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".json": "json",
    ".md": "markdown",
    ".txt": "plaintext",
    ".html": "html",
    ".css": "css",
  };
  return map[ext] || "plaintext";
}

module.exports = {
  activate,
  deactivate,
};
