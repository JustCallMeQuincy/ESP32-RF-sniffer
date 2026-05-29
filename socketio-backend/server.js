const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const helpers = require("./helpers");
const port = 8890;
const backendLogPath = path.join(__dirname, "backend.log");

const DEFAULT_SETTINGS = {
  sessionLogSizeLimitMb: 5,
  sessionLogMaxEntries: 200,
  sessionLogCapEnabled: true,
  systemLogMaxAgeDays: 30,
  systemLogSizeLimitMb: 10,
  systemLogsEnabled: true,
  txEnabled: true
};

let currentSettings = { ...DEFAULT_SETTINGS };

// Enable payload (TX/RX) console logging when DEBUG_PAYLOADS is set.
// Accepts: DEBUG_PAYLOADS=1 or DEBUG=true or DEBUG_PAYLOADS=true
const DEBUG_PAYLOADS = process.env.DEBUG_PAYLOADS === "1" || process.env.DEBUG === "true" || process.env.DEBUG_PAYLOADS === "true";

const logEntries = [];

const ESP_HEARTBEAT_INTERVAL_MS = 1000;
const ESP_HEARTBEAT_TIMEOUT_MS = 15000;

const frontendConnectionState = {
  socketIds: new Set(),
  connectedAt: null
};

const espConnectionState = {
  socketId: null,
  connectedAt: null,
  lastHeartbeatAt: null,
  lastHeartbeatSeenAt: null,
  lastHeartbeatSentAt: null,
  responseTimeMs: null
};

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSessionLogMaxEntries(value, fallback) {
  const parsed = Number(value);

  if (parsed === -1) {
    return -1;
  }

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};

  return {
    sessionLogSizeLimitMb: parsePositiveNumber(source.sessionLogSizeLimitMb, currentSettings.sessionLogSizeLimitMb),
    sessionLogMaxEntries: parseSessionLogMaxEntries(source.sessionLogMaxEntries, currentSettings.sessionLogMaxEntries),
    sessionLogCapEnabled: source.sessionLogCapEnabled !== undefined ? Boolean(source.sessionLogCapEnabled) : currentSettings.sessionLogCapEnabled,
    systemLogMaxAgeDays: parsePositiveNumber(source.systemLogMaxAgeDays, currentSettings.systemLogMaxAgeDays),
    systemLogSizeLimitMb: parsePositiveNumber(source.systemLogSizeLimitMb, currentSettings.systemLogSizeLimitMb),
    systemLogsEnabled: source.systemLogsEnabled !== undefined ? Boolean(source.systemLogsEnabled) : currentSettings.systemLogsEnabled,
    txEnabled: source.txEnabled !== undefined ? Boolean(source.txEnabled) : currentSettings.txEnabled
  };
}

function getSessionLogLimitBytes() {
  return Math.max(1, Math.round(currentSettings.sessionLogSizeLimitMb * 1024 * 1024));
}

function getSystemLogLimitBytes() {
  return Math.max(1, Math.round(currentSettings.systemLogSizeLimitMb * 1024 * 1024));
}

function pruneSessionLogs(reserveSpaceForNewEntry = false) {
  if (!currentSettings.sessionLogCapEnabled) {
    return;
  }

  const maxEntries = Number(currentSettings.sessionLogMaxEntries);

  if (!Number.isFinite(maxEntries)) {
    return;
  }

  const maxEntryCount = Math.max(1, Math.floor(maxEntries));
  const targetLength = reserveSpaceForNewEntry ? maxEntryCount - 1 : maxEntryCount;

  while (logEntries.length > targetLength) {
    logEntries.shift();
  }

  const limitBytes = getSessionLogLimitBytes();
  let totalBytes = logEntries.reduce((sum, entry) => sum + Buffer.byteLength(entry + "\n", "utf8"), 0);

  while (logEntries.length > 0 && totalBytes > limitBytes) {
    const removed = logEntries.shift();
    totalBytes -= Buffer.byteLength(removed + "\n", "utf8");
  }
}

function pruneSystemLogFile() {
  if (!currentSettings.systemLogsEnabled) {
    return;
  }

  if (!fs.existsSync(backendLogPath)) {
    return;
  }

  let contents = "";
  try {
    contents = fs.readFileSync(backendLogPath, "utf8");
  } catch (err) {
    console.log("Error reading system log file for pruning:", err);
    return;
  }

  if (!contents.trim()) {
    return;
  }

  const cutoffTime = Date.now() - (currentSettings.systemLogMaxAgeDays * 24 * 60 * 60 * 1000);
  let lines = contents.split(/\r?\n/).filter(Boolean).filter((line) => {
    const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    if (!timestampMatch) {
      return true;
    }

    const timestamp = Date.parse(timestampMatch[1]);
    return !Number.isNaN(timestamp) && timestamp >= cutoffTime;
  });

  const limitBytes = getSystemLogLimitBytes();
  let serialized = lines.length > 0 ? lines.join("\n") + "\n" : "";

  while (lines.length > 0 && Buffer.byteLength(serialized, "utf8") > limitBytes) {
    lines.shift();
    serialized = lines.length > 0 ? lines.join("\n") + "\n" : "";
  }

  try {
    fs.writeFileSync(backendLogPath, serialized);
  } catch (err) {
    console.log("Error pruning system log file:", err);
  }
}

