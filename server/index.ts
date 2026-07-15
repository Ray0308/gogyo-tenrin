import express from "express";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  FIVE_ELEMENTS,
  type CardTarget,
  type CardView,
  type ClientToServerEvents,
  type CurseState,
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

type AttributeMatchEffect =
  | { type: "apply_curse"; curseId: "curse_poison" | "curse_burn"; stacks: number }
  | { type: "next_damage_reduction"; amount: number }
  | { type: "ignore_damage_reduction"; amount: number }
  | { type: "gain_mp"; amount: number };

interface CardEffectDefinition {
  cardId: string;
  target: "opponent_player";
  baseDamage: number;
  attributeMatchEffect: AttributeMatchEffect;
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
const cardById = new Map(cards.map((card) => [card.id, card]));
const effectDefinitions = loadEffectDefinitions(path.join(currentDirectory, "data", "cardEffects.json"));
const totalCardWeight = cards.reduce((sum, card) => sum + card.weight, 0);
const sessions = new Map<string, StoredSession>();
const socketTokens = new Map<string, string>();

const cardAttributeToElement: Record<string, FiveElement | undefined> = {
  "木": "wood", "火": "fire", "土": "earth", "金": "metal", "水": "water",
};
const elementName: Record<FiveElement, string> = {
  wood: "木", fire: "火", earth: "土", metal: "金", water: "水",
};
const generates: Record<FiveElement, FiveElement> = {
  wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood",
};
const overcomes: Record<FiveElement, FiveElement> = {
  wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood",
};

function loadCards(filePath: string): CardMaster[] {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(value) || value.length === 0) throw new Error("カードマスターが空です。");
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("カードマスターの行が不正です。");
    const card = item as Record<string, unknown>;
    for (const key of ["id", "name", "category", "system", "attribute", "target", "timing", "effectText", "description", "flavorText"]) {
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

function loadEffectDefinitions(filePath: string): Map<string, CardEffectDefinition> {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(value)) throw new Error("カード効果データが不正です。");
  const result = new Map<string, CardEffectDefinition>();
  for (const item of value as CardEffectDefinition[]) {
    if (!cardById.has(item.cardId)) throw new Error(`存在しないカードの効果です: ${item.cardId}`);
    if (result.has(item.cardId)) throw new Error(`カード効果が重複しています: ${item.cardId}`);
    if (item.target !== "opponent_player" || !Number.isFinite(item.baseDamage) || item.baseDamage < 0) {
      throw new Error(`カード効果が不正です: ${item.cardId}`);
    }
    result.set(item.cardId, item);
  }
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
    if (cursor < 0) { selected = card; break; }
  }
  return {
    instanceId: randomUUID(), cardId: selected.id, name: selected.name,
    category: selected.category, system: selected.system, attribute: selected.attribute,
    cost: selected.cost, mpCost: selected.mpCost, target: selected.target,
    timing: selected.timing, effectText: selected.effectText,
    description: selected.description, flavorText: selected.flavorText,
    playable: false, unusableReason: "使用可否を確認中です。",
  };
}

function drawCards(count: number): CardView[] {
  return Array.from({ length: count }, drawCard);
}

function refreshPlayability(state: SessionState): void {
  const battle = state.battle;
  if (!battle) return;
  for (const card of battle.player.hand) {
    const definition = effectDefinitions.get(card.cardId);
    if (battle.phase !== "card_use" || battle.activePlayer !== "player") {
      card.playable = false; card.unusableReason = "現在はカードを使用できません。";
    } else if (!definition) {
      card.playable = false; card.unusableReason = "このカードの構造化効果データは未接続です。";
    } else if (battle.player.cost < card.cost) {
      card.playable = false; card.unusableReason = "コストが不足しています。";
    } else if (battle.player.mp < card.mpCost) {
      card.playable = false; card.unusableReason = "MPが不足しています。";
    } else {
      card.playable = true; card.unusableReason = undefined;
    }
  }
}

