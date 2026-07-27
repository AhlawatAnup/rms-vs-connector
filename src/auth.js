const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const SECRET_TOKEN_KEY = "rmsVsConnector.token";
const SECRET_REQUEST_ID_KEY = "rmsVsConnector.requestId";
const STATE_ORIGIN_KEY = "rmsVsConnector.origin";
const STATE_MIG_ID_KEY = "rmsVsConnector.migId";

// ---------------------------------------------------------------------------
// ENVIRONMENT MODE
// ---------------------------------------------------------------------------
// Looks for a .env file at the extension's install root. If it's missing —
// or present but doesn't declare NODE_ENV — we default to "production",
// which is the safer default: it forces https/wss even if the user pastes a
// plain http/ws URL. Only an explicit .env with NODE_ENV=development relaxes
// that, for local testing against a plain-http Jupyter server.
function loadEnvMode(context) {
  const envPath = path.join(context.extensionPath, ".env");

  if (fs.existsSync(envPath)) {
    try {
      // Lazy require so a missing 'dotenv' dependency doesn't break every
      // activation for users who never touch a .env file.
      require("dotenv").config({ path: envPath });
    } catch (err) {
      console.error("rms-vs-connector: failed to load .env", err);
    }
  } else {
    console.log(
      "rms-vs-connector: no .env found, defaulting to production mode",
    );
  }

  return process.env.NODE_ENV === "development" ? "development" : "production";
}

// http:// -> https://, ws:// -> wss:// (leaves https/wss untouched).
// No-op entirely in development mode, so localhost testing over plain
// http/ws keeps working.
function enforceProtocol(urlString, mode) {
  if (mode !== "production") return urlString;
  return urlString
    .replace(/^http:\/\//i, "https://")
    .replace(/^ws:\/\//i, "wss://");
}

// ---------------------------------------------------------------------------
// URL PARSING
// ---------------------------------------------------------------------------
// Expected shape: <protocol>://<host>[:port]/<request_id>/<mig_id>/<token>
// All three path segments are dynamic values, in that fixed order — there's
// no literal keyword in the path to anchor on.
function parseConnectionUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch (err) {
    throw new Error("That doesn't look like a valid URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length < 3) {
    throw new Error("Enter a Valid URL");
  }

  const requestId = decodeURIComponent(segments[0]);
  const migId = decodeURIComponent(segments[1]);
  const token = decodeURIComponent(segments[2]);
  const origin = `${url.protocol}//${url.host}`;

  return { origin, requestId, migId, token };
}

// ---------------------------------------------------------------------------
// PROMPT
// ---------------------------------------------------------------------------
async function promptForConnectionUrl() {
  const input = await vscode.window.showInputBox({
    title: "Connect to MAyA",
    prompt: "Paste your MAyA connection URL",
    placeHolder: "Enter MAyA Cloud Machine URL",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value) return "URL is required";
      try {
        parseConnectionUrl(value);
        return null; // valid — VS Code wants null/undefined for "no error"
      } catch (err) {
        return err.message;
      }
    },
  });

  if (!input) return null; // user cancelled
  return parseConnectionUrl(input);
}

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------
async function saveConnection(context, { origin, migId, token, requestId }) {
  await context.globalState.update(STATE_ORIGIN_KEY, origin);
  await context.globalState.update(STATE_MIG_ID_KEY, migId);
  // Token and requestId go in SecretStorage, not globalState — globalState
  // is plain text on disk, SecretStorage is backed by the OS
  // keychain/credential manager. Both are part of the auth handshake, so
  // both get the same treatment.
  await context.secrets.store(SECRET_TOKEN_KEY, token);
  await context.secrets.store(SECRET_REQUEST_ID_KEY, requestId);
}

async function loadStoredConnection(context) {
  const origin = context.globalState.get(STATE_ORIGIN_KEY);
  const migId = context.globalState.get(STATE_MIG_ID_KEY);
  const token = await context.secrets.get(SECRET_TOKEN_KEY);
  const requestId = await context.secrets.get(SECRET_REQUEST_ID_KEY);

  if (!origin || !migId || !token || !requestId) return null;
  return { origin, migId, token, requestId };
}

async function clearConnection(context) {
  await context.globalState.update(STATE_ORIGIN_KEY, undefined);
  await context.globalState.update(STATE_MIG_ID_KEY, undefined);
  await context.secrets.delete(SECRET_TOKEN_KEY);
  await context.secrets.delete(SECRET_REQUEST_ID_KEY);
}

// ---------------------------------------------------------------------------
// HIGH-LEVEL ENTRY POINT
// ---------------------------------------------------------------------------
// Returns { origin, migId, token, requestId, mode } — read from storage if
// present, otherwise prompts the user, validates, enforces protocol per env
// mode, and persists the result for next time. Returns null if the user
// cancels the prompt (caller must handle that — don't assume a connection
// exists).
async function ensureConnection(context, { forcePrompt = false } = {}) {
  const mode = loadEnvMode(context);

  if (!forcePrompt) {
    const stored = await loadStoredConnection(context);
    if (stored) {
      return { ...stored, origin: enforceProtocol(stored.origin, mode), mode };
    }
  }

  const parsed = await promptForConnectionUrl();
  if (!parsed) return null;

  const connection = {
    origin: enforceProtocol(parsed.origin, mode),
    migId: parsed.migId,
    token: parsed.token,
    requestId: parsed.requestId,
  };

  await saveConnection(context, connection);
  return { ...connection, mode };
}

// Same validation, protocol-enforcement, and persistence as ensureConnection,
// but for a URL handed to us directly (e.g. from a deep link) rather than
// typed into the input box. Throws on an invalid URL — caller should catch
// and show that message, same as the input box's own inline validation
// would have.
async function connectFromRawUrl(context, rawUrl) {
  const mode = loadEnvMode(context);
  const parsed = parseConnectionUrl(rawUrl); // throws with a clear message on invalid input

  const connection = {
    origin: enforceProtocol(parsed.origin, mode),
    migId: parsed.migId,
    token: parsed.token,
    requestId: parsed.requestId,
  };

  await saveConnection(context, connection);
  return { ...connection, mode };
}

module.exports = {
  parseConnectionUrl,
  enforceProtocol,
  loadEnvMode,
  connectFromRawUrl,
  promptForConnectionUrl,
  saveConnection,
  loadStoredConnection,
  clearConnection,
  ensureConnection,
};
