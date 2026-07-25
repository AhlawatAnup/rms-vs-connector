// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require("vscode");
const {
  set_session,
  get_version,
  get_notebook_contents,
} = require("./src/connect.cloud.js");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */

function activate(context) {
  console.log(
    'Congratulations, your extension "rms-vs-connector" is now active!',
  );

  const disposable = vscode.commands.registerCommand(
    "rms-vs-connector.registerCloud",
    async function () {
      vscode.window.showInformationMessage("Register to Cloud Requested!");
      await set_session();
      await get_version();
      await get_notebook_contents();
      console.log(" global.sessionCookie : ", global.sessionCookie);
    },
  );

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
