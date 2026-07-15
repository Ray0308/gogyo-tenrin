import {
  type ActionResult,
  type CardPlayTarget,
  type CardTarget,
  type DefenseTarget,
  type FiveElement,
  type SessionState,
} from "../shared/protocol.js";
import { deriveBattleVisualChanges, type BattleSide, type BattleVisualChange } from "./battle-animations.js";

type Acknowledge = (result: ActionResult) => void;
interface BrowserSocket {
  on(event: "connect", listener: () => void): void;
  on(event: "connect_error", listener: () => void): void;
  on(event: "session:state", listener: (state: SessionState) => void): void;
  emit(event: "session:resume", token: string, callback: Acknowledge): void;
  emit(event: "cpu:start", payload: { playerName: string }, callback: Acknowledge): void;
  emit(event: "room:create", payload: { playerName: string }, callback: Acknowledge): void;
  emit(event: "room:join", payload: { playerName: string; roomId: string }, callback: Acknowledge): void;
  emit(event: "attribute:select", payload: { attribute: FiveElement }, callback: Acknowledge): void;
  emit(event: "match:enter" | "session:reset", callback: Acknowledge): void;
  emit(event: "card:use", payload: { instanceId: string; target: CardTarget; choice?: string }, callback: Acknowledge): void;
  emit(event: "card:discard", payload: { instanceId: string }, callback: Acknowledge): void;
  emit(event: "reaction:respond", payload: { instanceId?: string; target?: DefenseTarget }, callback: Acknowledge): void;
  emit(event: "turn:end" | "room:start" | "room:leave" | "rematch:request" | "rematch:cancel", callback: Acknowledge): void;
  connect(): void;
  io: { on(event: "reconnect_attempt", listener: () => void): void };
}
declare function io(options: { autoConnect: boolean }): BrowserSocket;

const app = document.querySelector<HTMLElement>("#app")!;
if (!app) throw new Error("Application root not found");

const socket = io({ autoConnect: false });
const TOKEN_KEY = "gogyo-tenrin-reconnect-token";
const SETTINGS_KEY = "gogyo-tenrin-settings";
const elements: Record<FiveElement, { name: string; mark: string }> = {
  wood: { name: "木", mark: "木" }, fire: { name: "火", mark: "火" },
  earth: { name: "土", mark: "土" }, metal: { name: "金", mark: "金" },
  water: { name: "水", mark: "水" },
};

type LocalScreen = "connecting" | "title" | "cpu_setup" | "online";
type Dialog = "rules" | "settings" | "card" | null;
interface Settings { bgm: number; sound: number; vibration: boolean; speed: string; log: boolean }
let screen: LocalScreen = "connecting";
let dialog: Dialog = null;
let selectedCardId: string | null = null;
let pendingCardId: string | null = null;
let selectedChoice: string | undefined;
let state: SessionState = { phase: "title" };
let busy = false;
let errorMessage = "";
let settings: Settings = loadSettings();
interface BattleCue { title: string; detail?: string; side?: BattleSide }
const battleCueQueue: BattleCue[] = [];
let battleCuePlaying = false;