function appendSystemLogEntry(logEntry) {
  fs.appendFile(backendLogPath, logEntry, function (err) {
    if (err) {
      console.log("Error writing to log file:", err);
      return;
    }

    pruneSystemLogFile();
  });
}

function setSettings(nextSettings) {
  currentSettings = normalizeSettings(nextSettings);
  pruneSessionLogs();
  pruneSystemLogFile();
}

function getSettingsSnapshot() {
  return { ...currentSettings };
}

function emitSettings(io) {
  io.emit("settings_updated", getSettingsSnapshot());
}

function emitConnectionStatus(io) {
  const lastHeartbeatAt = espConnectionState.lastHeartbeatAt || espConnectionState.lastHeartbeatSeenAt;
  const heartbeatLagTicks = lastHeartbeatAt ? Math.max(0, Math.floor((Date.now() - lastHeartbeatAt) / ESP_HEARTBEAT_INTERVAL_MS) - 1) : null;

  io.emit("frontend_status", {
    connected: frontendConnectionState.socketIds.size > 0,
    connectedAt: frontendConnectionState.connectedAt
  });

  io.emit("esp_status", {
    connected: Boolean(espConnectionState.socketId),
    connectedAt: espConnectionState.connectedAt,
    lastHeartbeatAt: lastHeartbeatAt,
    heartbeatLagTicks: heartbeatLagTicks,
    responseTimeMs: espConnectionState.responseTimeMs
  });
}

function isFrontendClient(socket) {
  return socket.handshake && socket.handshake.query && socket.handshake.query.clientRole === "web";
}

function markEspHeartbeat(socket) {
  espConnectionState.socketId = socket.id;
  if (!espConnectionState.connectedAt) {
    espConnectionState.connectedAt = new Date().toISOString();
  }
  espConnectionState.lastHeartbeatAt = Date.now();
  espConnectionState.lastHeartbeatSeenAt = espConnectionState.lastHeartbeatAt;
}

