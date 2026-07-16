import {
  type ActionResult,
  type CardCatalogItem,
  type CardView,
  type CardPlayTarget,
  type CardTarget,
  type CpuCardPoolMode,
  type DefenseTarget,
  type FiveElement,
  type SessionState,
} from "../shared/protocol.js";
import { deriveBattleVisualChanges, orderBattleVisualChanges, type BattleSide, type BattleVisualChange } from "./battle-animations.js";
import { ATTRIBUTE_MATCH_BONUS, ATTRIBUTE_OVERCOME_BONUS, MAX_PLAYER_HP, MAX_PLAYER_MP } from "../shared/game-balance.js";

type Acknowledge = (result: ActionResult) => void;
interface BrowserSocket {
  on(event: "connect", listener: () => void): void;
  on(event: "connect_error", listener: () => void): void;
  on(event: "session:state", listener: (state: SessionState) => void): void;
  emit(event: "session:resume", token: string, callback: Acknowledge): void;
  emit(event: "cpu:start", payload: { playerName: string; poolMode: CpuCardPoolMode }, callback: Acknowledge): void;
  emit(event: "room:create", payload: { playerName: string }, callback: Acknowledge): void;
  emit(event: "room:join", payload: { playerName: string; roomId: string }, callback: Acknowledge): void;
  emit(event: "attribute:select", payload: { attribute: FiveElement }, callback: Acknowledge): void;
  emit(event: "match:enter" | "session:reset", callback: Acknowledge): void;
  emit(event: "card:use", payload: { instanceId: string; target: CardTarget; choice?: string }, callback: Acknowledge): void;
  emit(event: "card:discard", payload: { instanceId: string }, callback: Acknowledge): void;
  emit(event: "reaction:respond", payload: { instanceId?: string; target?: DefenseTarget }, callback: Acknowledge): void;
  emit(event: "turn:end" | "room:start" | "room:leave" | "rematch:request" | "rematch:cancel", callback: Acknowledge): void;
  emit(event: "presentation:complete"): void;
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

type LocalScreen = "connecting" | "title" | "cpu_mode" | "cpu_setup" | "online";
type CpuExperienceMode = "battle" | "full" | "tutorial";
type Dialog = "rules" | "settings" | "card" | "catalog" | "catalog_card" | null;
interface Settings { bgm: number; sound: number; vibration: boolean; speed: string; log: boolean }
let screen: LocalScreen = "connecting";
let dialog: Dialog = null;
let selectedCardId: string | null = null;
let selectedCatalogCardId: string | null = null;
let expandedEffectCardId: string | null = null;
let pendingCardId: string | null = null;
let selectedChoice: string | undefined;
let state: SessionState = { phase: "title" };
let busy = false;
let errorMessage = "";
let settings: Settings = loadSettings();
let cardCatalog: CardCatalogItem[] = [];
let catalogLoading = true;
let catalogError = "";
let longPressTimer: number | undefined;
let longPressOrigin: { x: number; y: number } | null = null;
let tutorialStep: number | null = null;
let cpuExperienceMode: CpuExperienceMode = "battle";
let reactionSubmitting = false;
let submittedReactionDeadline: number | undefined;
let reactionRevealTimer: number | undefined;
interface BattleCue { title: string; detail?: string; side?: BattleSide; key?: string; duration?: number; variant?: string; onShow?: () => void; onComplete?: () => void }
const battleCueQueue: BattleCue[] = [];
let battleCuePlaying = false;
let activeBattleCueKey: string | undefined;
let battlePresentationGeneration = 0;
let pendingPresentationState: SessionState | null = null;
let presentationBlockedByReaction = false;
let presentationCompletionPending = false;

function battlePresentationLocked(): boolean {
  return battleCuePlaying || battleCueQueue.length > 0;
}
function clearCardSelection(): void {
  pendingCardId = null;
  selectedCardId = null;
  selectedChoice = undefined;
}
async function loadCardCatalog(): Promise<void> {
  catalogLoading = true;
  catalogError = "";
  try {
    const response = await fetch("/api/cards");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { cards?: CardCatalogItem[] };
    if (!Array.isArray(payload.cards)) throw new Error("Invalid card catalog response");
    cardCatalog = payload.cards;
  } catch {
    catalogError = "カード一覧を取得できませんでした。";
  } finally {
    catalogLoading = false;
    if (dialog === "catalog") render();
  }
}
void loadCardCatalog();
function syncBattlePresentationLock(): void {
  document.body.classList.toggle("battle-presentation-locked", battlePresentationLocked());
}
function cancelBattlePresentation(): void {
  battlePresentationGeneration += 1;
  battleCueQueue.length = 0;
  battleCuePlaying = false;
  activeBattleCueKey = undefined;
  pendingPresentationState = null;
  presentationCompletionPending = false;
  document.querySelectorAll(".battle-cue-layer,.card-effect-layer,.battle-floating-change,.shikigami-retire-layer,.reidan-projectile").forEach((element) => element.remove());
  syncBattlePresentationLock();
}

function animationDuration(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 80;
  return settings.speed === "fast" ? 650 : settings.speed === "slow" ? 1500 : 1000;
}
function presentationGap(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  return settings.speed === "fast" ? 50 : settings.speed === "slow" ? 220 : 120;
}
function impactDuration(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 120;
  return animationDuration() + 260;
}
function retirementDuration(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 160;
  return animationDuration() + 520;
}
function enqueueBattleCue(cue: BattleCue): void {
  if (presentationBlockedByReaction) return;
  if (cue.key && (activeBattleCueKey === cue.key || battleCueQueue.some((queued) => queued.key === cue.key))) return;
  if (dialog === "card" || dialog === "catalog_card") {
    dialog = null;
    selectedCardId = null;
    selectedCatalogCardId = null;
    expandedEffectCardId = null;
    document.querySelector(".modal-backdrop")?.remove();
  }
  battleCueQueue.push(cue);
  playNextBattleCue();
}
function applyDisplayedState(nextState: SessionState): void {
  let selectionError: string | undefined;
  state = nextState;
  if (nextState.battle?.phase !== "reaction") {
    reactionSubmitting = false;
    submittedReactionDeadline = undefined;
  }
  if (pendingCardId) {
    const pending = nextState.battle?.player.hand.find((card) => card.instanceId === pendingCardId);
    if (!pending?.playable) {
      clearCardSelection();
      selectionError = pending?.unusableReason ?? "選択可能な対象がなくなりました。";
      errorMessage = selectionError;
    }
  }
  if (nextState.reconnectToken) localStorage.setItem(TOKEN_KEY, nextState.reconnectToken);
  render();
  if (selectionError) enqueueBattleCue({ title: "対象を選べません", detail: selectionError, side: "player" });
}
function revealPendingPresentationState(): void {
  const nextState = pendingPresentationState;
  pendingPresentationState = null;
  if (nextState) applyDisplayedState(nextState);
  syncBattlePresentationLock();
}
function commitPendingPresentationState(): void {
  revealPendingPresentationState();
  if (presentationCompletionPending) {
    presentationCompletionPending = false;
    socket.emit("presentation:complete");
  }
}
function playNextBattleCue(): void {
  if (presentationBlockedByReaction) {
    battleCueQueue.length = 0;
    battleCuePlaying = false;
    activeBattleCueKey = undefined;
    syncBattlePresentationLock();
    return;
  }
  if (battleCuePlaying) {
    syncBattlePresentationLock();
    return;
  }
  if (battleCueQueue.length === 0) {
    commitPendingPresentationState();
    return;
  }
  battleCuePlaying = true;
  const generation = battlePresentationGeneration;
  syncBattlePresentationLock();
  const cue = battleCueQueue.shift()!;
  activeBattleCueKey = cue.key;
  const layer = document.createElement("div");
  layer.className = `battle-cue-layer ${cue.side ?? "neutral"} ${cue.variant ?? ""}`;
  const panel = document.createElement("div");
  panel.className = "battle-cue";
  const title = document.createElement("strong");
  title.textContent = cue.title;
  panel.append(title);
  if (cue.detail) { const detail = document.createElement("span"); detail.textContent = cue.detail; panel.append(detail); }
  layer.append(panel);document.body.append(layer);
  cue.onShow?.();
  const duration = cue.duration ?? animationDuration();
  window.setTimeout(() => { if (generation === battlePresentationGeneration) layer.classList.add("leaving"); }, Math.max(40, duration - 160));
  window.setTimeout(() => {
    layer.remove();
    if (generation !== battlePresentationGeneration) return;
    cue.onComplete?.();
    battleCuePlaying = false;activeBattleCueKey = undefined;
    if (battleCueQueue.length > 0) window.setTimeout(() => {
      if (generation === battlePresentationGeneration && !presentationBlockedByReaction) playNextBattleCue();
    }, presentationGap());
    else commitPendingPresentationState();
  }, duration);
}
function runPresentationFrame(callback: () => void): void {
  const generation = battlePresentationGeneration;
  requestAnimationFrame(() => {
    if (generation !== battlePresentationGeneration || presentationBlockedByReaction) return;
    callback();
  });
}
function combatantElement(change: Extract<BattleVisualChange, { type: "damage" | "heal" }>): HTMLElement | null {
  if (change.unitId) return document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.unitId)}"]`);
  return document.querySelector<HTMLElement>(`[data-combatant="${change.side}"]`);
}
function actionElement(change: Extract<BattleVisualChange, { type: "action" }>): HTMLElement | null {
  if (change.actorUnitId) return document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.actorUnitId)}"]`);
  return document.querySelector<HTMLElement>(`[data-combatant="${change.side}"]`);
}
function actionTargetElement(change: Extract<BattleVisualChange, { type: "action" }>): HTMLElement | null {
  if (change.targetUnitId) return document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.targetUnitId)}"]`);
  const targetSide = change.side === "player" ? "cpu" : "player";
  return document.querySelector<HTMLElement>(`[data-combatant="${targetSide}"]`);
}
function showReidanProjectile(change: Extract<BattleVisualChange, { type: "action" }>): void {
  const actor = actionElement(change);
  const target = actionTargetElement(change);
  if (!actor || !target) return;
  const start = actor.getBoundingClientRect();
  const end = target.getBoundingClientRect();
  const startX = start.left + start.width / 2;
  const startY = start.top + start.height / 2;
  const endX = end.left + end.width / 2;
  const endY = end.top + Math.min(end.height / 2, 56);
  const orb = document.createElement("span");
  orb.className = `reidan-projectile ${change.side}`;
  orb.style.left = `${startX}px`;
  orb.style.top = `${startY}px`;
  document.body.append(orb);
  const flight = orb.animate([
    { transform: "translate(-50%, -50%) scale(.25)", opacity: 0 },
    { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: .16 },
    { transform: `translate(calc(-50% + ${endX - startX}px), calc(-50% + ${endY - startY}px)) scale(.72)`, opacity: 1, offset: .86 },
    { transform: `translate(calc(-50% + ${endX - startX}px), calc(-50% + ${endY - startY}px)) scale(1.7)`, opacity: 0 },
  ], { duration: Math.max(420, animationDuration() * .86), easing: "cubic-bezier(.2,.72,.25,1)" });
  flight.finished.finally(() => orb.remove());
}
const systemEffects: Record<string, { className: string; glyph: string; title: string }> = {
  "占事略决": { className: "cycle", glyph: "転", title: "五行転輪" },
  "霊符術": { className: "talisman", glyph: "符", title: "霊符発動" },
  "陰陽秘術": { className: "mystic", glyph: "陰", title: "秘術発動" },
  "使役術": { className: "summoning", glyph: "契", title: "使役術発動" },
  "結界術": { className: "barrier", glyph: "界", title: "結界展開" },
  "地脈術": { className: "terrain", glyph: "脈", title: "地脈変転" },
  "禁術": { className: "forbidden", glyph: "禁", title: "禁術発動" },
};
function showSystemEffect(change: Extract<BattleVisualChange, { type: "action" }>): void {
  if (presentationBlockedByReaction) return;
  if (!change.system) return;
  const effect = systemEffects[change.system];
  if (!effect) return;
  const duration = Math.max(700, animationDuration());
  const layer = document.createElement("div");
  layer.className = `card-effect-layer ${effect.className} ${change.side}`;
  layer.style.setProperty("--effect-duration", `${duration}ms`);
  layer.innerHTML = `<div class="card-effect-sigil"><i></i><b>${effect.glyph}</b><span>${effect.title}</span></div>`;
  document.body.append(layer);
  window.setTimeout(() => layer.remove(), duration + 80);
}
function actionCueTitle(change: Extract<BattleVisualChange, { type: "action" }>): string {
  if (change.kind === "defense") return "防御発動";
  if (change.kind === "counter") return "反撃";
  if (change.kind === "attack") return change.side === "player" ? "攻撃" : "相手の攻撃";
  return change.system ? systemEffects[change.system]?.title ?? "術式発動" : "効果発動";
}
function replayAnimation(target: HTMLElement, className: string): void {
  const duration = Math.max(560, animationDuration() * .82);
  target.classList.remove(className);
  target.style.setProperty("--combat-duration", `${duration}ms`);
  void target.offsetWidth;
  target.classList.add(className);
  window.setTimeout(() => {
    target.classList.remove(className);
    target.style.removeProperty("--combat-duration");
  }, duration + 120);
}
function showFloatingChange(target: HTMLElement, type: "damage" | "heal", amount: number, duration: number): void {
  const rect = target.getBoundingClientRect();
  const number = document.createElement("span");
  number.className = `battle-floating-change ${type}`;
  number.textContent = `${type === "damage" ? "-" : "+"}${amount}`;
  number.style.left = `${rect.left + rect.width / 2}px`;
  number.style.top = `${rect.top + Math.min(rect.height * .45, 54)}px`;
  number.style.setProperty("--impact-duration", `${duration}ms`);
  document.body.append(number);
  window.setTimeout(() => number.remove(), duration);
}
function showRetireEffect(change: Extract<BattleVisualChange, { type: "summon" | "retire" }>, duration: number): void {
  const layer = document.createElement("div");
  layer.className = `shikigami-retire-layer ${change.side}`;
  layer.style.setProperty("--effect-duration", `${duration}ms`);
  const portrait = change.imageId
    ? `<img src="${shikigamiImagePath(change.imageId)}" alt="">`
    : `<span class="retire-fallback">${escapeHtml(change.name.slice(0, 1))}</span>`;
  layer.innerHTML = `<div class="retire-portrait">${portrait}<i></i><i></i><i></i></div><strong>${escapeHtml(change.name)}</strong><small>退場</small>`;
  document.body.append(layer);
  window.setTimeout(() => layer.remove(), duration);
}
function animateBattleChanges(changes: BattleVisualChange[]): void {
  const orderedChanges = orderBattleVisualChanges(changes);
  const retirementReveal = orderedChanges.find((change) => change.type === "retire");
  const resultReveal = retirementReveal ?? orderedChanges.find((change) =>
    change.type === "summon" || change.type === "damage" || change.type === "heal" || change.type === "turn",
  );
  const actionReveal = resultReveal ? undefined : [...orderedChanges].reverse().find((change) => change.type === "action");
  const revealIfNeeded = (change: BattleVisualChange): void => {
    if (change === resultReveal) revealPendingPresentationState();
  };
  for (const change of orderedChanges) {
    if (change.type === "battle_start") enqueueBattleCue({ title: "対戦開始", detail: change.side === "player" ? "自分のターン" : "相手のターン", side: change.side, key: "battle-start", duration: animationDuration() + 360 });
    else if (change.type === "turn") enqueueBattleCue({ title: change.side === "player" ? "自分のターン" : "相手のターン", detail: `第${change.turnNumber}ターン・手札更新`, side: change.side, key: `turn:${change.turnNumber}:${change.side}`, duration: animationDuration() + 360 });
    else if (change.type === "action") {
      const title = actionCueTitle(change);
      enqueueBattleCue({ title, detail: change.text, side: change.side, duration: animationDuration() + 320, onComplete: change === actionReveal ? revealPendingPresentationState : undefined, onShow: () => runPresentationFrame(() => {
          const actor = actionElement(change);
          if (actor) replayAnimation(actor, change.kind === "defense" ? "is-defending" : change.kind === "counter" ? "is-countering" : change.kind === "attack" ? "is-attacking" : "is-casting");
          showSystemEffect(change);
          if (change.kind === "attack" && /霊弾/.test(change.text)) showReidanProjectile(change);
        }),
      });
    }
    else if (change.type === "retire") {
      const duration = retirementDuration();
      enqueueBattleCue({ title: `${change.name} 退場`, detail: "式神が場を離れました", side: change.side, duration, variant: "retirement", onShow: () => { revealIfNeeded(change); showRetireEffect(change, duration); } });
    }
    else if (change.type === "summon") {
      enqueueBattleCue({ title: `${change.name} 顕現`, detail: "式神を召喚しました", side: change.side, duration: animationDuration() + 360, variant: "summon", onShow: () => { revealIfNeeded(change); runPresentationFrame(() => {
        const target = document.querySelector<HTMLElement>(`[data-unit-id="${CSS.escape(change.unitId)}"]`);
        if (target) replayAnimation(target, "is-summoned");
      }); } });
    } else if (change.type === "damage" || change.type === "heal") {
      const duration = impactDuration();
      const targetName = change.name ?? (change.side === "player" ? "自分プレイヤー" : "相手プレイヤー");
      enqueueBattleCue({ title: change.type === "damage" ? `${change.amount} ダメージ` : `${change.amount} 回復`, detail: targetName, side: change.side, duration, variant: `impact ${change.type}`, onShow: () => { revealIfNeeded(change); runPresentationFrame(() => {
        const target = combatantElement(change);if (!target) return;
        replayAnimation(target, change.type === "damage" ? "is-hit" : "is-healed");
        showFloatingChange(target, change.type, change.amount, duration);
        if (change.type === "damage" && settings.vibration) navigator.vibrate?.(35);
      }); } });
    }
  }
}
function updateState(nextState: SessionState): void {
  if (nextState.reconnectToken) localStorage.setItem(TOKEN_KEY, nextState.reconnectToken);
  const baselineState = pendingPresentationState ?? state;
  const changes = deriveBattleVisualChanges(baselineState, nextState);
  const enteringReaction = nextState.phase === "battle" && nextState.battle?.phase === "reaction";
  const isNextReaction = enteringReaction && reactionSubmitting
    && nextState.battle?.reaction?.deadline !== submittedReactionDeadline;
  if (isNextReaction) {
    if (reactionRevealTimer !== undefined) window.clearTimeout(reactionRevealTimer);
    reactionRevealTimer = window.setTimeout(() => {
      reactionSubmitting = false;
      submittedReactionDeadline = undefined;
      reactionRevealTimer = undefined;
      render();
    }, 360);
  }
  if (!enteringReaction && baselineState.battle?.phase === "reaction") {
    reactionSubmitting = true;
    document.querySelector(".reaction-panel")?.remove();
  }
  presentationBlockedByReaction = enteringReaction;
  const enteringBattle = baselineState.phase !== "battle" && nextState.phase === "battle";
  if (enteringBattle && nextState.mode === "cpu" && cpuExperienceMode === "tutorial") tutorialStep = 0;
  if (enteringReaction || nextState.phase !== "battle") {
    cancelBattlePresentation();
    applyDisplayedState(nextState);
    return;
  }
  if (enteringBattle) {
    applyDisplayedState(nextState);
    animateBattleChanges(changes);
    return;
  }
  if (changes.length === 0) {
    if (battlePresentationLocked() || pendingPresentationState) pendingPresentationState = nextState;
    else {
      applyDisplayedState(nextState);
      socket.emit("presentation:complete");
    }
    return;
  }
  pendingPresentationState = nextState;
  presentationCompletionPending = true;
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
function shell(content: string, screenClass = ""): string {
  return `<section class="screen ${screenClass}"><div class="ambient-ring" aria-hidden="true"></div>${content}<footer>五行転輪</footer></section>`;
}
function error(): string { return errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : ""; }

const uiMessageTranslations: Record<string, string> = {
  "Cards cannot be used now.": "現在はカードを使用できません。",
  "Invalid target.": "その対象は選べません。",
  "Invalid target or choice.": "対象または選択内容が無効です。",
  "It is not your card-use phase.": "現在はあなたのカード使用フェーズではありません。",
  "It is not your turn.": "現在はあなたのターンではありません。",
  "No resumable match was found.": "復帰できる対戦が見つかりませんでした。",
  "Enter a player name.": "プレイヤー名を入力してください。",
  "The room is unavailable.": "この部屋には参加できません。",
  "The room cannot start yet.": "まだ対戦を開始できません。",
  "Attributes cannot be selected now.": "現在は属性を選択できません。",
  "Invalid attribute.": "選択した属性が無効です。",
  "The match cannot be entered.": "対戦へ進めません。",
  "Match data is unavailable or paused.": "対戦情報を利用できないか、対戦が一時停止中です。",
  "No discard is pending.": "現在は捨て札を選ぶ必要がありません。",
  "The card is not in hand.": "そのカードは手札にありません。",
  "A rematch cannot be requested now.": "現在は再戦を申し込めません。",
  "No online room is active.": "参加中のオンライン部屋がありません。",
};
function localizeUiMessage(message: string): string {
  return uiMessageTranslations[message] ?? message;
}
function localizeBattleLogEntry(entry: string): string {
  return entry
    .replaceAll("Normal attack", "通常攻撃")
    .replaceAll("Turn time expired.", "制限時間が終了しました。")
    .replaceAll("A player left the match.", "プレイヤーが対戦から退出しました。")
    .replaceAll("Reconnect timeout. The connected player wins.", "再接続の制限時間を超えたため、接続中のプレイヤーが勝利しました。")
    .replaceAll("Host", "部屋主")
    .replaceAll("Guest", "参加者");
}

function render(): void {
  const phase = state.phase;
  if (screen === "connecting") renderConnecting();
  else if (phase === "room_waiting") renderRoomWaiting();
  else if (phase === "attribute_selection") renderAttributeSelection();
  else if (phase === "attribute_reveal") renderReveal();
  else if (phase === "battle") renderBattle();
  else if (screen === "cpu_mode") renderCpuMode();
  else if (screen === "cpu_setup") renderCpuSetup();
  else if (screen === "online") renderOnline();
  else renderTitle();
  if (dialog) renderDialog();
}
function renderConnecting(): void {
  app.innerHTML = shell(`<div class="center-card"><p class="eyebrow">霊脈接続</p><h1>五行転輪</h1><div class="loader"></div><h2>サーバーへ接続中</h2><p class="muted">起動待ちの場合も自動で再試行します。</p>${error()}${button("手動で再試行", "retry", "secondary")}</div>`);
}
function renderTitle(): void {
  app.innerHTML = shell(`<div class="title-lobby">
    <section class="title-hero" aria-label="五行転輪">
      <div class="title-mist" aria-hidden="true"></div>
      <div class="title-gallery" aria-label="五行を象徴する式神">
        <figure class="title-slide title-slide-wood"><img src="/client/assets/shikigami/img_shikigami_kanko.png" alt="木属性の式神・管狐"><figcaption><span>木</span><b>管狐</b></figcaption></figure>
        <figure class="title-slide title-slide-fire"><img src="/client/assets/shikigami/img_shikigami_hinotori.png" alt="火属性の式神・火鳥"><figcaption><span>火</span><b>火鳥</b></figcaption></figure>
        <figure class="title-slide title-slide-earth"><img src="/client/assets/shikigami/img_shikigami_genki.png" alt="土属性の式神・玄亀"><figcaption><span>土</span><b>玄亀</b></figcaption></figure>
        <figure class="title-slide title-slide-metal"><img src="/client/assets/shikigami/img_shikigami_hakuro.png" alt="金属性の式神・白狼"><figcaption><span>金</span><b>白狼</b></figcaption></figure>
        <figure class="title-slide title-slide-water"><img src="/client/assets/shikigami/img_shikigami_kappa.png" alt="水属性の式神・河童"><figcaption><span>水</span><b>河童</b></figcaption></figure>
      </div>
      <div class="five-star" aria-label="五行の相生円環と相剋五芒星">
        <svg viewBox="0 0 200 200" role="img" aria-hidden="true">
          <circle class="five-star-cycle" cx="100" cy="100" r="88"></circle>
          <polyline class="five-star-overcome" points="100,12 152.9,172.8 14.4,72.2 185.6,72.2 47.1,172.8 100,12"></polyline>
          <circle class="five-star-inner" cx="100" cy="100" r="41"></circle>
        </svg>
        <span class="five-node five-node-wood">木</span><span class="five-node five-node-fire">火</span><span class="five-node five-node-earth">土</span><span class="five-node five-node-metal">金</span><span class="five-node five-node-water">水</span>
        <div class="five-star-core"><small>五行</small><b>転輪</b></div>
      </div>
      <header class="title-brand"><p class="eyebrow">五行の巡り</p><h1>五行転輪</h1><p>巡る霊気を読み、五行を転じよ。</p></header>
    </section>
    <nav class="title-menu" aria-label="メインメニュー">
      <div class="title-primary-actions">
        <button class="title-action title-action-primary" data-action="cpu"><span>CPU戦</span><small>一人で五行を巡る</small></button>
        <button class="title-action title-action-primary" data-action="online"><span>オンライン対戦</span><small>陰陽師と相対する</small></button>
      </div>
      <div class="title-utility-actions">
        <button class="title-action" data-action="rules"><span>ルール</span></button>
        <button class="title-action" data-action="catalog"><span>カード一覧</span></button>
        <button class="title-action" data-action="settings"><span>設定</span></button>
      </div>
    </nav>
    <p class="connection-ok title-connection"><span></span>霊脈接続済み</p>
  </div>`, "title-screen");
}
function renderCpuSetup(): void {
  const tutorial = cpuExperienceMode === "tutorial";
  const full = cpuExperienceMode === "full";
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">${tutorial ? "指南の準備" : "対戦準備"}</p><h1>${tutorial ? "チュートリアル" : full ? "総合対戦" : "基本対戦"}</h1><p>${tutorial ? "案内に沿って基本操作と五行を学びます。" : full ? "すべての術を使う従来の対戦です。" : "攻撃・防御・転輪・式神召喚に絞って対戦します。"}</p></header><form class="form-card" data-form="cpu"><label for="player-name">プレイヤー名</label><input id="player-name" maxlength="20" autocomplete="nickname" placeholder="名前を入力" ${busy ? "disabled" : ""}/>${error()}<button class="menu-button" type="submit" ${busy ? "disabled" : ""}>${busy ? "準備中…" : tutorial ? "指南を始める" : "対戦を始める"}</button>${button("戻る", "cpu-mode", "text")}</form>`);
}
function renderCpuMode(): void {
  app.innerHTML = shell(`<header class="compact-header cpu-mode-heading"><p class="eyebrow">一人用</p><h1>CPU戦</h1><p>遊び方を選んでください。</p></header><div class="cpu-mode-menu">
    <button class="cpu-mode-card" data-action="cpu-battle"><span>おすすめ</span><strong>基本対戦</strong><p>攻撃・防御・転輪・式神召喚に絞った、直感的な対戦です。</p></button>
    <button class="cpu-mode-card" data-action="cpu-full"><span>すべての術</span><strong>総合対戦</strong><p>結界・地形・呪い・禁術を含む、従来の全カード対戦です。</p></button>
    <button class="cpu-mode-card tutorial" data-action="cpu-tutorial"><span>初めての方へ</span><strong>チュートリアル</strong><p>基本対戦のカードで、操作と五行を順番に学びます。</p></button>
  </div>${button("タイトルへ戻る", "title", "text")}`, "cpu-mode-screen");
}
function renderOnline(): void {
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">オンライン対戦</p><h1>\u30aa\u30f3\u30e9\u30a4\u30f3\u5bfe\u6226</h1><p>\u90e8\u5c4b\u3092\u4f5c\u6210\u3059\u308b\u304b\u30016\u6587\u5b57\u306e\u90e8\u5c4bID\u3067\u53c2\u52a0\u3057\u307e\u3059\u3002</p></header><div class="online-grid"><form class="form-card" data-form="room-create"><h2>\u90e8\u5c4b\u3092\u4f5c\u308b</h2><label>\u30d7\u30ec\u30a4\u30e4\u30fc\u540d<input name="playerName" maxlength="20" required></label><button class="menu-button" type="submit" ${busy?"disabled":""}>\u4f5c\u6210</button></form><form class="form-card" data-form="room-join"><h2>\u90e8\u5c4b\u306b\u5165\u308b</h2><label>\u30d7\u30ec\u30a4\u30e4\u30fc\u540d<input name="playerName" maxlength="20" required></label><label>\u90e8\u5c4bID<input name="roomId" maxlength="6" autocomplete="off" required></label><button class="menu-button" type="submit" ${busy?"disabled":""}>\u53c2\u52a0</button></form></div>${error()}<nav class="menu">${button("\u623b\u308b","title","text")}</nav>`);
}
function renderRoomWaiting(): void {
  const ready=Boolean(state.roomReady),host=state.role==="host",opponentText=ready?`${escapeHtml(state.opponentName??"")} \u304c\u53c2\u52a0\u3057\u307e\u3057\u305f\u3002`:`\u76f8\u624b\u306e\u53c2\u52a0\u3092\u5f85\u3063\u3066\u3044\u307e\u3059\u3002`;
  const startControl=host?button("\u5bfe\u6226\u958b\u59cb","room-start",ready?"":"disabled"):`<p class="muted center">\u30db\u30b9\u30c8\u306e\u958b\u59cb\u64cd\u4f5c\u3092\u5f85\u3063\u3066\u3044\u307e\u3059\u3002</p>`;
  app.innerHTML=shell(`<header class="compact-header"><p class="eyebrow">対戦待機</p><h1>\u5bfe\u6226\u5f85\u6a5f</h1></header><div class="notice-card"><p>\u90e8\u5c4bID</p><h2>${escapeHtml(state.roomId??"")}</h2><p>${opponentText}</p></div>${error()}<div class="menu">${startControl}${button("\u90e8\u5c4b\u3092\u9000\u51fa","room-leave","text")}</div>`);
}
function renderAttributeSelection(): void {
  const choices = Object.entries(elements).map(([key, value]) => `<button class="attribute-choice attribute-choice-${key} ${key}" data-element="${key}" aria-label="${value.name}属性を選択" ${busy ? "disabled" : ""}><span>${value.mark}</span></button>`).join("");
  app.innerHTML = shell(`<div class="attribute-lobby">
    <header class="attribute-heading"><p class="eyebrow">五行選択</p><h1>初期属性を選択</h1><p>五行から、あなたの最初の属性を選んでください。</p></header>
    <div class="attribute-wheel" aria-label="五行属性選択">
      <svg viewBox="0 0 300 300" aria-hidden="true"><circle cx="150" cy="150" r="112"></circle><polyline points="150,38 216,241 43,107 257,107 84,241 150,38"></polyline><circle cx="150" cy="150" r="48"></circle></svg>
      ${choices}
      <div class="attribute-wheel-core"><small>五行</small><strong>選択</strong></div>
    </div>
    <div class="attribute-note">${error()}<p>相手の属性は、双方の選択完了まで公開されません。</p></div>
  </div>`, "attribute-screen");
}
function elementBadge(attribute?: FiveElement): string {
  if (!attribute) return `<span class="attribute unknown">?</span>`;
  return `<span class="attribute ${attribute}">${elements[attribute].mark}</span>`;
}
function renderReveal(): void {
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">属性公開</p><h1>属性公開</h1></header><div class="versus"><div>${elementBadge(state.playerAttribute)}<strong>${escapeHtml(state.playerName ?? "あなた")}</strong></div><b>対</b><div>${elementBadge(state.cpuAttribute)}<strong>${escapeHtml(state.opponentName ?? "CPU")}</strong></div></div>${error()}<div class="menu">${button("対戦を開始", "enter-match")}</div>`);
}
const clientCardElements: Record<string, FiveElement | undefined> = { "木": "wood", "火": "fire", "土": "earth", "金": "metal", "水": "water" };
const clientOvercomes: Record<FiveElement, FiveElement> = { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" };
function predictedCardDamage(card: CardView | undefined, targetAttribute?: string): number | undefined {
  if (card?.baseDamage === undefined) return undefined;
  const cardElement = clientCardElements[card.attribute];
  const targetElement = targetAttribute ? clientCardElements[targetAttribute] : undefined;
  let damage = card.baseDamage;
  if (cardElement && cardElement === state.playerAttribute) damage += ATTRIBUTE_MATCH_BONUS;
  if (cardElement && targetElement && clientOvercomes[cardElement] === targetElement) damage += ATTRIBUTE_OVERCOME_BONUS;
  return damage;
}
function renderUnits(units: NonNullable<SessionState["battle"]>["player"]["shikigami"], targetMode?: CardPlayTarget, ignoreTaunt = false, owner: "cpu"|"player" = "cpu", targetDescription = "", predictionCard?: CardView): string {
  const hasTaunt = units.some((unit) => unit.keywords.includes("\u6311\u767a"));
  const slots = Array.from({ length: 3 }, (_, index) => {
    const unit = units[index];
    if (!unit) return `<div class="unit-slot empty">\u7a7a\u304d</div>`;
    const keywords = unit.keywords.length > 0 ? `<small>${unit.keywords.map(escapeHtml).join("?")}</small>` : "";
    const oneShotReduction = unit.nextDamageReduction > 0 ? `<span class="unit-effect">\u6b21\u56de\u8efd\u6e1b ${unit.nextDamageReduction}</span>` : "";
    const shellReduction = unit.shellDamageReduction > 0 ? `<span class="unit-effect">\u7532\u7f85\u7c60\u308a ${unit.shellDamageReduction}</span>` : "";
    const enemyTarget = owner==="cpu"&&(targetMode==="cpu_unit"||targetMode==="cpu_any")&&(!unit.keywords.includes("\u30b9\u30c6\u30eb\u30b9")||unit.keywords.includes("\u6311\u767a"))&&(ignoreTaunt||!hasTaunt||unit.keywords.includes("\u6311\u767a"));
    const enemyFieldTarget = owner==="cpu"&&targetMode==="cpu_field";
    const allyTarget = owner==="player"&&targetMode==="player_unit";
    const target = enemyTarget?`data-target="cpu_unit:${unit.instanceId}"`:enemyFieldTarget?'data-target="cpu_field"':allyTarget?`data-target="player_unit:${unit.instanceId}"`:"";
    const targetContext = owner==="cpu"?(targetMode==="cpu_unit"||targetMode==="cpu_any"||targetMode==="cpu_field"):targetMode==="player_unit";
    const targetClass = targetContext?(target?"target-option":"target-blocked"):"";
    const fieldBadge = targetDescription.includes("ランダム") ? "ランダム" : "全体";
    const predictedDamage = owner==="cpu" ? predictedCardDamage(predictionCard, unit.attribute) : undefined;
    const targetBadge = targetContext?(target?`<em class="target-badge">${predictedDamage!==undefined?`予測 ${predictedDamage}`:enemyFieldTarget?fieldBadge:"対象"}</em>`:`<em class="target-reason">${unit.keywords.includes("ステルス")?"ステルス":"対象外"}</em>`):"";
    return `<article class="unit-slot ${cardAttributeClass(unit.attribute)} ${targetClass}" data-unit-id="${unit.instanceId}" data-unit-side="${owner}" ${target}><img class="unit-portrait" src="${shikigamiImagePath(unit.imageId)}" alt="" loading="lazy"><div class="unit-shade"></div>${targetBadge}<strong>${escapeHtml(unit.name)}</strong><span>${escapeHtml(unit.attribute)}</span><b>HP ${unit.hp} / ${unit.maxHp}</b><span>攻 ${unit.attack}</span>${keywords}${renderCurses(unit.curses)}${oneShotReduction}${shellReduction}</article>`;
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
type CardInfo = Pick<CardView, "cardId" | "name" | "category" | "system" | "attribute" | "cost" | "mpCost" | "target" | "timing" | "effectText" | "flavorText" | "imageId">;
const summonArt: Record<string, string> = {
  card_summon_kanko: "img_shikigami_kanko",
  card_summon_hakuro: "img_shikigami_hakuro",
  card_summon_orochi: "img_shikigami_orochi",
  card_summon_kappa: "img_shikigami_kappa",
  card_summon_karasutengu: "img_shikigami_karasutengu",
  card_summon_kamaitachi: "img_shikigami_kamaitachi",
  card_summon_komainu: "img_shikigami_komainu",
  card_summon_shirozaru: "img_shikigami_shirozaru",
  card_summon_genki: "img_shikigami_genki",
  card_summon_hinotori: "img_shikigami_hinotori",
};
const cardSigils: Record<string, string> = {
  reidan: "●", zanfu: "斬", senfu: "穿", bakufu: "爆", shokufu: "喰", shufu: "守",
  utsusemi: "影", kekkaifu: "界", joka: "浄", kassei: "活", fuin: "封", haraekotoba: "祓",
  tenrin: "輪", sosei: "生", sokoku: "剋", junkan: "巡",
};
const systemSigils: Record<string, { key: string; mark: string }> = {
  霊符術: { key: "reifu", mark: "符" }, 占事略决: { key: "senji", mark: "輪" },
  陰陽秘術: { key: "onmyo", mark: "陰" }, 結界術: { key: "barrier", mark: "界" },
  使役術: { key: "summon", mark: "役" }, 地脈術: { key: "terrain", mark: "脈" },
  禁術: { key: "forbidden", mark: "禁" },
};
function cardSigil(card: Pick<CardInfo, "imageId" | "system">): { key: string; mark: string } {
  const key = card.imageId?.replace(/^img_card_/, "");
  if (key && cardSigils[key]) return { key, mark: cardSigils[key] };
  return systemSigils[card.system] ?? { key: "spell", mark: "術" };
}
function shortCardEffect(effectText: string): string {
  const first = effectText.split(/[。\n]/).find(Boolean) ?? effectText;
  return first.length > 34 ? `${first.slice(0, 33)}…` : first;
}
const glossary: Record<string, string> = {
  "転輪": "属性を木→火→土→金→水→木の順で動かすこと。逆方向へ動く効果もあります。",
  "相生": "五行の「生み出す」関係。成立すると霊気を得ます。",
  "相剋": "五行の「打ち克つ」関係。有利な属性への攻撃が強くなります。",
  "属性一致": "自分と同じ属性のカードを使い、カードの基本効果を強めることです。",
  "地形": "盤面中央に1つだけ置かれ、両プレイヤーへ影響する共有効果です。",
  "結界": "各プレイヤーが1つだけ持てる継続効果です。新しい結界で上書きされます。",
  "挑発": "通常の単体攻撃を、この能力を持つ式神へ向けさせます。",
  "かばう": "味方への単体攻撃を代わりに受けます。",
  "ステルス": "通常の単体攻撃では対象に選ばれません。全体・ランダム攻撃は受けます。",
  "反撃": "攻撃を受けて生存した場合、攻撃した相手へ1ダメージを返します。",
  "貫通": "式神の残りHPを超えたダメージを相手プレイヤーへ通します。",
  "飛行": "「飛行には適用されない」と書かれた地形や効果を受けません。",
  "呪い": "毒や火傷など、通常のバフ・デバフとは別に管理される不利益です。",
};
function cardGlossary(card: Pick<CardInfo, "system" | "effectText" | "target">): [string, string][] {
  const text = `${card.system} ${card.effectText} ${card.target}`;
  return Object.entries(glossary).filter(([term]) => text.includes(term));
}
function plainCardGuide(card: Pick<CardInfo, "system" | "category" | "effectText">): string {
  if (card.system === "地脈術") return "盤面中央へ置く共有効果です。あなたと相手の両方に影響します。";
  if (card.system === "結界術") return "自分側へ置く継続効果です。新しく置くと、今ある結界は消滅します。";
  if (card.system === "使役術") return "空き枠へ式神を召喚します。式神はターン終了後に自動で行動します。";
  if (card.category === "防御札") return "相手の攻撃中に出る「防御・反応受付」で使うカードです。";
  if (card.effectText.includes("転輪")) return "現在の属性を五行の輪に沿って動かし、有利な関係を作るカードです。";
  if (card.effectText.includes("相剋")) return "有利な五行関係を作り、攻撃を強くするためのカードです。";
  return "効果欄を上から順に処理します。対象と使用タイミングを確認してください。";
}
interface MechanicGuide { heading: string; steps: string[]; notes?: string[] }
const terrainGuides: Record<string, MechanicGuide> = {
  card_terrain_chinju_forest: {
    heading: "ターンが終わるたび、すべての式神を回復",
    steps: ["自分または相手のターンが終了する", "敵味方を問わず、場にいる式神すべてのHPを1回復する"],
    notes: ["プレイヤーは回復しません。", "最大HPを超えて回復しません。"],
  },
  card_terrain_scorched_earth: {
    heading: "ターンが終わるたび、すべての式神へダメージ",
    steps: ["自分または相手のターンが終了する", "敵味方を問わず、場にいる式神すべてへ1ダメージを与える", "HPが0になった式神は退場する"],
    notes: ["プレイヤーにはダメージを与えません。"],
  },
  card_terrain_clear_stream: {
    heading: "ターン開始時、両者の霊気を増やす",
    steps: ["いずれかのプレイヤーがターンを開始する", "自分と相手の霊気をそれぞれ1増やす"],
    notes: ["霊気は最大30を超えません。"],
  },
  card_terrain_mineral_vein: {
    heading: "手番プレイヤーのコストを追加で1増やす",
    steps: ["ターン開始時、通常どおりコストを5まで回復する", "そのターンのプレイヤーだけ、現在コストをさらに1増やす"],
    notes: ["追加分は基本コスト5を超えて保持できます。", "余ったコストはターン終了時に失われます。"],
  },
  card_terrain_sacred_domain: {
    heading: "場のすべての式神が受けるダメージを1軽減",
    steps: ["式神がダメージを受ける", "敵味方を問わず、そのダメージを1減らす"],
    notes: ["プレイヤーが受けるダメージは軽減しません。", "ダメージは0未満になりません。"],
  },
  card_terrain_yomi_road: {
    heading: "式神が退場すると、その所有者が霊気を得る",
    steps: ["式神のHPが0以下になり退場する", "退場した式神を持っていたプレイヤーの霊気を1増やす"],
    notes: ["消滅は退場ではないため発動しません。", "霊気は最大30を超えません。"],
  },
};
function mechanicGuide(card: CardInfo): MechanicGuide {
  const terrain = terrainGuides[card.cardId];
  if (terrain) return { ...terrain, notes: [...(terrain.notes ?? []), "地形は盤面に1つだけです。新しい地形を置くと、古い地形は消滅します。"] };
  const steps = card.effectText.split("。").map((step) => step.trim()).filter(Boolean);
  const notes: string[] = [];
  if (card.system === "結界術") notes.push("結界は自分側に1つだけです。新しい結界を置くと、古い結界は消滅します。");
  if (card.category === "防御札") notes.push("相手の攻撃中に表示される防御・反応受付で使用します。");
  if (card.effectText.includes("属性一致")) notes.push("属性一致は、自分の現在属性とカード属性が同じ場合に成立します。");
  return { heading: "効果は次の順に処理されます", steps: steps.length ? steps : [card.effectText], notes };
}
function renderMechanicGuide(card: CardInfo): string {
  const guide = mechanicGuide(card);
  const steps = guide.steps.map((step) => "<li>" + escapeHtml(step) + "</li>").join("");
  const notes = guide.notes?.length ? "<ul>" + guide.notes.map((note) => "<li>" + escapeHtml(note) + "</li>").join("") + "</ul>" : "";
  return '<div class="mechanic-guide"><strong>' + escapeHtml(guide.heading) + "</strong><ol>" + steps + "</ol>" + notes + "</div>";
}
function renderCardArt(card: CardInfo, compact = false): string {
  const summonImageId = summonArt[card.cardId];
  if (summonImageId) return `<div class="card-art ${compact ? "compact" : ""}"><img src="${shikigamiImagePath(summonImageId)}" alt="${escapeHtml(card.name)}" loading="lazy"><i aria-hidden="true"></i><span>${escapeHtml(card.attribute)}</span></div>`;
  const sigil = cardSigil(card);
  const shortName = card.name.split("：").at(-1) ?? card.name;
  return `<div class="card-art card-art-sigil sigil-${sigil.key} ${compact ? "compact" : ""}" role="img" aria-label="${escapeHtml(shortName)}の術式紋"><div class="sigil-orbit" aria-hidden="true"><b class="sigil-mark">${escapeHtml(sigil.mark)}</b><small>${escapeHtml(shortName)}</small></div><i aria-hidden="true"></i><span>${escapeHtml(card.attribute)}</span></div>`;
}
function renderCardDetail(card: CardInfo, footer = ""): string {
  const showBeginnerHelp = state.mode === "cpu" && cpuExperienceMode === "tutorial";
  const effectExpanded = expandedEffectCardId === card.cardId;
  const terms = showBeginnerHelp
    ? cardGlossary(card).map(([term, explanation]) => `<li><b>${escapeHtml(term)}</b><span>${escapeHtml(explanation)}</span></li>`).join("")
    : "";
  return `<div class="card-detail card-detail-rich ${cardAttributeClass(card.attribute)}">
    <div class="card-detail-frame">${renderCardArt(card)}
      <header><p class="eyebrow">${escapeHtml(card.category)} / ${escapeHtml(card.system)}</p><h2>${escapeHtml(card.name)}</h2></header>
      <div class="card-detail-meta"><span>属性 ${escapeHtml(card.attribute)}</span><span>コスト ${card.cost}</span><span>霊気 ${card.mpCost}</span></div>
      ${showBeginnerHelp ? `<section class="card-plain-guide"><b>かんたんに言うと</b><p>${escapeHtml(plainCardGuide(card))}</p></section>` : ""}
      <section class="card-effect-copy ${effectExpanded ? "is-expanded" : ""}"><button type="button" data-action="toggle-effect-details" aria-expanded="${effectExpanded}"><span><b>効果</b><small>${effectExpanded ? "詳しい説明を閉じる" : "タップで詳しく見る"}</small></span><i aria-hidden="true">${effectExpanded ? "−" : "＋"}</i></button><p>${escapeHtml(card.effectText)}</p>${effectExpanded ? renderMechanicGuide(card) : ""}</section>
      <dl class="card-facts"><div><dt>対象</dt><dd>${escapeHtml(card.target)}</dd></div><div><dt>使える時</dt><dd>${escapeHtml(card.timing)}</dd></div></dl>
      ${terms ? `<section class="term-help"><h3>このカードの用語</h3><ul>${terms}</ul></section>` : ""}
      ${card.flavorText ? `<p class="flavor">${escapeHtml(card.flavorText)}</p>` : ""}${footer}
    </div>
  </div>`;
}
const elementOvercomes: Record<FiveElement, FiveElement> = { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" };
function hpGauge(hp: number): string {
  const percentage = Math.max(0, Math.min(100, hp / MAX_PLAYER_HP * 100));
  return `<i class="hp-gauge" aria-hidden="true"><em style="width:${percentage}%"></em></i>`;
}
function elementTension(): string {
  const self = state.playerAttribute;
  const opponent = state.cpuAttribute;
  if (!self || !opponent) return `<div class="element-tension neutral"><span>五行相関</span><b>属性確認中</b></div>`;
  if (elementOvercomes[self] === opponent) return `<div class="element-tension advantage"><span>相剋優勢 ＋4</span><b>${elements[self].mark} 剋 ${elements[opponent].mark}</b></div>`;
  if (elementOvercomes[opponent] === self) return `<div class="element-tension danger"><span>相剋警戒 ＋4</span><b>${elements[opponent].mark} 剋 ${elements[self].mark}</b></div>`;
  return `<div class="element-tension neutral"><span>五行拮抗</span><b>転輪で相剋を狙う</b></div>`;
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
  const cards = battle.player.hand.map((card) => {
    const sigil = cardSigil(card);
    return `<button ${battle.pendingDiscard ? `data-discard-instance="${card.instanceId}"` : `data-card-instance="${card.instanceId}"`} class="hand-card hand-card-simple ${cardAttributeClass(card.attribute)} ${card.playable ? "" : "unplayable"}" aria-label="${escapeHtml(card.name)}。タップで選択、長押しで詳細">
    <span class="hand-card-system">${escapeHtml(card.system)}</span>
    <span class="hand-card-name"><i class="hand-card-mark sigil-${sigil.key}" aria-hidden="true">${escapeHtml(sigil.mark)}</i><strong>${escapeHtml(card.name.split("：").at(-1) ?? card.name)}</strong></span>
    <span class="hand-card-attribute">${escapeHtml(card.attribute)}</span><span class="hand-card-cost">コスト ${card.cost}</span>${card.mpCost > 0 ? `<span class="hand-card-mp">霊気 ${card.mpCost}</span>` : ""}
    <small>${escapeHtml(shortCardEffect(card.effectText))}</small>
  </button>`;
  }).join("");
  const pendingCard = battle.player.hand.find((card) => card.instanceId === pendingCardId);
  const pendingTarget = pendingCard?.playTarget;
  const targeting = pendingCard !== undefined;
  const targetLabels: Record<CardPlayTarget, string> = { cpu_player: "相手プレイヤー", cpu_unit: "相手式神", cpu_any: "相手プレイヤーまたは相手式神", cpu_field: "相手式神エリア", cpu_barrier: "相手結界", player: "自分プレイヤー", player_unit: "味方式神", player_field: "味方式神エリア", player_barrier: "自分結界", retired_unit: "退場した式神", shared_field: "共有地形" };
  const retiredTargets = targeting && pendingTarget==="retired_unit" ? battle.player.retiredShikigami.map(unit=>`<button class="menu-button small" data-target="retired_unit:${unit.instanceId}">${escapeHtml(unit.name)} (HP ${unit.maxHp})</button>`).join("") : "";
  const attackPreview = pendingCard?.baseDamage !== undefined;
  const cpuPlayerPrediction = pendingTarget==="cpu_player"||pendingTarget==="cpu_any" ? predictedCardDamage(pendingCard, state.cpuAttribute ? elements[state.cpuAttribute].name : undefined) : undefined;
  const targetGuideText = pendingTarget==="cpu_field"&&pendingCard?.target.includes("ランダム") ? "光っている式神または相手式神エリアをタップすると、対象をランダムに決定します。" : attackPreview ? "各対象の「予測」は属性一致と相剋を含む防御前ダメージです。防御札などで変化する場合があります。" : "金色に光っている対象をタップしてください。";
  const targetGuide = targeting && pendingTarget ? `<div class="target-guide"><strong>${escapeHtml(pendingCard.target || targetLabels[pendingTarget])}を選択</strong>${cpuPlayerPrediction!==undefined?`<em class="target-damage-preview">相手プレイヤー：予測 ${cpuPlayerPrediction}</em>`:""}<span>${targetGuideText}</span>${button("キャンセル", "cancel-target", "small text")}</div>` : "";
  const opponentHasTaunt = battle.cpu.shikigami.some((unit) => unit.keywords.includes("挑発"));
  const targetAttribute = (target: CardPlayTarget): string => targeting && (pendingTarget === target || (pendingTarget === "cpu_any" && target === "cpu_player")) && !(target === "cpu_player" && opponentHasTaunt && !pendingCard?.ignoreTaunt) ? 'data-target="' + target + '"' : "";
  const log = battle.log.slice(-8).map((entry) => `<li>${escapeHtml(localizeBattleLogEntry(entry))}</li>`).join("");
  const finished = battle.phase === "finished";
  const resultActions=state.mode==="online"?`${button("\u518d\u6226\u3092\u7533\u3057\u8fbc\u3080","rematch")}${button("\u518d\u6226\u3092\u3084\u3081\u308b","rematch-cancel","secondary")}`:button("\u518d\u6226","rematch");
  const result = finished ? `<div class="battle-result"><strong>${battle.winner === "player" ? "\u52dd\u5229" : "\u6557\u5317"}</strong><span>\u5bfe\u6226\u304c\u7d42\u4e86\u3057\u307e\u3057\u305f</span><div class="result-actions">${resultActions}</div></div>` : "";
  const canEndTurn = !finished && battle.phase === "card_use" && battle.activePlayer === "player";
  const playableCount = battle.player.hand.filter((card) => card.playable).length;
  const beginnerHint = state.mode === "cpu" && cpuExperienceMode === "tutorial" && !finished && battle.activePlayer === "player" && battle.phase === "card_use"
    ? `<aside class="beginner-hint"><b>次にできること</b><span>${playableCount > 0 ? `明るいカードが ${playableCount} 枚あります。タップで確認、長押しで詳しく読めます。` : "今使えるカードがありません。ターン終了で式神を行動させましょう。"}</span></aside>`
    : "";
  const tutorialCopy = [
    ["勝ち方", "相手のHPを0にすれば勝利です。まずは自分のHP・相手のHPと、黄色い手番表示を確認しましょう。"],
    ["カードの読み方", "明るいカードは使用可能です。タップで確認、長押しで画像付き詳細を開けます。コストは毎ターン回復し、霊気は持ち越せます。"],
    ["五行の狙い", "属性一致でカードが強まり、相剋で有利な属性へ大きなダメージを狙えます。転輪は自分の属性を動かす手段です。"],
    ["地形と式神", "中央の地形は両者に影響します。タップで詳細を確認できます。式神はターン終了後、召喚順に自動行動します。"],
  ] as const;
  const tutorial = state.mode === "cpu" && cpuExperienceMode === "tutorial" && tutorialStep !== null && battle.activePlayer === "player" && battle.phase === "card_use" ? `<section class="battle-tutorial" aria-live="polite"><span>指南 ${tutorialStep + 1} / ${tutorialCopy.length}</span><h2>${tutorialCopy[tutorialStep][0]}</h2><p>${tutorialCopy[tutorialStep][1]}</p><div><button class="menu-button small text" data-action="tutorial-skip">案内を閉じる</button><button class="menu-button small" data-action="tutorial-next">${tutorialStep === tutorialCopy.length - 1 ? "対戦を始める" : "次へ"}</button></div></section>` : "";
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
  const reactionPanel = reaction && !reactionSubmitting ? `<section class="reaction-panel"><div><p class="eyebrow">防御判断</p><h2>防御・反応受付中</h2><p class="reaction-paused-label">選択完了まで対戦処理は停止中</p><strong>${escapeHtml(reaction.attackerName)}の${escapeHtml(reaction.sourceName)}</strong><p>${reaction.targets.map((item) => `${escapeHtml(item.label)}：予測 ${item.predictedDamage}ダメージ`).join(" / ")}</p><div class="reaction-time">残り <b data-reaction-countdown>${Math.max(0, Math.ceil((reaction.deadline - Date.now()) / 1000))}</b> 秒</div></div><div class="reaction-options">${reactionOptions || '<p class="muted">使用可能な防御札はありません。</p>'}</div><button class="menu-button secondary" data-action="reaction-pass">使用しない</button></section>` : "";
  const reactionResolving = reaction && reactionSubmitting ? '<div class="reaction-resolving" role="status">防御結果を処理中…</div>' : "";
  app.innerHTML = `<section class="battle battle-v2">${pausedPanel}${reactionPanel}${reactionResolving}${tutorial}<main class="battle-board">
    <header class="battle-player opponent ${battle.cpu.hp <= MAX_PLAYER_HP * .25 ? "is-critical" : ""}" data-combatant="cpu" ${targetAttribute("cpu_player")}><div><span>${escapeHtml(state.opponentName ?? "CPU")}</span><strong>HP ${battle.cpu.hp} / ${MAX_PLAYER_HP}</strong>${hpGauge(battle.cpu.hp)}${renderCurses(battle.cpu.curses)}</div>${elementBadge(state.cpuAttribute)}<div class="resource"><span>霊気 ${battle.cpu.mp} / ${MAX_PLAYER_MP}</span><span>コスト ${battle.cpu.cost}</span><span>手札 ${battle.cpu.handCount}</span></div></header>
    <section class="barrier-display ${battle.cpu.barrier ? "" : "is-empty"}" ${targetAttribute("cpu_barrier") || (targeting && pendingCard?.cardId==="card_fuin" && battle.cpu.barrier ? 'data-target="cpu_barrier"' : "")}><span>相手結界</span><strong>${battle.cpu.barrier ? escapeHtml(battle.cpu.barrier.name) : "未設置"}</strong><small>${battle.cpu.barrier ? escapeHtml(battle.cpu.barrier.effectText) : ""}</small></section>
    <section class="field enemy" ${targetAttribute("cpu_field")}><p>相手式神</p>${renderUnits(battle.cpu.shikigami, pendingTarget, pendingCard?.ignoreTaunt, "cpu", pendingCard?.target, pendingCard)}</section>
    <section class="terrain ${battle.terrain ? "has-detail" : ""}" ${targetAttribute("shared_field")} ${battle.terrain && !targeting ? 'data-action="terrain-info"' : ""}><div class="terrain-name"><span>共有地形 · 両者に影響</span><strong>${battle.terrain ? escapeHtml(battle.terrain.name) : "通常状態"}</strong></div>${elementTension()}<small>${battle.terrain ? escapeHtml(battle.terrain.effectText) : "現在、共有効果はありません。"}</small>${battle.terrain ? '<em class="terrain-more">タップで詳細</em>' : ""}<div class="field-ring"></div></section>
    <section class="field ally" ${targetAttribute("player_field")}><p>味方式神</p>${renderUnits(battle.player.shikigami, pendingTarget, false, "player")}</section>
    <section class="barrier-display ${battle.player.barrier ? "" : "is-empty"}" ${targetAttribute("player_barrier")}><span>自分結界</span><strong>${battle.player.barrier ? escapeHtml(battle.player.barrier.name) : "未設置"}</strong><small>${battle.player.barrier ? escapeHtml(battle.player.barrier.effectText) : ""}</small></section>
    <header class="battle-player ${battle.player.hp <= MAX_PLAYER_HP * .25 ? "is-critical" : ""}" data-combatant="player" ${targetAttribute("player") || (targeting && pendingCard?.cardId==="card_joka" ? 'data-target="player"' : "")}><div><span>${escapeHtml(state.playerName ?? "あなた")}</span><strong>HP ${battle.player.hp} / ${MAX_PLAYER_HP}</strong>${hpGauge(battle.player.hp)}${renderCurses(battle.player.curses)}</div>${elementBadge(state.playerAttribute)}<div class="resource"><span>霊気 ${battle.player.mp} / ${MAX_PLAYER_MP}</span><span>コスト ${battle.player.cost}</span><span>捨て札 ${battle.player.discard.length}</span></div></header>
    </main><section class="hand battle-console"><div class="battle-command-row"><div class="phase-label">${finished ? "対戦終了" : `第${battle.turnNumber}ターン・${battle.activePlayer === "player" ? "自分" : "相手"}・${battle.phase === "reaction" ? "反応受付" : battle.phase === "resolving" ? "処理中" : "カード使用"}`} ${battle.turnDeadline&&!finished?`<span>残り <b data-turn-countdown>${Math.max(0,Math.ceil((battle.turnDeadline-Date.now())/1000))}</b>秒</span>`:""}</div><button class="menu-button end-turn" data-action="end-turn" ${!canEndTurn || busy ? "disabled" : ""}>ターン終了</button></div>${result}${targetGuide}${beginnerHint}<div class="hand-cards" aria-label="自分の手札">${cards || '<p class="empty-hand">手札がありません。</p>'}</div><div class="battle-utility"><details class="battle-log"><summary>対戦ログ</summary><ol>${log}</ol></details><div class="battle-actions">${button("ルール", "rules", "small secondary")}${button("設定", "settings", "small secondary")}${button("退出", "reset", "small text")}</div></div></section>
  </section>`;
}
function renderDialog(): void {
  let content: string;
  if (dialog === "rules") {
    content = `<div class="rules-guide"><header><p class="eyebrow">遊び方</p><h2>五行転輪のルール</h2><p>カードと式神を操り、相手のHPを0にすると勝利です。</p></header><section><h3>ターンと資源</h3><ul><li>ターン開始時に手札を5枚へ入れ替え、コストを5まで回復します。</li><li>余ったコストはターン終了時に失われます。霊気（MP）は最大30まで保持できます。</li><li>カード使用を終えると、召喚順に式神が自律行動します。</li></ul></section><section><h3>五行と転輪</h3><p class="rule-cycle">木 → 火 → 土 → 金 → 水 → 木</p><ul><li><b>属性一致：</b>同じ属性のカードを使うと効果量が増加します。</li><li><b>相生：</b>生み出す関係が成立すると霊気を得ます。</li><li><b>相剋：</b>打ち克つ関係が成立すると攻撃が強化されます。</li><li><b>転輪：</b>属性を五行環に沿って進め、相生・相剋を狙います。</li></ul></section><section><h3>呪いと状態</h3><div class="rule-grid"><p><b>毒</b><span>ターン終了時、スタック数ぶんダメージ</span></p><p><b>火傷</b><span>カード使用後・式神行動後にダメージ</span></p><p><b>凍結</b><span>式神の次の行動を1回失敗させる</span></p><p><b>麻痺</b><span>行動開始時に50％で失敗する</span></p><p><b>沈黙</b><span>プレイヤーが術札を使用できない</span></p><p><b>呪縛</b><span>式神が祝詞命令を受けられない</span></p></div><p class="rule-note">呪いはバフ・デバフとは別の状態です。残り期間と重複数は対象の詳細で確認できます。</p></section><section><h3>キーワード能力</h3><div class="rule-grid"><p><b>挑発</b><span>単体攻撃の対象を自身へ制限</span></p><p><b>かばう</b><span>味方への単体攻撃を肩代わり</span></p><p><b>ステルス</b><span>通常の単体攻撃に選ばれない</span></p><p><b>反撃</b><span>生存時、攻撃主体へ固定1ダメージ</span></p><p><b>貫通</b><span>式神への余剰ダメージをプレイヤーへ与える</span></p><p><b>飛行</b><span>「飛行には適用されない」効果を受けない</span></p></div></section><section><h3>防御・反応</h3><ul><li>反応受付は1回につき10秒、使用できる防御札は最大1枚です。</li><li>防御札はコスト0で、カードによって霊気を消費します。「使用しない」も選べます。</li><li>防御札への追加反応はなく、受付終了後に元の攻撃・効果を解決します。</li></ul></section><section><h3>攻撃と反撃の順序</h3><ol class="rule-flow"><li>対象制限・かばう</li><li>防御・軽減・無効化</li><li>ダメージ・貫通</li><li>退場と退場時効果</li><li>双方が生存している場合のみ反撃</li><li>攻撃後効果・勝敗判定</li></ol><p class="rule-note">反撃から反撃は発生しません。多段攻撃への反撃は、一連の攻撃終了後に1回だけ判定します。</p></section>${button("カード一覧を見る", "catalog", "small secondary")}</div>`;
  } else if (dialog === "catalog") {
    const entries = cardCatalog.map((card) => `<button class="catalog-card ${cardAttributeClass(card.attribute)}" data-catalog-card="${escapeHtml(card.cardId)}">${renderCardArt(card, true)}<header><span>${escapeHtml(card.system)}</span><strong>${escapeHtml(card.name.split("：").at(-1) ?? card.name)}</strong><em>${escapeHtml(card.attribute)}</em></header><div class="catalog-meta"><span>コスト ${card.cost}</span><span>霊気 ${card.mpCost}</span><span>${escapeHtml(card.category)}</span></div><p>${escapeHtml(shortCardEffect(card.effectText))}</p><small>タップで詳しく見る</small></button>`).join("");
    content = `<div class="catalog"><header><p class="eyebrow">収録札</p><h2>カード一覧</h2><span>${cardCatalog.length}枚</span><p>カードをタップすると、効果と用語を確認できます。</p></header>${catalogLoading?'<p class="muted">読み込み中…</p>':catalogError?`<div class="catalog-error"><p>${escapeHtml(catalogError)}</p>${button("再読み込み", "catalog-retry", "small secondary")}</div>`:`<div class="catalog-grid">${entries}</div>`}</div>`;
  } else if (dialog === "catalog_card") {
    const card = cardCatalog.find((item) => item.cardId === selectedCatalogCardId);
    if (!card) { dialog = "catalog"; render(); return; }
    content = renderCardDetail(card, button("カード一覧へ戻る", "catalog", "small secondary"));
  } else if (dialog === "card") {
    const card = state.battle?.player.hand.find((item) => item.instanceId === selectedCardId);
    if (!card) { dialog = null; return; }
    const useControl = state.battle?.phase === "reaction"
      ? `<p class="target-guide">反応受付パネルから防御対象を選択してください。</p>`
      : card.playable
      ? `${card.choiceOptions?.length ? `<label>\u9078\u629e <select data-card-choice>${card.choiceOptions.map(option=>`<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select></label>` : ""}<button class="menu-button" data-action="prepare-card">使用する</button>`
      : `<p class="unusable-message">使用不可：${escapeHtml(localizeUiMessage(card.unusableReason ?? "現在は使用できません。"))}</p>`;
    content = renderCardDetail(card, useControl);
  } else {
    content = `<h2>設定</h2><label>BGM音量<input type="range" min="0" max="100" value="${settings.bgm}" data-setting="bgm"></label><label>効果音音量<input type="range" min="0" max="100" value="${settings.sound}" data-setting="sound"></label><label class="check"><input type="checkbox" ${settings.vibration ? "checked" : ""} data-setting="vibration">振動</label><label>演出速度 <select data-setting="speed"><option value="slow" ${settings.speed === "slow" ? "selected" : ""}>ゆっくり</option><option value="normal" ${settings.speed === "normal" ? "selected" : ""}>標準</option><option value="fast" ${settings.speed === "fast" ? "selected" : ""}>速い</option></select></label><label class="check"><input type="checkbox" ${settings.log ? "checked" : ""} data-setting="log">対戦ログを表示</label>`;
  }
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal">${content}<button class="menu-button secondary" data-action="close-dialog">閉じる</button></section></div>`);
}

function applyResult(result: ActionResult): void {
  busy = false;
  if (!result.ok) {
    reactionSubmitting = false;
    submittedReactionDeadline = undefined;
    errorMessage = localizeUiMessage(result.message ?? "処理に失敗しました。");
    render();
    return;
  }
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

function cancelLongPress(): void {
  if (longPressTimer !== undefined) window.clearTimeout(longPressTimer);
  longPressTimer = undefined;
  longPressOrigin = null;
}
app.addEventListener("pointerdown", (event) => {
  const pointer = event as PointerEvent;
  const cardElement = (event.target as HTMLElement).closest<HTMLElement>("[data-card-instance]");
  if (!cardElement || busy || pendingCardId || state.battle?.pendingDiscard) return;
  cancelLongPress();
  longPressOrigin = { x: pointer.clientX, y: pointer.clientY };
  const instanceId = cardElement.dataset.cardInstance;
  longPressTimer = window.setTimeout(() => {
    if (!instanceId) return;
    selectedCardId = instanceId;
    dialog = "card";
    navigator.vibrate?.(18);
    render();
    cancelLongPress();
  }, 420);
});
app.addEventListener("pointermove", (event) => {
  if (!longPressOrigin) return;
  const pointer = event as PointerEvent;
  if (Math.hypot(pointer.clientX - longPressOrigin.x, pointer.clientY - longPressOrigin.y) > 10) cancelLongPress();
});
app.addEventListener("pointerup", cancelLongPress);
app.addEventListener("pointercancel", cancelLongPress);
app.addEventListener("pointerleave", cancelLongPress);

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  const cardInstanceId = target.closest<HTMLElement>("[data-card-instance]")?.dataset.cardInstance;
  const catalogCardId = target.closest<HTMLElement>("[data-catalog-card]")?.dataset.catalogCard;
  const discardInstanceId = target.closest<HTMLElement>("[data-discard-instance]")?.dataset.discardInstance;
  const reactionCard = target.closest<HTMLElement>("[data-reaction-card]")?.dataset.reactionCard;
  const reactionTarget = target.closest<HTMLElement>("[data-reaction-target]")?.dataset.reactionTarget as DefenseTarget | undefined;
  const targetType = target.closest<HTMLElement>("[data-target]")?.dataset.target as CardTarget | undefined;
  const attribute = target.closest<HTMLElement>("[data-element]")?.dataset.element as FiveElement | undefined;
  const reactionInteraction = Boolean(reactionCard || action === "reaction-pass");
  if (state.phase === "battle" && battlePresentationLocked() && !reactionInteraction) {
    event.preventDefault();
    return;
  }
  if(discardInstanceId && state.battle?.pendingDiscard && !busy){busy=true;render();socket.emit("card:discard",{instanceId:discardInstanceId},applyResult);return;}
  if (reactionCard && !busy) {
    reactionSubmitting = true;
    submittedReactionDeadline = state.battle?.reaction?.deadline;
    busy = true; render(); socket.emit("reaction:respond", { instanceId: reactionCard, target: reactionTarget }, applyResult); return;
  }  if (targetType && pendingCardId && !busy) {
    const instanceId = pendingCardId;
    busy = true;
    render();
    socket.emit("card:use", { instanceId, target: targetType, choice: selectedChoice }, (result) => {
      if (result.ok) clearCardSelection();
      applyResult(result);
    });
    return;
  }
  if (cardInstanceId && !busy && !pendingCardId && !battlePresentationLocked()) { selectedCardId = cardInstanceId; expandedEffectCardId = null; dialog = "card"; render(); return; }
  if (catalogCardId) { selectedCatalogCardId = catalogCardId; expandedEffectCardId = null; dialog = "catalog_card"; render(); return; }
  if (attribute && !busy) { busy = true; render(); socket.emit("attribute:select", { attribute }, applyResult); return; }
  if (!action || busy) return;
  if (action === "retry") socket.connect();
  else if (action === "cpu") { screen = "cpu_mode"; errorMessage = ""; render(); }
  else if (action === "cpu-mode") { screen = "cpu_mode"; errorMessage = ""; render(); }
  else if (action === "cpu-battle") { cpuExperienceMode = "battle"; tutorialStep = null; screen = "cpu_setup"; errorMessage = ""; render(); }
  else if (action === "cpu-full") { cpuExperienceMode = "full"; tutorialStep = null; screen = "cpu_setup"; errorMessage = ""; render(); }
  else if (action === "cpu-tutorial") { cpuExperienceMode = "tutorial"; tutorialStep = null; screen = "cpu_setup"; errorMessage = ""; render(); }
  else if (action === "online") { screen = "online"; render(); }
  else if (action === "title") { screen = "title"; render(); }
  else if (action === "rules" || action === "settings" || action === "catalog") { dialog = action; render(); }
  else if (action === "catalog-retry") { void loadCardCatalog(); render(); }
  else if (action === "terrain-info") {
    const terrainName = state.battle?.terrain?.name;
    const terrainCard = cardCatalog.find((card) => card.system === "地脈術" && (card.name === terrainName || card.name.endsWith(`：${terrainName}`)));
    if (terrainCard) { selectedCatalogCardId = terrainCard.cardId; expandedEffectCardId = null; dialog = "catalog_card"; }
    else { dialog = "rules"; errorMessage = terrainName ? `${terrainName}の詳細データを読み込めませんでした。` : ""; }
    render();
  }
  else if (action === "tutorial-next") {
    if (tutorialStep === null) return;
    if (tutorialStep >= 3) { tutorialStep = null; }
    else tutorialStep += 1;
    render();
  }
  else if (action === "tutorial-skip") { tutorialStep = null; render(); }
  else if (action === "toggle-effect-details") { const cardId = dialog === "card" ? state.battle?.player.hand.find((item) => item.instanceId === selectedCardId)?.cardId : selectedCatalogCardId; expandedEffectCardId = expandedEffectCardId === cardId ? null : cardId ?? null; render(); }
  else if (action === "close-dialog") { dialog = null; selectedCardId = null; expandedEffectCardId = null; render(); }
  else if (action === "prepare-card" && selectedCardId) { const card=state.battle?.player.hand.find(item=>item.instanceId===selectedCardId); selectedChoice=(document.querySelector<HTMLSelectElement>("[data-card-choice]")?.value ?? card?.choiceOptions?.[0]?.value); pendingCardId = selectedCardId; dialog = null; render(); }
  else if (action === "cancel-target") { clearCardSelection(); errorMessage = ""; render(); }
  else if (action === "room-start") { busy=true; render(); socket.emit("room:start",applyResult); }
  else if (action === "room-leave") { busy=true; localStorage.removeItem(TOKEN_KEY); socket.emit("room:leave",(result)=>{screen="title";applyResult(result);}); }
  else if (action === "rematch") { busy=true; render(); socket.emit("rematch:request",applyResult); }
  else if (action === "rematch-cancel") { busy=true; render(); socket.emit("rematch:cancel",applyResult); }
  else if (action === "enter-match") { busy = true; render(); socket.emit("match:enter", applyResult); }
  else if (action === "reaction-pass") {
    reactionSubmitting = true;
    submittedReactionDeadline = state.battle?.reaction?.deadline;
    busy = true; render(); socket.emit("reaction:respond", {}, applyResult);
  }
  else if (action === "end-turn") { busy = true; pendingCardId = null; selectedCardId = null; if (state.mode === "cpu") enqueueBattleCue({ title: "相手のターン", detail: "相手が行動中", side: "cpu", key: `turn:${state.battle?.turnNumber ?? 0}:cpu` }); render(); socket.emit("turn:end", applyResult); }
  else if (action === "reset") { busy = true; pendingCardId = null; selectedCardId = null; localStorage.removeItem(TOKEN_KEY); socket.emit("session:reset", (result) => { screen = "title"; applyResult(result); }); }
});
app.addEventListener("submit", (event) => {
  const form=event.target as HTMLFormElement;event.preventDefault();
  const playerName=form.querySelector<HTMLInputElement>('[name="playerName"],#player-name')?.value??"";
  if(form.dataset.form==="cpu"){busy=true;render();socket.emit("cpu:start",{playerName,poolMode:cpuExperienceMode==="full"?"full":"core"},applyResult);return}
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
