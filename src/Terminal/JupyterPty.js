const vscode = require("vscode");
const WebSocket = require("ws");

// Implements vscode.Pseudoterminal. VS Code calls open()/close()/
// handleInput()/setDimensions(); we translate those into the terminado
// WebSocket protocol Jupyter's Terminals API speaks:
//   server -> client: ["stdout", data]
//   client -> server: ["stdin", data]
//   client -> server: ["set_size", rows, cols, height_px, width_px]
class JupyterPty {
  constructor(terminalName, wsUrl, authInfo) {
    this.terminalName = terminalName;
    this.wsUrl = wsUrl;
    this.authInfo = authInfo;
    this.ws = null;

    this._writeEmitter = new vscode.EventEmitter();
    this._closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this._writeEmitter.event;
    this.onDidClose = this._closeEmitter.event;
  }

  open(initialDimensions) {
    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        Cookie: this.authInfo.cookie,
        Authorization: `token ${this.authInfo.token}`,
      },
    });

    this.ws.on("open", () => {
      if (initialDimensions) {
        this.setDimensions(initialDimensions);
      }
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }

      const [type, data] = msg;
      if (type === "stdout") {
        this._writeEmitter.fire(data);
      }
      // Other message types (e.g. 'disconnect') are ignored for now.
    });

    this.ws.on("close", () => {
      this._writeEmitter.fire("\r\n\x1b[31m[Terminal disconnected]\x1b[0m\r\n");
      this._closeEmitter.fire();
    });

    this.ws.on("error", (err) => {
      this._writeEmitter.fire(
        `\r\n\x1b[31m[Connection error: ${err.message}]\x1b[0m\r\n`,
      );
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  handleInput(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(["stdin", data]));
    }
  }

  setDimensions(dims) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(["set_size", dims.rows, dims.columns, 0, 0]));
    }
  }
}

module.exports = JupyterPty;
