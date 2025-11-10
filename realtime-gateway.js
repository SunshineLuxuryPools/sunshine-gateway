import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 8080;

// simple health check
app.get("/", (req, res) => res.send("Gateway running"));

// WS server that Twilio will stream to at /media
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  console.log("🔗  Stream connected:", req.url);
  ws.on("message", (msg) => console.log("📦  Received", msg.length, "bytes"));
  ws.on("close", () => console.log("❌  Stream closed"));
});

// upgrade HTTP -> WS for /media only
const server = app.listen(PORT, () =>
  console.log(`🌞 Sunshine Gateway listening on port ${PORT}`)
);
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
