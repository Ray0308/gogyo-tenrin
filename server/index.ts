import express from "express";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  FIVE_ELEMENTS,
  type ClientToServerEvents,
  type FiveElement,
  type ServerToClientEvents,
  type SessionState,
} from "../shared/protocol.js";

const app = express();
export const server = createServer(app);
export const io = new Server<ClientToServerEvents, ServerToClientEvents>(server);
const port = Number(process.env.PORT ?? 3000);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory = path.resolve(currentDirectory, "..");
const clientDirectory = path.join(distributionDirectory, "client");
const rootDocument = readFileSync(path.join(clientDirectory, "index.html"), "utf8");
const sessions = new Map<string, SessionState>();
const socketTokens = new Map<string, string>();

function publicState(state: SessionState): SessionState {
  return { ...state };
}

function currentSession(socketId: string): SessionState | undefined {
  const token = socketTokens.get(socketId);
  return token ? sessions.get(token) : undefined;
}

function sendState(socketId: string, state: SessionState): void {
  io.to(socketId).emit("session:state", publicState(state));
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});
app.use(express.static(distributionDirectory));
app.get("/", (_request, response) => {
  response.type("html").send(rootDocument);
});

io.on("connection", (socket) => {
  sendState(socket.id, { phase: "title" });

  socket.on("session:resume", (token, callback) => {
    const state = sessions.get(token);
    if (!state) {
      callback({ ok: false, message: "復帰できる対戦がありません。" });
      return;
    }
    socketTokens.set(socket.id, token);
    callback({ ok: true, state: publicState(state) });
    sendState(socket.id, state);
  });

  socket.on("cpu:start", ({ playerName }, callback) => {
    const normalizedName = playerName.trim();
    if (!normalizedName) {
      callback({ ok: false, message: "プレイヤー名を入力してください。" });
      return;
    }
    const previousToken = socketTokens.get(socket.id);
    if (previousToken) sessions.delete(previousToken);
    const reconnectToken = randomUUID();
    const state: SessionState = {
      phase: "attribute_selection",
      reconnectToken,
      playerName: normalizedName,
    };
    sessions.set(reconnectToken, state);
    socketTokens.set(socket.id, reconnectToken);
    callback({ ok: true, state: publicState(state) });
    sendState(socket.id, state);
  });

  socket.on("attribute:select", ({ attribute }, callback) => {
    const state = currentSession(socket.id);
    if (!state || state.phase !== "attribute_selection") {
      callback({ ok: false, message: "現在は属性を選択できません。" });
      return;
    }
    if (!FIVE_ELEMENTS.includes(attribute as FiveElement)) {
      callback({ ok: false, message: "選択した属性が不正です。" });
      return;
    }
    state.playerAttribute = attribute;
    state.cpuAttribute = FIVE_ELEMENTS[randomInt(FIVE_ELEMENTS.length)];
    state.phase = "attribute_reveal";
    callback({ ok: true, state: publicState(state) });
    sendState(socket.id, state);
  });

  socket.on("match:enter", (callback) => {
    const state = currentSession(socket.id);
    if (!state || state.phase !== "attribute_reveal") {
      callback({ ok: false, message: "対戦を開始できません。" });
      return;
    }
    state.phase = "battle";
    callback({ ok: true, state: publicState(state) });
    sendState(socket.id, state);
  });

  socket.on("session:reset", (callback) => {
    const token = socketTokens.get(socket.id);
    if (token) sessions.delete(token);
    socketTokens.delete(socket.id);
    const state: SessionState = { phase: "title" };
    callback({ ok: true, state });
    sendState(socket.id, state);
  });

  socket.on("disconnect", () => {
    socketTokens.delete(socket.id);
  });
});

server.listen(port, () => {
  console.log(`五行転輪 server listening on port ${port}`);
});