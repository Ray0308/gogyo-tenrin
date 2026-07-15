import {
  type ActionResult,
  type FiveElement,
  type SessionState,
} from "../shared/protocol.js";

type Acknowledge = (result: ActionResult) => void;
interface BrowserSocket {
  on(event: "connect", listener: () => void): void;
  on(event: "connect_error", listener: () => void): void;
  on(event: "session:state", listener: (state: SessionState) => void): void;
  emit(event: "session:resume", token: string, callback: Acknowledge): void;
  emit(event: "cpu:start", payload: { playerName: string }, callback: Acknowledge): void;
  emit(event: "attribute:select", payload: { attribute: FiveElement }, callback: Acknowledge): void;
  emit(event: "match:enter" | "session:reset", callback: Acknowledge): void;
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
type Dialog = "rules" | "settings" | null;
interface Settings { bgm: number; sound: number; vibration: boolean; speed: string; log: boolean }
let screen: LocalScreen = "connecting";
let dialog: Dialog = null;
let state: SessionState = { phase: "title" };
let busy = false;
let errorMessage = "";
let settings: Settings = loadSettings();

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
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">ONLINE MATCH</p><h1>オンライン対戦</h1></header><div class="notice-card"><h2>次の実装工程</h2><p>部屋作成・参加はCPU戦の基本フロー確認後に接続します。</p></div><nav class="menu">${button("部屋を作る", "noop", "disabled")}${button("部屋に入る", "noop", "disabled")}${button("戻る", "title", "text")}</nav>`);
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
  app.innerHTML = shell(`<header class="compact-header"><p class="eyebrow">ATTRIBUTE REVEAL</p><h1>属性公開</h1></header><div class="versus"><div>${elementBadge(state.playerAttribute)}<strong>${escapeHtml(state.playerName ?? "あなた")}</strong></div><b>対</b><div>${elementBadge(state.cpuAttribute)}<strong>CPU</strong></div></div>${error()}<div class="menu">${button("対戦を開始", "enter-match")}</div>`);
}
function unitSlots(): string { return `<div class="unit-slots"><div>式神枠</div><div>式神枠</div><div>式神枠</div></div>`; }
function renderBattle(): void {
  app.innerHTML = `<section class="battle"><header class="battle-player opponent"><div><span>CPU</span><strong>HP 30</strong></div>${elementBadge(state.cpuAttribute)}<div class="resource"><span>MP 0 / 30</span><span>COST 5</span></div></header><section class="field enemy"><p>相手式神</p>${unitSlots()}</section><section class="terrain"><span>共有地形</span><strong>通常状態</strong><div class="field-ring"></div></section><section class="field ally"><p>味方式神</p>${unitSlots()}</section><header class="battle-player"><div><span>${escapeHtml(state.playerName ?? "あなた")}</span><strong>HP 30</strong></div>${elementBadge(state.playerAttribute)}<div class="resource"><span>MP 0 / 30</span><span>COST 5</span></div></header><section class="hand"><div class="phase-label">対戦準備完了</div><p>カードマスターデータとターン進行は次の工程で接続します。</p><div class="battle-actions">${button("ルール", "rules", "small secondary")}${button("設定", "settings", "small secondary")}${button("タイトルへ戻る", "reset", "small text")}</div></section></section>`;
}
function renderDialog(): void {
  const content = dialog === "rules"
    ? `<h2>基本ルール</h2><p>木・火・土・金・水を巡らせ、カードと式神を用いて相手のHPを0にします。</p><p>ゲーム進行と判定はサーバーが管理します。</p>`
    : `<h2>設定</h2><label>BGM音量 <input type="range" min="0" max="100" value="${settings.bgm}" data-setting="bgm"></label><label>効果音音量 <input type="range" min="0" max="100" value="${settings.sound}" data-setting="sound"></label><label class="check"><input type="checkbox" ${settings.vibration ? "checked" : ""} data-setting="vibration">振動</label><label>演出速度 <select data-setting="speed"><option value="slow" ${settings.speed === "slow" ? "selected" : ""}>ゆっくり</option><option value="normal" ${settings.speed === "normal" ? "selected" : ""}>標準</option><option value="fast" ${settings.speed === "fast" ? "selected" : ""}>速い</option></select></label><label class="check"><input type="checkbox" ${settings.log ? "checked" : ""} data-setting="log">対戦ログを表示</label>`;
  app.insertAdjacentHTML("beforeend", `<div class="modal-backdrop"><section class="modal">${content}<button class="menu-button" data-action="close-dialog">閉じる</button></section></div>`);
}

function applyResult(result: ActionResult): void {
  busy = false;
  if (!result.ok) { errorMessage = result.message ?? "処理に失敗しました。"; render(); return; }
  errorMessage = "";
  if (result.state) state = result.state;
  if (state.reconnectToken) localStorage.setItem(TOKEN_KEY, state.reconnectToken);
  render();
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
socket.on("session:state", (nextState) => { state = nextState; if (nextState.reconnectToken) localStorage.setItem(TOKEN_KEY, nextState.reconnectToken); render(); });
socket.io.on("reconnect_attempt", () => { screen = "connecting"; render(); });

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  const attribute = target.closest<HTMLElement>("[data-element]")?.dataset.element as FiveElement | undefined;
  if (attribute && !busy) { busy = true; render(); socket.emit("attribute:select", { attribute }, applyResult); return; }
  if (!action || busy) return;
  if (action === "retry") socket.connect();
  else if (action === "cpu") { screen = "cpu_setup"; errorMessage = ""; render(); }
  else if (action === "online") { screen = "online"; render(); }
  else if (action === "title") { screen = "title"; render(); }
  else if (action === "rules" || action === "settings") { dialog = action; render(); }
  else if (action === "close-dialog") { dialog = null; render(); }
  else if (action === "enter-match") { busy = true; render(); socket.emit("match:enter", applyResult); }
  else if (action === "reset") { busy = true; localStorage.removeItem(TOKEN_KEY); socket.emit("session:reset", (result) => { screen = "title"; applyResult(result); }); }
});
app.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.dataset.form !== "cpu") return;
  event.preventDefault();
  const playerName = form.querySelector<HTMLInputElement>("#player-name")?.value ?? "";
  busy = true; render(); socket.emit("cpu:start", { playerName }, applyResult);
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