function addCurse(curses: CurseState[], curseId: "curse_poison" | "curse_burn", stacks: number): void {
  const existing = curses.find((curse) => curse.id === curseId);
  if (curseId === "curse_poison") {
    if (existing) existing.stacks = Math.min(5, existing.stacks + stacks);
    else curses.push({ id: curseId, name: "毒", stacks: Math.min(5, stacks) });
    return;
  }
  if (existing) { existing.stacks = 1; existing.remainingTriggers = 2; }
  else curses.push({ id: curseId, name: "火傷", stacks: 1, remainingTriggers: 2 });
}

function resolveAttributeMatchEffect(state: SessionState, effect: AttributeMatchEffect): void {
  const battle = state.battle!;
  if (effect.type === "apply_curse") {
    addCurse(battle.cpu.curses, effect.curseId, effect.stacks);
    battle.log.push(`CPUに呪い：${effect.curseId === "curse_poison" ? "毒" : "火傷"}を付与した。`);
  } else if (effect.type === "next_damage_reduction") {
    battle.player.nextDamageReduction = Math.max(battle.player.nextDamageReduction, effect.amount);
    battle.log.push(`次に受けるダメージを${effect.amount}軽減する効果を得た。`);
  } else if (effect.type === "ignore_damage_reduction") {
    battle.log.push(`この攻撃はダメージ軽減を${effect.amount}無視した。`);
  } else {
    battle.player.mp = Math.min(30, battle.player.mp + effect.amount);
    battle.log.push(`属性固有効果でMPが${effect.amount}増加した。`);
  }
}

function useCard(session: StoredSession, instanceId: string, target: CardTarget): { ok: boolean; message?: string } {
  const state = session.state;
  const battle = state.battle;
  if (!battle || state.phase !== "battle" || battle.phase !== "card_use" || battle.activePlayer !== "player") {
    return { ok: false, message: "現在はカードを使用できません。" };
  }
  const index = battle.player.hand.findIndex((card) => card.instanceId === instanceId);
  if (index < 0) return { ok: false, message: "手札に存在しないカードです。" };
  const card = battle.player.hand[index];
  const definition = effectDefinitions.get(card.cardId);
  if (!definition) return { ok: false, message: "このカードの効果処理はまだ接続されていません。" };
  if (target !== "cpu_player" || definition.target !== "opponent_player") {
    return { ok: false, message: "対象が不正です。" };
  }
  if (battle.player.cost < card.cost) return { ok: false, message: "コストが不足しています。" };
  if (battle.player.mp < card.mpCost) return { ok: false, message: "MPが不足しています。" };
  const cardElement = cardAttributeToElement[card.attribute];
  if (!cardElement || !state.playerAttribute || !state.cpuAttribute) return { ok: false, message: "属性情報が不正です。" };

  battle.player.cost -= card.cost;
  battle.player.mp -= card.mpCost;
  const attributeMatch = cardElement === state.playerAttribute;
  const overcoming = overcomes[cardElement] === state.cpuAttribute;
  let damage = definition.baseDamage + (attributeMatch ? 1 : 0) + (overcoming ? 2 : 0);
  damage = Math.max(0, damage - battle.cpu.nextDamageReduction);
  if (battle.cpu.nextDamageReduction > 0) battle.cpu.nextDamageReduction = 0;
  battle.cpu.hp = Math.max(0, battle.cpu.hp - damage);
  battle.log.push(`${card.name}を使用し、CPUへ${damage}ダメージ。`);
  if (attributeMatch) {
    battle.log.push(`属性一致：基本効果量に＋1。`);
    resolveAttributeMatchEffect(state, definition.attributeMatchEffect);
  }
  if (overcoming) battle.log.push(`相剋成立：ダメージに＋2。`);
  if (generates[state.playerAttribute] === cardElement) {
    battle.player.mp = Math.min(30, battle.player.mp + 1);
    battle.log.push(`相生成立：MPが1増加した。`);
  }

  const [usedCard] = battle.player.hand.splice(index, 1);
  usedCard.playable = false;
  usedCard.unusableReason = "使用済みです。";
  battle.player.discard.push(usedCard);
  if (battle.cpu.hp <= 0) {
    battle.phase = "finished";
    battle.winner = "player";
    battle.log.push("CPUのHPが0になり、プレイヤーが勝利した。");
  }
  refreshPlayability(state);
  return { ok: true };
}

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.use(express.static(distributionDirectory));
app.get("/", (_request, response) => response.type("html").send(rootDocument));

