# MAyA — Cloud to VS Code Connector

**M**ulti-user **A**llocation s**y**stem for compute **A**utomation

> _The illusion that hides complexity._
> **The illusion is simplicity. The power is real.**

MAyA brings a remote compute machine straight into VS Code — browse and edit its files like a local folder, open a real shell on it, and run Jupyter notebooks against its actual kernels. No SSH config, no port-forward juggling, no separate browser tab to babysit.

---

## What MAyA does

Once connected, MAyA gives you:

- **A native file explorer** for the remote machine — the same right-click New File/Folder, rename, delete, save-in-place experience as any local folder, backed entirely by the remote server.
- **A real cloud terminal** — an actual shell running on the remote machine, opened as a normal VS Code terminal tab (from the Command Palette, the terminal profile dropdown, or as your default new-terminal profile).
- **Live Jupyter notebook execution** — connect VS Code's own notebook editor to a real kernel running on the remote machine, so `.ipynb` files execute against the actual server, not your laptop.
- **Download to local** — right-click any remote file or folder to save a real copy to your machine.
- **Automatic session recovery** — long-running terminals survive a disconnect; reopening MAyA reattaches to whatever's still running on the server instead of losing track of it.
- **One status bar click** to connect or terminate a session — no need to dig through the Command Palette for routine use.

---

## Requirements

- VS Code 1.85 or later (workspace folder / virtual filesystem APIs).
- A MAyA connection link from your administrator, in the form:
  ```
  http://<host>:<port>/<request_id>/<mig_id>/<token>
  ```
- **Optional, for notebook execution**: the [Jupyter extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter) (Microsoft) installed — MAyA's notebook gateway plugs into it, it isn't a replacement for it.

---

## Getting started

1. Install the extension.
2. Click **MAyA** in the status bar (bottom-left), or run **"Connect to MAyA"** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Paste your connection link when prompted.
4. A folder named **MAyA** appears in your Explorer sidebar — this is the remote machine's filesystem. Browse, open, and edit files exactly as you would locally.

That's it — MAyA remembers your connection for next time, so you won't need to paste the link again unless the session expires or you switch machines.

---

## Working with files

Open the **MAyA** folder in the Explorer like any other:

- Double-click to open — text files, images, PDFs, and notebooks all render using VS Code's normal viewers.
- Right-click for **New File**, **New Folder**, **Rename**, **Delete** — all apply directly to the remote machine.
- Right-click any file or folder → **Download to Local Machine** to save a real copy to your own disk.
- Saving (`Ctrl+S`) writes straight back to the remote server.

---

## Using the cloud terminal

Three ways to open one:

- Command Palette → **"Open MAyA Terminal"**.
- Click the dropdown arrow next to the `+` in the terminal panel → **MAyA Terminal**.
- Set MAyA as your default terminal profile (Command Palette → _Terminal: Select Default Profile_) so a plain **Terminal → New Terminal** opens one directly.

If a terminal was still running on the server the last time you disconnected, MAyA automatically reattaches a VS Code tab to it the next time you connect — you don't lose track of long-running jobs just because you closed your editor. (Note: reattachment resumes the _live_ session going forward; it doesn't replay output that happened while you were away — if you need that, redirect the command's output to a file, or run it inside `tmux`/`screen` on the server.)

---

## Running Jupyter notebooks

VS Code's notebook editor needs to connect to a real kernel to execute cells — MAyA bridges that connection for you:

1. Run **"Start Notebook Gateway"** from the Command Palette.
2. Copy the URL it gives you.
3. Open any `.ipynb` file in the MAyA folder.
4. Click **Select Kernel** (top-right of the notebook) → **Select Another Kernel...** → **Existing Jupyter Server...** → **Enter the URL of the running Jupyter server** → paste the copied URL.
5. Pick a kernel from the list — cells now execute on the real remote machine.

---

## Commands

| Command                       | What it does                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| **Connect to MAyA**           | Establishes (or re-establishes) your session and mounts the remote filesystem.                     |
| **Change MAyA Connection**    | Switches to a different machine — clears the current session and prompts for a new link.           |
| **Terminate Session**         | Ends the current session cleanly and prompts for a new link.                                       |
| **Open MAyA Terminal**        | Opens a real shell on the remote machine as a VS Code terminal.                                    |
| **Start Notebook Gateway**    | Starts the local bridge that lets VS Code's notebook editor connect to remote kernels.             |
| **Download to Local Machine** | (Right-click in Explorer) Saves a file or folder to your local disk.                               |
| **Shut Down All Kernels**     | Stops every running kernel/session on the server — use to clear out accumulated notebook sessions. |
| **Disconnect Workspace**      | Removes the MAyA folder from your Explorer without ending the session.                             |

---

## Known limitations

- **Terminal scrollback isn't replayed** on reattachment — only new output going forward. Use output redirection or `tmux`/`screen` on the server if you need a full history.
- **Notebook kernels aren't shared with the browser** — opening the same notebook in both VS Code and a browser tab starts two independent kernels, since MAyA's virtual filesystem can't be verified by the Jupyter extension as the server's own real path. Use **Shut Down All Kernels** periodically to clear out accumulated sessions if you work this way often.
- The very first time you connect in a completely empty VS Code window, VS Code briefly restarts its extension host (a VS Code platform behavior when a workspace folder is added for the first time) — this is a one-time hiccup per window, not a recurring issue.

---

## Feedback

Found a bug or have a feature request? Use the thumbs-down / feedback option in VS Code, or reach out to your MAyA administrator.

<p align="center">
  <i>Crafted with ❤️ in Chandigarh, India</i><br>
  Telecommunication Research Laboratory · Menthosa Solutions Pvt. Ltd.
</p>