function animationDuration(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 80;
  return settings.speed === "fast" ? 420 : settings.speed === "slow" ? 950 : 650;
}
function enqueueBattleCue(cue: BattleCue): void {
  battleCueQueue.push(cue);
  playNextBattleCue();
}
function playNextBattleCue(): void {
  if (battleCuePlaying || battleCueQueue.length === 0) return;
  battleCuePlaying = true;
  const cue = battleCueQueue.shift()!;
  const layer = document.createElement("div");
  layer.className = `battle-cue-layer ${cue.side ?? "neutral"}`;
  const panel = document.createElement("div");
  panel.className = "battle-cue";
  const title = document.createElement("strong");
  title.textContent = cue.title;
  panel.append(title);
  if (cue.detail) { const detail = document.createElement("span"); detail.textContent = cue.detail; panel.append(detail); }
  layer.append(panel);document.body.append(layer);
  const duration = animationDuration();
  window.setTimeout(() => layer.classList.add("leaving"), Math.max(40, duration - 160));
  window.setTimeout(() => { layer.remove();battleCuePlaying = false;playNextBattleCue(); }, duration);
}
function combatantElement(change: Extract<BattleVisualChange, { type: "damage" | "heal" }>): HTMLElement | null {
  if (change.unitId) return document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.unitId)}"]`);
  return document.querySelector<HTMLElement>(`[data-combatant="${change.side}"]`);
}
function actionElement(change: Extract<BattleVisualChange, { type: "action" }>): HTMLElement | null {
  if (change.actorUnitId) return document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.actorUnitId)}"]`);
  return document.querySelector<HTMLElement>(`[data-combatant="${change.side}"]`);
}
function replayAnimation(target: HTMLElement, className: string): void {
  target.classList.remove(className);
  void target.offsetWidth;
  target.classList.add(className);
  window.setTimeout(() => target.classList.remove(className), animationDuration() + 180);
}
function showFloatingChange(target: HTMLElement, type: "damage" | "heal", amount: number): void {
  const rect = target.getBoundingClientRect();
  const number = document.createElement("span");
  number.className = `battle-floating-change ${type}`;
  number.textContent = `${type === "damage" ? "-" : "+"}${amount}`;
  number.style.left = `${rect.left + rect.width / 2}px`;
  number.style.top = `${rect.top + Math.min(rect.height * .45, 54)}px`;
  document.body.append(number);
  window.setTimeout(() => number.remove(), Math.max(760, animationDuration() + 220));
}
function animateBattleChanges(changes: BattleVisualChange[]): void {
  for (const change of changes) {
    if (change.type === "battle_start") enqueueBattleCue({ title: "対戦開始", detail: change.side === "player" ? "自分のターン" : "相手のターン", side: change.side });
    else if (change.type === "turn") enqueueBattleCue({ title: change.side === "player" ? "自分のターン" : "相手のターン", detail: `第${change.turnNumber}ターン・手札更新`, side: change.side });
    else if (change.type === "action") {
      const title = change.kind === "defense" ? "防御発動" : change.kind === "counter" ? "反撃" : change.side === "player" ? "攻撃" : "相手の攻撃";
      enqueueBattleCue({ title, detail: change.text, side: change.side });
      requestAnimationFrame(() => {
        const actor = actionElement(change);
        if (actor) replayAnimation(actor, change.kind === "defense" ? "is-defending" : change.kind === "counter" ? "is-countering" : "is-attacking");
      });
    }
    else if (change.type === "retire") enqueueBattleCue({ title: `${change.name} 退場`, side: change.side });
    else if (change.type === "summon") {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.unitId)}"]`)?.classList.add("is-summoned"));
    } else if (change.type === "damage" || change.type === "heal") {
      requestAnimationFrame(() => {
        const target = combatantElement(change);if (!target) return;
        replayAnimation(target, change.type === "damage" ? "is-hit" : "is-healed");
        showFloatingChange(target, change.type, change.amount);
        if (change.type === "damage" && settings.vibration) navigator.vibrate?.(35);
      });
    }
  }
}
function updateState(nextState: SessionState): void {
  const changes = deriveBattleVisualChanges(state, nextState);
  state = nextState;
  if (nextState.reconnectToken) localStorage.setItem(TOKEN_KEY, nextState.reconnectToken);
  render();
  animateBattleChanges(changes);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}
