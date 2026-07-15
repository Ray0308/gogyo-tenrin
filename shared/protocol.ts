export const FIVE_ELEMENTS = ["wood", "fire", "earth", "metal", "water"] as const;
export type FiveElement = (typeof FIVE_ELEMENTS)[number];
export type GamePhase = "title" | "room_waiting" | "attribute_selection" | "attribute_reveal" | "battle";
export type CardPlayTarget = "cpu_player" | "cpu_unit" | "cpu_any" | "cpu_field" | "cpu_barrier" | "player" | "player_unit" | "player_field" | "player_barrier" | "retired_unit" | "shared_field";
export type CardTarget = "cpu_player" | "cpu_field" | "cpu_barrier" | "player" | "player_field" | "player_barrier" | "shared_field" | `cpu_unit:${string}` | `player_unit:${string}` | `retired_unit:${string}` | `terrain:${string}`;
export type DefenseTarget = "player" | `player_unit:${string}`;

export interface CardView {
  instanceId: string;
  cardId: string;
  name: string;
  category: string;
  system: string;
  attribute: string;
  cost: number;
  mpCost: number;
  target: string;
  timing: string;
  effectText: string;
  description: string;
  flavorText: string;
  playable: boolean;
  unusableReason?: string;
  playTarget?: CardPlayTarget;
  ignoreTaunt?: boolean;
  choiceOptions?: { value: string; label: string }[];
}

export interface CurseState {
  id: string;
  name: string;
  stacks: number;
  remainingTriggers?: number;
}

export interface ShikigamiState {
  instanceId: string;
  shikigamiId: string;
  imageId: string;
  name: string;
  attribute: string;
  hp: number;
  maxHp: number;
  attack: number;
  aiProfile: string;
  keywords: string[];
  ability: string;
  curses: CurseState[];
  nextDamageReduction: number;
  shellDamageReduction: number;
  nextAttackBonus: number;
  cannotActTurn?: number;
  abilityDisabledUntilTurn?: number;
}

export interface FieldObjectState {
  id: string;
  name: string;
  attribute: string;
  effectText: string;
  triggerCount?: number;
  skipNextTrigger?: boolean;
}

export interface BattlePlayerState {
  hp: number;
  mp: number;
  cost: number;
  curses: CurseState[];
  nextDamageReduction: number;
  shikigami: ShikigamiState[];
  barrier?: FieldObjectState;
  retiredShikigami: ShikigamiState[];
}

export interface BattleState {
  turnNumber: number;
  activePlayer: "player" | "cpu";
  phase: "card_use" | "reaction" | "resolving" | "finished";
  winner?: "player" | "cpu";
  player: BattlePlayerState & { hand: CardView[]; discard: CardView[] };
  cpu: BattlePlayerState & { handCount: number };
  terrain?: FieldObjectState;
  turnDeadline?: number;
  pendingDiscard?: { count: number; side: "player" | "cpu" };
  reaction?: {
    sourceName: string;
    attackerName: string;
    targets: { id: DefenseTarget; label: string; predictedDamage: number }[];
    eligibleCardIds: string[];
    deadline: number;
  };
  log: string[];
}

export interface SessionState {
  phase: GamePhase;
  mode?: "cpu" | "online";
  roomId?: string;
  role?: "host" | "guest";
  opponentName?: string;
  roomReady?: boolean;
  connectionPaused?: boolean;
  rematchStatus?: "waiting" | "requested";
  rematchDeadline?: number;
  reconnectToken?: string;
  playerName?: string;
  playerAttribute?: FiveElement;
  cpuAttribute?: FiveElement;
  battle?: BattleState;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  state?: SessionState;
}

export interface ClientToServerEvents {
  "session:resume": (token: string, callback: (result: ActionResult) => void) => void;
  "cpu:start": (payload: { playerName: string }, callback: (result: ActionResult) => void) => void;
  "room:create": (payload: { playerName: string }, callback: (result: ActionResult) => void) => void;
  "room:join": (payload: { playerName: string; roomId: string }, callback: (result: ActionResult) => void) => void;
  "room:start": (callback: (result: ActionResult) => void) => void;
  "room:leave": (callback: (result: ActionResult) => void) => void;
  "rematch:request": (callback: (result: ActionResult) => void) => void;
  "rematch:cancel": (callback: (result: ActionResult) => void) => void;
  "attribute:select": (payload: { attribute: FiveElement }, callback: (result: ActionResult) => void) => void;
  "match:enter": (callback: (result: ActionResult) => void) => void;
  "card:use": (payload: { instanceId: string; target: CardTarget; choice?: string }, callback: (result: ActionResult) => void) => void;
  "card:discard": (payload: { instanceId: string }, callback: (result: ActionResult) => void) => void;
  "reaction:respond": (payload: { instanceId?: string; target?: DefenseTarget }, callback: (result: ActionResult) => void) => void;
  "turn:end": (callback: (result: ActionResult) => void) => void;
  "session:reset": (callback: (result: ActionResult) => void) => void;
}

export interface ServerToClientEvents {
  "session:state": (state: SessionState) => void;
}
