var express = require("express");
const bodyParser = require("body-parser");
let path = require("path");
const fs = require("fs");

var helpers = require("./helpers");
var port = 8890;

const logEntries = [];

const ESP_HEARTBEAT_INTERVAL_MS = 2000;
const ESP_HEARTBEAT_TIMEOUT_MS = 6000;

const frontendConnectionState = {
  socketIds: new Set(),
  connectedAt: null
};

const espConnectionState = {
  socketId: null,
  connectedAt: null,
  lastHeartbeatAt: null
};

function emitConnectionStatus(io) {
  io.emit("frontend_status", {
    connected: frontendConnectionState.socketIds.size > 0,
    connectedAt: frontendConnectionState.connectedAt
  });

  io.emit("esp_status", {
    connected: Boolean(espConnectionState.socketId),
    connectedAt: espConnectionState.connectedAt
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
}

function clearEspConnection() {
  espConnectionState.socketId = null;
  espConnectionState.connectedAt = null;
  espConnectionState.lastHeartbeatAt = null;
}

let app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", function (req, res) {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/api/logs", function (req, res) {
  res.json([...logEntries].reverse());
});

var http = require("http").createServer(app);
var io = require("socket.io")(http);

io.on("connection", function (socket) {
  var connId = false;

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

  var message = "a client connected: " + connId;
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

    var message = "a client disconnected: " + connId;
    helpers.logMessage("disconnect", message, connId, msg);
  });

  socket.on("rf_log", function (data) {
    var timestamp = new Date().toISOString();
    var logEntry = timestamp + " - " + JSON.stringify(data) + "\n";

    logEntries.push(logEntry.trimEnd());

    // Write to backend.log file
    fs.appendFile(path.join(__dirname, "backend.log"), logEntry, function (err) {
      if (err) {
        console.log("Error writing to log file:", err);
      }
    });

    // Broadcast to all connected clients
    io.emit("rf_log", {
      timestamp: timestamp,
      data: data
    });
  });

  // Handle transmit requests from clients
  socket.on("tx", function (data) {
    if (!data || data.code === undefined || data.code === null || String(data.code).trim() === "") {
      socket.emit("tx_error", { message: "Invalid transmit request: missing code." });
      return;
    }

    var normalizedCode = String(data.code).trim();
    var clientRequestId = data.clientRequestId || null;

    // data expected: { code: <string|number>, meta?: {...} }
    console.log("Received tx from client:", socket.id, data);
    var timestamp = new Date().toISOString();
    var logEntry = timestamp + " - " + JSON.stringify({ type: "tx", code: normalizedCode, meta: data.meta || null }) + "\n";

    logEntries.push(logEntry.trimEnd());

    // Write to backend.log file
    fs.appendFile(path.join(__dirname, "backend.log"), logEntry, function (err) {
      if (err) {
        console.log("Error writing tx to log file:", err);
      }
    });

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

    console.log("Forwarded tx to clients:", normalizedCode);
  });

  // Clear only the in-memory/session logs (used by "Clear Session Logs")
  socket.on("clear", function () {
    logEntries.length = 0;
    io.emit("clear");
  });

  // Clear only the system log file on disk (used by "Clear System Logs")
  socket.on("clear_system", function () {
    try {
      fs.writeFileSync(path.join(__dirname, "backend.log"), "");
      io.emit("system_cleared");
    } catch (err) {
      console.log("Error clearing system log file:", err);
    }
  });

  socket.on("esp_heartbeat_ack", function () {
    if (!isFrontendClient(socket)) {
      markEspHeartbeat(socket);
      emitConnectionStatus(io);
    }
  });

  socket.onAny((event, ...args) => {
    console.log(`Received event: ${event}`);
    console.log("With arguments:", args);

    var payload = args;

    try {
      if (helpers.isJSONStringObject(args)) {
        payload = JSON.parse(args);
      } else {
        payload = args[0];
      }

      console.log("Parsed payload:", payload);

    } catch (e) {
      console.log("Error parsing JSON:", e);
      socket.emit(event, { message: "Error parsing message" }); // send error to sender
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
      socket.emit("esp_heartbeat", {
        timestamp: new Date().toISOString()
      });
    }
  }

  emitConnectionStatus(io);
}, ESP_HEARTBEAT_INTERVAL_MS);

http.listen(port, function () {
  console.log("listening on *:" + port);
});