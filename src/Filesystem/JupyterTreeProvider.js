const vscode = require("vscode");
const { get_notebook_contents } = require("../connect.cloud");

class Node extends vscode.TreeItem {
  constructor(item) {
    super(
      item.name,
      item.type === "directory"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.item = item;
    this.path = item.path;

    this.resourceUri = vscode.Uri.file(item.path);

    // GET CONTEXT VALUE
    if (item.type === "directory") this.contextValue = "folder";
    else this.contextValue = "file";

    // GET FILE CONTEXT
    if (item.type === "file") {
      this.command = {
        command: "rms-vs-connector.openFile",
        title: "Open",
        arguments: [item],
      };
    }
  }
}

class JupyterTreeProvider {
  constructor() {
    this.data = [];
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh(data) {
    this.data = data.content;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      return this.data.map((x) => new Node(x));
    }
    const data = await get_notebook_contents(element.path);
    return data.content.map((x) => new Node(x));
  }
}

module.exports = JupyterTreeProvider;