function clearEspConnection() {
  espConnectionState.socketId = null;
  espConnectionState.connectedAt = null;
  espConnectionState.lastHeartbeatAt = null;
  espConnectionState.responseTimeMs = null;
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(function (req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", function (req, res) {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/api/logs", function (req, res) {
  res.json([...logEntries].reverse());
});

app.get("/api/settings", function (req, res) {
  res.json(getSettingsSnapshot());
});

app.post("/api/settings", function (req, res) {
  setSettings(req.body);
  emitSettings(io);
  res.json(getSettingsSnapshot());
});

const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", function (socket) {
  let connId = false;

  if (socket.conn) {
    connId = socket.conn.id;
  }

  if (isFrontendClient(socket)) {
    frontendConnectionState.socketIds.add(socket.id);
    if (!frontendConnectionState.connectedAt) {
      frontendConnectionState.connectedAt = new Date().toISOString();
    }
  }

  emitConnectionStatus(io);
  socket.emit("settings", getSettingsSnapshot());

  const message = "a client connected: " + connId;
  helpers.logMessage("connect", message, connId);

  socket.on("disconnect", function (msg) {
    if (isFrontendClient(socket)) {
      frontendConnectionState.socketIds.delete(socket.id);
      if (frontendConnectionState.socketIds.size === 0) {
        frontendConnectionState.connectedAt = null;
      }
    } else if (espConnectionState.socketId === socket.id) {
      clearEspConnection();
    }

    emitConnectionStatus(io);

    const message = "a client disconnected: " + connId;
    helpers.logMessage("disconnect", message, connId, msg);
  });

  socket.on("rf_log", function (data) {
    const timestamp = new Date().toISOString();
    const logEntry = timestamp + " - " + JSON.stringify(data) + "\n";

    pruneSessionLogs(true);
    logEntries.push(logEntry.trimEnd());
    pruneSessionLogs();

    appendSystemLogEntry(logEntry);

    // Broadcast to all connected clients
    io.emit("rf_log", {
      timestamp: timestamp,
      data: data
    });
  });

  // Handle transmit requests from clients
  socket.on("tx", function (data) {
    if (!currentSettings.txEnabled) {
      socket.emit("tx_error", { message: "TX functionality is disabled in settings." });
      return;
    }

    if (!data || data.code === undefined || data.code === null || String(data.code).trim() === "") {
      socket.emit("tx_error", { message: "Invalid transmit request: missing code." });
      return;
    }

    const normalizedCode = String(data.code).trim();
    const clientRequestId = data.clientRequestId || null;

    // data expected: { code: <string|number>, meta?: {...} }
    if (DEBUG_PAYLOADS) {
      console.log("Received tx from client:", socket.id, data);
    }
    const timestamp = new Date().toISOString();
    const logEntry = timestamp + " - " + JSON.stringify({ type: "tx", code: normalizedCode, meta: data.meta || null }) + "\n";

    pruneSessionLogs(true);
    logEntries.push(logEntry.trimEnd());
    pruneSessionLogs();

    appendSystemLogEntry(logEntry);

    // Broadcast a rf_log event so all clients see the transmit
    io.emit("rf_log", {
      timestamp: timestamp,
      data: { type: "tx", code: normalizedCode, meta: data.meta || null }
    });

    // Forward transmit command to connected clients (ESP32 devices)
    io.emit("tx", { code: normalizedCode, meta: data.meta || null });

    // Optionally acknowledge sender
    socket.emit("tx_ack", {
      timestamp: timestamp,
      code: normalizedCode,
      clientRequestId: clientRequestId
    });

    if (DEBUG_PAYLOADS) {
      console.log("Forwarded tx to clients:", normalizedCode);
    }
  });

  socket.on("backend_ping", function (data) {
    socket.emit("backend_pong", {
      requestId: data && data.requestId ? data.requestId : null,
      sentAtMs: data && typeof data.sentAtMs === "number" ? data.sentAtMs : null,
      timestamp: new Date().toISOString()
    });
  });

  // Clear only the in-memory/session logs (used by "Clear Session Logs")
  socket.on("clear", function () {
    logEntries.length = 0;
    io.emit("clear");
  });

  // Clear the system log file on disk and the in-memory session buffer
  // (used by "Clear System Logs")
  socket.on("clear_system", function () {
    try {
      logEntries.length = 0;
      io.emit("clear");
      fs.writeFileSync(backendLogPath, "");
      io.emit("system_cleared");
    } catch (err) {
      console.log("Error clearing system log file:", err);
    }
  });

  socket.on("settings_update", function (data) {
    setSettings(data);
    emitSettings(io);
    socket.emit("settings", getSettingsSnapshot());
  });

  socket.on("esp_heartbeat_ack", function () {
    if (!isFrontendClient(socket)) {
      const now = Date.now();
      if (espConnectionState.lastHeartbeatSentAt) {
        espConnectionState.responseTimeMs = now - espConnectionState.lastHeartbeatSentAt;
      }
      markEspHeartbeat(socket);
      emitConnectionStatus(io);
    }
  });

  socket.onAny((event, ...args) => {
    let payload = args && args.length > 0 ? args[0] : null;

    try {
      if (typeof payload === "string" && helpers.isJSONStringObject(payload)) {
        payload = JSON.parse(payload);
      } else if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === "string" && helpers.isJSONStringObject(payload[0])) {
        payload = JSON.parse(payload[0]);
      }
    } catch (e) {
      console.log("Error parsing JSON:", e);
      socket.emit(event, { message: "Error parsing message" });
      return;
    }

    const isHeartbeatOrPing = event && (event.includes("heartbeat") || event.includes("ping") || event.includes("pong"));
    if (DEBUG_PAYLOADS) {
      console.log(`Received event: ${event}`);
      console.log("With arguments:", args);
      console.log("Parsed payload:", payload);
    } else {
      if (isHeartbeatOrPing) {
        console.log(`Received event: ${event}`, payload);
      }
      // when not debugging, do not print payloads like tx/rf_log/rx
    }
  });
});

setInterval(function () {
  const now = Date.now();

  if (espConnectionState.socketId && espConnectionState.lastHeartbeatAt && now - espConnectionState.lastHeartbeatAt > ESP_HEARTBEAT_TIMEOUT_MS) {
    clearEspConnection();
  }

  for (const socket of io.sockets.sockets.values()) {
    if (!isFrontendClient(socket)) {
      espConnectionState.lastHeartbeatSentAt = Date.now();
      socket.emit("esp_heartbeat", {
        timestamp: new Date().toISOString(),
        sentAtMs: espConnectionState.lastHeartbeatSentAt
      });
    }
  }

  emitConnectionStatus(io);
}, ESP_HEARTBEAT_INTERVAL_MS);

http.listen(port, function () {
  console.log("listening on *:" + port);
});