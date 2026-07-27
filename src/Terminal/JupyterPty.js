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
    console.log(
      `rms-vs-connector: JupyterPty.open() called for terminal "${this.terminalName}"`,
    );
    // Immediate visible feedback — if this line never appears, open() isn't
    // being called at all (a VS Code terminal-lifecycle issue, not a
    // connection issue). If it appears but nothing follows, the WebSocket
    // itself is the problem.
    this._writeEmitter.fire(
      `\x1b[90m[Attaching to ${this.terminalName}...]\x1b[0m\r\n`,
    );

    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        Cookie: this.authInfo.cookie,
        Authorization: `token ${this.authInfo.token}`,
      },
    });

    // If the socket never reaches OPEN (or ERROR/CLOSE) within a
    // reasonable window, surface that visibly instead of leaving the pane
    // silently blank forever — this is exactly the "stuck in CONNECTING"
    // case that would otherwise look identical to nothing happening at all.
    const connectTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        console.warn(
          `rms-vs-connector: JupyterPty WS still CONNECTING after 10s for "${this.terminalName}"`,
        );
        this._writeEmitter.fire(
          `\r\n\x1b[33m[Still trying to connect to ${this.terminalName} after 10s — the connection may be stuck]\x1b[0m\r\n`,
        );
      }
    }, 10000);

    this.ws.on("open", () => {
      clearTimeout(connectTimeout);
      console.log(
        `rms-vs-connector: JupyterPty WS OPEN for terminal "${this.terminalName}"`,
      );
      if (initialDimensions) {
        this.setDimensions(initialDimensions);
      }
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.error(
          `rms-vs-connector: JupyterPty failed to parse message for "${this.terminalName}"`,
          raw.toString(),
        );
        return;
      }

      const [type, data] = msg;
      if (type === "stdout") {
        this._writeEmitter.fire(data);
      } else {
        console.log(
          `rms-vs-connector: JupyterPty received "${type}" message for "${this.terminalName}"`,
        );
      }
    });

    this.ws.on("close", (code, reason) => {
      clearTimeout(connectTimeout);
      console.log(
        `rms-vs-connector: JupyterPty WS CLOSED for "${this.terminalName}" — code=${code} reason=${reason}`,
      );
      this._writeEmitter.fire("\r\n\x1b[31m[Terminal disconnected]\x1b[0m\r\n");
      this._closeEmitter.fire();
    });

    this.ws.on("error", (err) => {
      clearTimeout(connectTimeout);
      console.error(
        `rms-vs-connector: JupyterPty WS ERROR for "${this.terminalName}"`,
        err,
      );
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
    } else {
      const state = this.ws ? this.ws.readyState : "no socket";
      console.warn(
        `rms-vs-connector: JupyterPty dropped input for "${this.terminalName}" — socket not open (readyState=${state})`,
      );
    }
  }

  setDimensions(dims) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(["set_size", dims.rows, dims.columns, 0, 0]));
    }
  }
}

module.exports = JupyterPty;