io.on("connection", (socket) => {
  sendState(socket.id, { phase: "title" });

  socket.on("session:resume", (token, callback) => {
    const session = sessions.get(token);
    if (!session) { callback({ ok: false, message: "復帰できる対戦がありません。" }); return; }
    socketTokens.set(socket.id, token);
    refreshPlayability(session.state);
    callback({ ok: true, state: publicState(session.state) });
    sendState(socket.id, session.state);
  });

  socket.on("cpu:start", ({ playerName }, callback) => {
    const normalizedName = playerName.trim();
    if (!normalizedName) { callback({ ok: false, message: "プレイヤー名を入力してください。" }); return; }
    const previousToken = socketTokens.get(socket.id);
    if (previousToken) sessions.delete(previousToken);
    const reconnectToken = randomUUID();
    const state: SessionState = { phase: "attribute_selection", reconnectToken, playerName: normalizedName };
    sessions.set(reconnectToken, { state, cpuHand: [] });
    socketTokens.set(socket.id, reconnectToken);
    callback({ ok: true, state: publicState(state) });
    sendState(socket.id, state);
  });

  socket.on("attribute:select", ({ attribute }, callback) => {
    const session = currentSession(socket.id);
    if (!session || session.state.phase !== "attribute_selection") { callback({ ok: false, message: "現在は属性を選択できません。" }); return; }
    if (!FIVE_ELEMENTS.includes(attribute as FiveElement)) { callback({ ok: false, message: "選択した属性が不正です。" }); return; }
    session.state.playerAttribute = attribute;
    session.state.cpuAttribute = FIVE_ELEMENTS[randomInt(FIVE_ELEMENTS.length)];
    session.state.phase = "attribute_reveal";
    callback({ ok: true, state: publicState(session.state) });
    sendState(socket.id, session.state);
  });

  socket.on("match:enter", (callback) => {
    const session = currentSession(socket.id);
    if (!session || session.state.phase !== "attribute_reveal") { callback({ ok: false, message: "対戦を開始できません。" }); return; }
    const playerHand = drawCards(5);
    session.cpuHand = drawCards(5);
    session.state.phase = "battle";
    session.state.battle = {
      turnNumber: 1, activePlayer: "player", phase: "card_use",
      player: { hp: 30, mp: 0, cost: 5, curses: [], nextDamageReduction: 0, hand: playerHand, discard: [] },
      cpu: { hp: 30, mp: 0, cost: 5, curses: [], nextDamageReduction: 0, handCount: session.cpuHand.length },
      log: ["対戦を開始した。双方が5枚引いた。"],
    };
    refreshPlayability(session.state);
    callback({ ok: true, state: publicState(session.state) });
    sendState(socket.id, session.state);
  });

  socket.on("card:use", ({ instanceId, target }, callback) => {
    const session = currentSession(socket.id);
    if (!session) { callback({ ok: false, message: "対戦情報がありません。" }); return; }
    const result = useCard(session, instanceId, target);
    if (!result.ok) { callback(result); return; }
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

  socket.on("disconnect", () => socketTokens.delete(socket.id));
});

server.listen(port, () => console.log(`五行転輪 server listening on port ${port}`));