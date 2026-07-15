import express from "express";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  FIVE_ELEMENTS,
  type CardView,
  type ClientToServerEvents,
  type FiveElement,
  type ServerToClientEvents,
  type SessionState,
} from "../shared/protocol.js";

interface CardMaster {
  id: string;
  name: string;
  category: string;
  system: string;
  attribute: string;
  templateId: string | null;
  cost: number;
  mpCost: number;
  weight: number;
  target: string;
  timing: string;
  effectText: string;
  description: string;
  flavorText: string;
}

interface StoredSession {
  state: SessionState;
  cpuHand: CardView[];
}

const app = express();
export const server = createServer(app);
export const io = new Server<ClientToServerEvents, ServerToClientEvents>(server);
const port = Number(process.env.PORT ?? 3000);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory = path.resolve(currentDirectory, "..");
const clientDirectory = path.join(distributionDirectory, "client");
const rootDocument = readFileSync(path.join(clientDirectory, "index.html"), "utf8");
const cards = loadCards(path.join(currentDirectory, "data", "cards.json"));
const totalCardWeight = cards.reduce((sum, card) => sum + card.weight, 0);
const sessions = new Map<string, StoredSession>();
const socketTokens = new Map<string, string>();

function loadCards(filePath: string): CardMaster[] {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("カードマスターが空です。");
  }

  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("カードマスターの行が不正です。");
    const card = item as Record<string, unknown>;
    const requiredStrings = ["id", "name", "category", "system", "attribute", "target", "timing", "effectText", "description", "flavorText"];
    for (const key of requiredStrings) {
      if (typeof card[key] !== "string") throw new Error(`カードマスター ${String(card.id)} の ${key} が不正です。`);
    }
    if (!/^[a-z0-9_]+$/.test(card.id as string)) throw new Error(`カードIDが不正です: ${String(card.id)}`);
    if (ids.has(card.id as string)) throw new Error(`カードIDが重複しています: ${String(card.id)}`);
    ids.add(card.id as string);
    for (const key of ["cost", "mpCost", "weight"]) {
      if (typeof card[key] !== "number" || !Number.isFinite(card[key]) || (card[key] as number) < 0) {
        throw new Error(`カードマスター ${String(card.id)} の ${key} が不正です。`);
      }
    }
  }

  const result = value as CardMaster[];
  if (result.every((card) => card.weight === 0)) throw new Error("抽選可能なカードがありません。");
  return result;
}

function publicState(state: SessionState): SessionState {
  return structuredClone(state);
}

function currentSession(socketId: string): StoredSession | undefined {
  const token = socketTokens.get(socketId);
  return token ? sessions.get(token) : undefined;
}

function sendState(socketId: string, state: SessionState): void {
  io.to(socketId).emit("session:state", publicState(state));
}

function drawCard(): CardView {
  let cursor = (randomInt(0, 1_000_000_000) / 1_000_000_000) * totalCardWeight;
  let selected = cards[cards.length - 1];
  for (const card of cards) {
    cursor -= card.weight;
    if (cursor < 0) {
      selected = card;
      break;
    }
  }
  return {
    instanceId: randomUUID(),
    cardId: selected.id,
    name: selected.name,
    category: selected.category,
    system: selected.system,
    attribute: selected.attribute,
    cost: selected.cost,
    mpCost: selected.mpCost,
    target: selected.target,
    timing: selected.timing,
    effectText: selected.effectText,
    description: selected.description,
    flavorText: selected.flavorText,
  };
}

function drawCards(count: number): CardView[] {
  return Array.from({ length: count }, drawCard);
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
    const session = sessions.get(token);
    if (!session) {
      callback({ ok: false, message: "復帰できる対戦がありません。" });
      return;
    }
    socketTokens.set(socket.id, token);
    callback({ ok: true, state: publicState(session.state) });
    sendState(socket.id, session.state);
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
    sessions.set(reconnectToken, { state, cpuHand: [] });
    socketTokens.set(socket.id, reconnectToken);
    callback({ ok: true, state: publicState(state) });
    sendState(socket.id, state);
  });

  socket.on("attribute:select", ({ attribute }, callback) => {
    const session = currentSession(socket.id);
    if (!session || session.state.phase !== "attribute_selection") {
      callback({ ok: false, message: "現在は属性を選択できません。" });
      return;
    }
    if (!FIVE_ELEMENTS.includes(attribute as FiveElement)) {
      callback({ ok: false, message: "選択した属性が不正です。" });
      return;
    }
    session.state.playerAttribute = attribute;
    session.state.cpuAttribute = FIVE_ELEMENTS[randomInt(FIVE_ELEMENTS.length)];
    session.state.phase = "attribute_reveal";
    callback({ ok: true, state: publicState(session.state) });
    sendState(socket.id, session.state);
  });

  socket.on("match:enter", (callback) => {
    const session = currentSession(socket.id);
    if (!session || session.state.phase !== "attribute_reveal") {
      callback({ ok: false, message: "対戦を開始できません。" });
      return;
    }
    const playerHand = drawCards(5);
    session.cpuHand = drawCards(5);
    session.state.phase = "battle";
    session.state.battle = {
      turnNumber: 1,
      activePlayer: "player",
      phase: "card_use",
      player: { hp: 30, mp: 0, cost: 5, hand: playerHand },
      cpu: { hp: 30, mp: 0, cost: 5, handCount: session.cpuHand.length },
    };
    callback({ ok: true, state: publicState(session.state) });
    sendState(socket.id, session.state);
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