function loadSettings(): Settings {
  try {
    return { bgm: 60, sound: 70, vibration: true, speed: "normal", log: true,
      ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch { return { bgm: 60, sound: 70, vibration: true, speed: "normal", log: true }; }
}
function storeSettings(): void { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function button(label: string, action: string, extra = ""): string {
  return `<button class="menu-button ${extra}" data-action="${action}" ${busy ? "disabled" : ""}>${label}</button>`;
}
function shell(content: string): string {
  return `<section class="screen"><div class="ambient-ring" aria-hidden="true"></div>${content}<footer>五行転輪 <span>●</span> MVP</footer></section>`;
}
function error(): string { return errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : ""; }

function render(): void {
  const phase = state.phase;
  if (screen === "connecting") renderConnecting();
  else if (phase === "room_waiting") renderRoomWaiting();
  else if (phase === "attribute_selection") renderAttributeSelection();
  else if (phase === "attribute_reveal") renderReveal();
  else if (phase === "battle") renderBattle();
  else if (screen === "cpu_setup") renderCpuSetup();
  else if (screen === "online") renderOnline();
  else renderTitle();
  if (dialog) renderDialog();
}
function renderConnecting(): void {
  app.innerHTML = shell(`<div class="center-card"><p class="eyebrow">SERVER CONNECTION</p><h1>五行転輪</h1><div class="loader"></div><h2>サーバーへ接続中</h2><p class="muted">起動待ちの場合も自動で再試行します。</p>${error()}${button("手動で再試行", "retry", "secondary")}</div>`);
}
function renderTitle(): void {
  app.innerHTML = shell(`<header class="title-header"><div class="cycle-mark"><span>木</span><span>火</span><span>土</span><span>金</span><span>水</span></div><p class="eyebrow">GOGYO TENRIN</p><h1>五行転輪</h1><p class="subtitle">巡る霊気を読み、五行を転じよ。</p></header><nav class="menu">${button("CPU戦", "cpu")}${button("オンライン対戦", "online")}${button("ルール確認", "rules", "secondary")}${button("設定", "settings", "secondary")}</nav><p class="connection-ok"><span></span>サーバー接続済み</p>`);
}
function renderCpuSetup(): void {
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">CPU MATCH</p><h1>CPU戦</h1><p>陰陽師名を入力してください。</p></header><form class="form-card" data-form="cpu"><label for="player-name">プレイヤー名</label><input id="player-name" maxlength="20" autocomplete="nickname" placeholder="名前を入力" ${busy ? "disabled" : ""}/>${error()}<button class="menu-button" type="submit" ${busy ? "disabled" : ""}>${busy ? "準備中…" : "対戦準備へ"}</button>${button("戻る", "title", "text")}</form>`);
}
function renderOnline(): void {
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">ONLINE MATCH</p><h1>\u30aa\u30f3\u30e9\u30a4\u30f3\u5bfe\u6226</h1><p>\u90e8\u5c4b\u3092\u4f5c\u6210\u3059\u308b\u304b\u30016\u6587\u5b57\u306e\u90e8\u5c4bID\u3067\u53c2\u52a0\u3057\u307e\u3059\u3002</p></header><div class="online-grid"><form class="form-card" data-form="room-create"><h2>\u90e8\u5c4b\u3092\u4f5c\u308b</h2><label>\u30d7\u30ec\u30a4\u30e4\u30fc\u540d<input name="playerName" maxlength="20" required></label><button class="menu-button" type="submit" ${busy?"disabled":""}>\u4f5c\u6210</button></form><form class="form-card" data-form="room-join"><h2>\u90e8\u5c4b\u306b\u5165\u308b</h2><label>\u30d7\u30ec\u30a4\u30e4\u30fc\u540d<input name="playerName" maxlength="20" required></label><label>\u90e8\u5c4bID<input name="roomId" maxlength="6" autocomplete="off" required></label><button class="menu-button" type="submit" ${busy?"disabled":""}>\u53c2\u52a0</button></form></div>${error()}<nav class="menu">${button("\u623b\u308b","title","text")}</nav>`);
}
function renderRoomWaiting(): void {
  const ready=Boolean(state.roomReady),host=state.role==="host",opponentText=ready?`${escapeHtml(state.opponentName??"")} \u304c\u53c2\u52a0\u3057\u307e\u3057\u305f\u3002`:`\u76f8\u624b\u306e\u53c2\u52a0\u3092\u5f85\u3063\u3066\u3044\u307e\u3059\u3002`;
  const startControl=host?button("\u5bfe\u6226\u958b\u59cb","room-start",ready?"":"disabled"):`<p class="muted center">\u30db\u30b9\u30c8\u306e\u958b\u59cb\u64cd\u4f5c\u3092\u5f85\u3063\u3066\u3044\u307e\u3059\u3002</p>`;
  app.innerHTML=shell(`<header class="compact-header"><p class="eyebrow">ROOM</p><h1>\u5bfe\u6226\u5f85\u6a5f</h1></header><div class="notice-card"><p>\u90e8\u5c4bID</p><h2>${escapeHtml(state.roomId??"")}</h2><p>${opponentText}</p></div>${error()}<div class="menu">${startControl}${button("\u90e8\u5c4b\u3092\u9000\u51fa","room-leave","text")}</div>`);
}
function renderAttributeSelection(): void {
  const choices = Object.entries(elements).map(([key, value]) => `<button class="element-card ${key}" data-element="${key}" ${busy ? "disabled" : ""}><span>${value.mark}</span><strong>${value.name}</strong></button>`).join("");
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">INITIAL ATTRIBUTE</p><h1>初期属性を選択</h1><p>五行から、あなたの最初の属性を選んでください。</p></header><div class="elements">${choices}</div>${error()}<p class="muted center">CPUの属性は選択完了まで公開されません。</p>`);
}
function elementBadge(attribute?: FiveElement): string {
  if (!attribute) return `<span class="attribute unknown">?</span>`;
  return `<span class="attribute ${attribute}">${elements[attribute].mark}</span>`;
}
function renderReveal(): void {
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">ATTRIBUTE REVEAL</p><h1>属性公開</h1></header><div class="versus"><div>${elementBadge(state.playerAttribute)}<strong>${escapeHtml(state.playerName ?? "あなた")}</strong></div><b>対</b><div>${elementBadge(state.cpuAttribute)}<strong>${escapeHtml(state.opponentName ?? "CPU")}</strong></div></div>${error()}<div class="menu">${button("対戦を開始", "enter-match")}</div>`);
}
function renderUnits(units: NonNullable<SessionState["battle"]>["player"]["shikigami"], targetMode?: CardPlayTarget, ignoreTaunt = false, owner: "cpu"|"player" = "cpu"): string {
  const hasTaunt = units.some((unit) => unit.keywords.includes("\u6311\u767a"));
  const slots = Array.from({ length: 3 }, (_, index) => {
    const unit = units[index];
    if (!unit) return `<div class="unit-slot empty">\u7a7a\u304d</div>`;
    const keywords = unit.keywords.length > 0 ? `<small>${unit.keywords.map(escapeHtml).join("?")}</small>` : "";
    const oneShotReduction = unit.nextDamageReduction > 0 ? `<span class="unit-effect">\u6b21\u56de\u8efd\u6e1b ${unit.nextDamageReduction}</span>` : "";
    const shellReduction = unit.shellDamageReduction > 0 ? `<span class="unit-effect">\u7532\u7f85\u7c60\u308a ${unit.shellDamageReduction}</span>` : "";
    const enemyTarget = owner==="cpu"&&(targetMode==="cpu_unit"||targetMode==="cpu_any")&&(!unit.keywords.includes("\u30b9\u30c6\u30eb\u30b9")||unit.keywords.includes("\u6311\u767a"))&&(ignoreTaunt||!hasTaunt||unit.keywords.includes("\u6311\u767a"));
    const allyTarget = owner==="player"&&targetMode==="player_unit";
    const target = enemyTarget?`data-target="cpu_unit:${unit.instanceId}"`:allyTarget?`data-target="player_unit:${unit.instanceId}"`:"";
    return `<article class="unit-slot ${cardAttributeClass(unit.attribute)}" data-unit-id="${unit.instanceId}" data-unit-side="${owner}" ${target}><img class="unit-portrait" src="${shikigamiImagePath(unit.imageId)}" alt="" loading="lazy"><div class="unit-shade"></div><strong>${escapeHtml(unit.name)}</strong><span>${escapeHtml(unit.attribute)}</span><b>HP ${unit.hp} / ${unit.maxHp}</b><span>ATK ${unit.attack}</span>${keywords}${renderCurses(unit.curses)}${oneShotReduction}${shellReduction}</article>`;
  }).join("");
  return `<div class="unit-slots">${slots}</div>`;
}
function shikigamiImagePath(imageId: string): string {
  const safeImageId = /^[a-z0-9_]+$/.test(imageId) ? imageId : "img_shikigami_unknown";
  return `/client/assets/shikigami/${safeImageId}.png`;
}
function cardAttributeClass(attribute: string): string {
  return ({ "木": "wood", "火": "fire", "土": "earth", "金": "metal", "水": "water", "無属性": "neutral" } as Record<string, string>)[attribute] ?? "neutral";
}
function renderCurses(curses: { name: string; stacks: number }[]): string {
  if (curses.length === 0) return "";
  return `<div class="curse-row">${curses.map((curse) => `<span>呪い：${escapeHtml(curse.name)}${curse.stacks > 1 ? ` ×${curse.stacks}` : ""}</span>`).join("")}</div>`;
}
function renderBattle(): void {
  const battle = state.battle;
  if (!battle) {
    app.innerHTML = shell(`<div class="notice-card"><h2>対戦状態を取得できません</h2><p>タイトルへ戻って対戦を開始し直してください。</p>${button("タイトルへ戻る", "reset")}</div>`);
    return;
  }
  const cards = battle.player.hand.map((card) => `<button ${battle.pendingDiscard ? `data-discard-instance="${card.instanceId}"` : `data-card-instance="${card.instanceId}"`} class="hand-card ${cardAttributeClass(card.attribute)} ${card.playable ? "" : "unplayable"}"><span class="hand-card-system">${escapeHtml(card.system)}</span><strong>${escapeHtml(card.name.split("：").at(-1) ?? card.name)}</strong><span class="hand-card-attribute">${escapeHtml(card.attribute)}</span><span class="hand-card-cost">C ${card.cost}</span>${card.mpCost > 0 ? `<span class="hand-card-mp">MP ${card.mpCost}</span>` : ""}<small>${escapeHtml(card.effectText)}</small></button>`).join("");
  const pendingCard = battle.player.hand.find((card) => card.instanceId === pendingCardId);
  const pendingTarget = pendingCard?.playTarget;
  const targeting = pendingCard !== undefined;
  const targetLabels: Record<CardPlayTarget, string> = { cpu_player: "Opponent", cpu_unit: "Opponent shikigami", cpu_any: "Opponent or shikigami", cpu_field: "Opponent field", cpu_barrier: "Opponent barrier", player: "Player", player_unit: "Allied shikigami", player_field: "Allied field", player_barrier: "Player barrier", retired_unit: "Retired shikigami", shared_field: "Shared terrain" };
  const retiredTargets = targeting && pendingTarget==="retired_unit" ? battle.player.retiredShikigami.map(unit=>`<button class="menu-button small" data-target="retired_unit:${unit.instanceId}">${escapeHtml(unit.name)} (HP ${unit.maxHp})</button>`).join("") : "";
  const targetGuide = targeting && pendingTarget ? `<div class="target-guide">${targetLabels[pendingTarget]}を選択してください。${button("キャンセル", "cancel-target", "small text")}</div>` : "";
  const opponentHasTaunt = battle.cpu.shikigami.some((unit) => unit.keywords.includes("挑発"));
  const targetAttribute = (target: CardPlayTarget): string => targeting && (pendingTarget === target || (pendingTarget === "cpu_any" && target === "cpu_player")) && !(target === "cpu_player" && opponentHasTaunt && !pendingCard?.ignoreTaunt) ? 'data-target="' + target + '"' : "";
  const log = battle.log.slice(-8).map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
  const finished = battle.phase === "finished";
  const resultActions=state.mode==="online"?`${button("\u518d\u6226\u3092\u7533\u3057\u8fbc\u3080","rematch")}${button("\u518d\u6226\u3092\u3084\u3081\u308b","rematch-cancel","secondary")}`:button("\u518d\u6226","rematch");
  const result = finished ? `<div class="battle-result"><strong>${battle.winner === "player" ? "\u52dd\u5229" : "\u6557\u5317"}</strong><span>\u5bfe\u6226\u304c\u7d42\u4e86\u3057\u307e\u3057\u305f</span><div class="result-actions">${resultActions}</div></div>` : "";
  const canEndTurn = !finished && battle.phase === "card_use" && battle.activePlayer === "player";
  const reaction = battle.reaction;
  const reactionCards = reaction ? battle.player.hand.filter((card) => reaction.eligibleCardIds.includes(card.instanceId)) : [];
  const reactionOptions = reactionCards.map((card) => {
    const isAll = card.target === "自分側全体";
    const choices = isAll || reaction!.targets.length === 1
      ? `<button class="reaction-card" data-reaction-card="${card.instanceId}"><strong>${escapeHtml(card.name.split("：").at(-1) ?? card.name)}</strong><span>${escapeHtml(card.effectText)}</span></button>`
      : reaction!.targets.map((item) => `<button class="reaction-card" data-reaction-card="${card.instanceId}" data-reaction-target="${item.id}"><strong>${escapeHtml(card.name.split("：").at(-1) ?? card.name)} → ${escapeHtml(item.label)}</strong><span>${escapeHtml(card.effectText)}</span></button>`).join("");
    return choices;
  }).join("");
  const pausedPanel = state.connectionPaused ? `<section class="connection-pause"><h2>\u518d\u63a5\u7d9a\u5f85\u6a5f\u4e2d</h2><p>\u76f8\u624b\u306e\u5fa9\u5e30\u3092\u5f85\u3063\u3066\u3044\u307e\u3059\u3002\u5bfe\u6226\u306f\u4e00\u6642\u505c\u6b62\u4e2d\u3067\u3059\u3002</p></section>` : "";
  const reactionPanel = reaction ? `<section class="reaction-panel"><div><p class="eyebrow">REACTION</p><h2>防御・反応受付中</h2><strong>${escapeHtml(reaction.attackerName)}の${escapeHtml(reaction.sourceName)}</strong><p>${reaction.targets.map((item) => `${escapeHtml(item.label)}：予測 ${item.predictedDamage}ダメージ`).join(" / ")}</p><div class="reaction-time">残り <b data-reaction-countdown>${Math.max(0, Math.ceil((reaction.deadline - Date.now()) / 1000))}</b> 秒</div></div><div class="reaction-options">${reactionOptions || '<p class="muted">使用可能な防御札はありません。</p>'}</div><button class="menu-button secondary" data-action="reaction-pass">使用しない</button></section>` : "";
  app.innerHTML = `<section class="battle battle-v2">${pausedPanel}${reactionPanel}<main class="battle-board">
    <header class="battle-player opponent" data-combatant="cpu" ${targetAttribute("cpu_player")}><div><span>${escapeHtml(state.opponentName ?? "CPU")}</span><strong>HP ${battle.cpu.hp}</strong>${renderCurses(battle.cpu.curses)}</div>${elementBadge(state.cpuAttribute)}<div class="resource"><span>MP ${battle.cpu.mp} / 30</span><span>COST ${battle.cpu.cost}</span><span>手札 ${battle.cpu.handCount}</span></div></header>
    <section class="barrier-display ${battle.cpu.barrier ? "" : "is-empty"}" ${targetAttribute("cpu_barrier") || (targeting && pendingCard?.cardId==="card_fuin" && battle.cpu.barrier ? 'data-target="cpu_barrier"' : "")}><span>相手結界</span><strong>${battle.cpu.barrier ? escapeHtml(battle.cpu.barrier.name) : "未設置"}</strong><small>${battle.cpu.barrier ? escapeHtml(battle.cpu.barrier.effectText) : ""}</small></section>
    <section class="field enemy" ${targetAttribute("cpu_field")}><p>相手式神</p>${renderUnits(battle.cpu.shikigami, pendingTarget, pendingCard?.ignoreTaunt, "cpu")}</section>
    <section class="terrain" ${targetAttribute("shared_field")}><span>共有地形</span><strong>${battle.terrain ? escapeHtml(battle.terrain.name) : "通常状態"}</strong><small>${battle.terrain ? escapeHtml(battle.terrain.effectText) : ""}</small><div class="field-ring"></div></section>
    <section class="field ally" ${targetAttribute("player_field")}><p>味方式神</p>${renderUnits(battle.player.shikigami, pendingTarget, false, "player")}</section>
    <section class="barrier-display ${battle.player.barrier ? "" : "is-empty"}" ${targetAttribute("player_barrier")}><span>自分結界</span><strong>${battle.player.barrier ? escapeHtml(battle.player.barrier.name) : "未設置"}</strong><small>${battle.player.barrier ? escapeHtml(battle.player.barrier.effectText) : ""}</small></section>
    <header class="battle-player" data-combatant="player" ${targetAttribute("player") || (targeting && pendingCard?.cardId==="card_joka" ? 'data-target="player"' : "")}><div><span>${escapeHtml(state.playerName ?? "あなた")}</span><strong>HP ${battle.player.hp}</strong>${renderCurses(battle.player.curses)}</div>${elementBadge(state.playerAttribute)}<div class="resource"><span>MP ${battle.player.mp} / 30</span><span>COST ${battle.player.cost}</span><span>捨て札 ${battle.player.discard.length}</span></div></header>
    </main><section class="hand battle-console"><div class="battle-command-row"><div class="phase-label">${finished ? "対戦終了" : `第${battle.turnNumber}ターン・${battle.activePlayer === "player" ? "自分" : "CPU"}・${battle.phase === "reaction" ? "反応受付" : battle.phase === "resolving" ? "処理中" : "カード使用"}`} ${battle.turnDeadline&&!finished?`<span>残り <b data-turn-countdown>${Math.max(0,Math.ceil((battle.turnDeadline-Date.now())/1000))}</b>秒</span>`:""}</div><button class="menu-button end-turn" data-action="end-turn" ${!canEndTurn || busy ? "disabled" : ""}>ターン終了</button></div>${result}${targetGuide}<div class="hand-cards" aria-label="自分の手札">${cards || '<p class="empty-hand">手札がありません。</p>'}</div><div class="battle-utility"><details class="battle-log"><summary>対戦ログ</summary><ol>${log}</ol></details><div class="battle-actions">${button("ルール", "rules", "small secondary")}${button("設定", "settings", "small secondary")}${button("退出", "reset", "small text")}</div></div></section>
  </section>`;
}
function renderDialog(): void {
  let content: string;
  if (dialog === "rules") {
    content = `<h2>基本ルール</h2><p>木・火・土・金・水を巡らせ、カードと式神を用いて相手のHPを0にします。</p><p>ゲーム進行と判定はサーバーが管理します。</p>`;
  } else if (dialog === "card") {
    const card = state.battle?.player.hand.find((item) => item.instanceId === selectedCardId);
    if (!card) { dialog = null; return; }
    const useControl = state.battle?.phase === "reaction"
      ? `<p class="target-guide">反応受付パネルから防御対象を選択してください。</p>`
      : card.playable
      ? `${card.choiceOptions?.length ? `<label>\u9078\u629e <select data-card-choice>${card.choiceOptions.map(option=>`<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select></label>` : ""}<button class="menu-button" data-action="prepare-card">使用する</button>`
      : `<p class="unusable-message">使用不可：${escapeHtml(card.unusableReason ?? "現在は使用できません。")}</p>`;    content = `<div class="card-detail ${cardAttributeClass(card.attribute)}"><p class="eyebrow">${escapeHtml(card.category)} / ${escapeHtml(card.system)}</p><h2>${escapeHtml(card.name)}</h2><div class="card-detail-meta"><span>属性 ${escapeHtml(card.attribute)}</span><span>コスト ${card.cost}</span><span>MP ${card.mpCost}</span></div><h3>効果</h3><p>${escapeHtml(card.effectText)}</p><h3>対象</h3><p>${escapeHtml(card.target)}</p><h3>使用タイミング</h3><p>${escapeHtml(card.timing)}</p><p class="flavor">${escapeHtml(card.flavorText)}</p>${useControl}</div>`;
  } else {
    content = `<h2>設定</h2><label>BGM音量<input type="range" min="0" max="100" value="${settings.bgm}" data-setting="bgm"></label><label>効果音音量<input type="range" min="0" max="100" value="${settings.sound}" data-setting="sound"></label><label class="check"><input type="checkbox" ${settings.vibration ? "checked" : ""} data-setting="vibration">振動</label><label>演出速度 <select data-setting="speed"><option value="slow" ${settings.speed === "slow" ? "selected" : ""}>ゆっくり</option><option value="normal" ${settings.speed === "normal" ? "selected" : ""}>標準</option><option value="fast" ${settings.speed === "fast" ? "selected" : ""}>速い</option></select></label><label class="check"><input type="checkbox" ${settings.log ? "checked" : ""} data-setting="log">対戦ログを表示</label>`;
  }
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal">${content}<button class="menu-button secondary" data-action="close-dialog">閉じる</button></section></div>`);
}

function applyResult(result: ActionResult): void {
  busy = false;
  if (!result.ok) { errorMessage = result.message ?? "処理に失敗しました。"; render(); return; }
  errorMessage = "";
  if (result.state) updateState(result.state); else render();
}
function resumeSession(): void {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { screen = "title"; render(); return; }
  socket.emit("session:resume", token, (result) => {
    if (!result.ok) localStorage.removeItem(TOKEN_KEY);
    screen = "title"; applyResult(result.ok ? result : { ok: true, state: { phase: "title" } });
  });
}

socket.on("connect", () => { errorMessage = ""; resumeSession(); });
socket.on("connect_error", () => { screen = "connecting"; errorMessage = "サーバーへ接続できません。再試行しています。"; render(); });
socket.on("session:state", updateState);
socket.io.on("reconnect_attempt", () => { screen = "connecting"; render(); });

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  const cardInstanceId = target.closest<HTMLElement>("[data-card-instance]")?.dataset.cardInstance;
  const discardInstanceId = target.closest<HTMLElement>("[data-discard-instance]")?.dataset.discardInstance;
  const reactionCard = target.closest<HTMLElement>("[data-reaction-card]")?.dataset.reactionCard;
  const reactionTarget = target.closest<HTMLElement>("[data-reaction-target]")?.dataset.reactionTarget as DefenseTarget | undefined;
  const targetType = target.closest<HTMLElement>("[data-target]")?.dataset.target as CardTarget | undefined;
  const attribute = target.closest<HTMLElement>("[data-element]")?.dataset.element as FiveElement | undefined;
  if(discardInstanceId && state.battle?.pendingDiscard && !busy){busy=true;render();socket.emit("card:discard",{instanceId:discardInstanceId},applyResult);return;}
  if (reactionCard && !busy) {
    busy = true; render(); socket.emit("reaction:respond", { instanceId: reactionCard, target: reactionTarget }, applyResult); return;
  }  if (targetType && pendingCardId && !busy) {
    const instanceId = pendingCardId;
    const usedCard = state.battle?.player.hand.find((card) => card.instanceId === instanceId);
    enqueueBattleCue({ title: "術式発動", detail: usedCard?.name, side: "player" });
    requestAnimationFrame(() => {
      const actor = document.querySelector<HTMLElement>('[data-combatant="player"]');
      if (actor) replayAnimation(actor, "is-attacking");
    });
    busy = true;
    render();
    socket.emit("card:use", { instanceId, target: targetType, choice: selectedChoice }, (result) => {
      if (result.ok) { pendingCardId = null; selectedCardId = null; selectedChoice = undefined; }
      applyResult(result);
    });
    return;
  }
  if (cardInstanceId && !busy && !pendingCardId) { selectedCardId = cardInstanceId; dialog = "card"; render(); return; }
  if (attribute && !busy) { busy = true; render(); socket.emit("attribute:select", { attribute }, applyResult); return; }
  if (!action || busy) return;
  if (action === "retry") socket.connect();
  else if (action === "cpu") { screen = "cpu_setup"; errorMessage = ""; render(); }
  else if (action === "online") { screen = "online"; render(); }
  else if (action === "title") { screen = "title"; render(); }
  else if (action === "rules" || action === "settings") { dialog = action; render(); }
  else if (action === "close-dialog") { dialog = null; selectedCardId = null; render(); }
  else if (action === "prepare-card" && selectedCardId) { const card=state.battle?.player.hand.find(item=>item.instanceId===selectedCardId); selectedChoice=(document.querySelector<HTMLSelectElement>("[data-card-choice]")?.value ?? card?.choiceOptions?.[0]?.value); pendingCardId = selectedCardId; dialog = null; render(); }
  else if (action === "cancel-target") { pendingCardId = null; selectedCardId = null; render(); }
  else if (action === "room-start") { busy=true; render(); socket.emit("room:start",applyResult); }
  else if (action === "room-leave") { busy=true; localStorage.removeItem(TOKEN_KEY); socket.emit("room:leave",(result)=>{screen="title";applyResult(result);}); }
  else if (action === "rematch") { busy=true; render(); socket.emit("rematch:request",applyResult); }
  else if (action === "rematch-cancel") { busy=true; render(); socket.emit("rematch:cancel",applyResult); }
  else if (action === "enter-match") { busy = true; render(); socket.emit("match:enter", applyResult); }
  else if (action === "reaction-pass") { busy = true; render(); socket.emit("reaction:respond", {}, applyResult); }
  else if (action === "end-turn") { busy = true; pendingCardId = null; selectedCardId = null; enqueueBattleCue({ title: "CPUのターン", detail: "相手が行動中", side: "cpu" }); render(); socket.emit("turn:end", applyResult); }
  else if (action === "reset") { busy = true; pendingCardId = null; selectedCardId = null; localStorage.removeItem(TOKEN_KEY); socket.emit("session:reset", (result) => { screen = "title"; applyResult(result); }); }
});
app.addEventListener("submit", (event) => {
  const form=event.target as HTMLFormElement;event.preventDefault();
  const playerName=form.querySelector<HTMLInputElement>('[name="playerName"],#player-name')?.value??"";
  if(form.dataset.form==="cpu"){busy=true;render();socket.emit("cpu:start",{playerName},applyResult);return}
  if(form.dataset.form==="room-create"){busy=true;render();socket.emit("room:create",{playerName},applyResult);return}
  if(form.dataset.form==="room-join"){const roomId=form.querySelector<HTMLInputElement>('[name="roomId"]')?.value??"";busy=true;render();socket.emit("room:join",{playerName,roomId},applyResult)}
});
app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const key = input.dataset.setting;
  if (!key) return;
  if (key === "bgm") settings.bgm = Number(input.value);
  if (key === "sound") settings.sound = Number(input.value);
  if (key === "vibration" && input instanceof HTMLInputElement) settings.vibration = input.checked;
  if (key === "speed") settings.speed = input.value;
  if (key === "log" && input instanceof HTMLInputElement) settings.log = input.checked;
  storeSettings();
});

render();
socket.connect();
setInterval(() => { const reactionCountdown=document.querySelector<HTMLElement>('[data-reaction-countdown]'),turnCountdown=document.querySelector<HTMLElement>('[data-turn-countdown]'),reactionDeadline=state.battle?.reaction?.deadline,turnDeadline=state.battle?.turnDeadline;if(reactionCountdown&&reactionDeadline)reactionCountdown.textContent=String(Math.max(0,Math.ceil((reactionDeadline-Date.now())/1000)));if(turnCountdown&&turnDeadline)turnCountdown.textContent=String(Math.max(0,Math.ceil((turnDeadline-Date.now())/1000))); },250);
