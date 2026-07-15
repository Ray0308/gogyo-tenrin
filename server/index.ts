import express from "express";
import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  FIVE_ELEMENTS,
  type BattlePlayerState,
  type CardTarget,
  type CardView,
  type ClientToServerEvents,
  type CurseState,
  type FiveElement,
  type ServerToClientEvents,
  type SessionState,
  type ShikigamiState,
} from "../shared/protocol.js";

interface CardMaster { id:string; name:string; category:string; system:string; attribute:string; templateId:string|null; cost:number; mpCost:number; weight:number; target:string; timing:string; effectText:string; description:string; flavorText:string }
interface ShikigamiMaster { id:string; name:string; attribute:string; maxHp:number; attack:number; aiProfile:string; keywords:string|null; ability:string; description:string; imageId:string }
type AttributeMatchEffect =
  | { type:"apply_curse"; curseId:"curse_poison"|"curse_burn"; stacks:number }
  | { type:"next_damage_reduction"; amount:number }
  | { type:"ignore_damage_reduction"; amount:number }
  | { type:"gain_mp"; amount:number };
interface AttackDefinition { type:"attack"; cardId:string; target:"opponent_player"; baseDamage:number; attributeMatchEffect:AttributeMatchEffect }
interface TurnDefinition { type:"turn"; cardId:string; target:"self_player"; steps:number }
interface SummonDefinition { type:"summon"; cardId:string; target:"self_field"; shikigamiId:string }
type CardEffectDefinition = AttackDefinition|TurnDefinition|SummonDefinition;
interface StoredSession { state:SessionState; cpuHand:CardView[]; cpuDiscard:CardView[] }
type Side = "player"|"cpu";
type UnitTarget = { type:"player" }|{ type:"unit"; unit:ShikigamiState };

const app=express();
export const server=createServer(app);
export const io=new Server<ClientToServerEvents,ServerToClientEvents>(server);
const port=Number(process.env.PORT??3000);
const currentDirectory=path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory=path.resolve(currentDirectory,"..");
const clientDirectory=path.join(distributionDirectory,"client");
const rootDocument=readFileSync(path.join(clientDirectory,"index.html"),"utf8");
const cards=loadJson<CardMaster[]>("cards.json");
const shikigami=loadJson<ShikigamiMaster[]>("shikigami.json");
const definitions=loadJson<CardEffectDefinition[]>("cardEffects.json");
const cardById=new Map(cards.map(card=>[card.id,card]));
const shikigamiById=new Map(shikigami.map(unit=>[unit.id,unit]));
const effectByCardId=new Map(definitions.map(effect=>[effect.cardId,effect]));
const totalCardWeight=cards.reduce((sum,card)=>sum+card.weight,0);
const sessions=new Map<string,StoredSession>();
const socketTokens=new Map<string,string>();
const cardAttributeToElement:Record<string,FiveElement|undefined>={"木":"wood","火":"fire","土":"earth","金":"metal","水":"water"};
const elementName:Record<FiveElement,string>={wood:"木",fire:"火",earth:"土",metal:"金",water:"水"};
const generates:Record<FiveElement,FiveElement>={wood:"fire",fire:"earth",earth:"metal",metal:"water",water:"wood"};
const overcomes:Record<FiveElement,FiveElement>={wood:"earth",earth:"water",water:"fire",fire:"metal",metal:"wood"};

function loadJson<T>(name:string):T{return JSON.parse(readFileSync(path.join(currentDirectory,"data",name),"utf8")) as T}
function validateMaster():void{
  if(cards.length===0||totalCardWeight<=0)throw new Error("抽選可能なカードがありません。");
  const ids=new Set<string>();
  for(const card of cards){if(!/^[a-z0-9_]+$/.test(card.id)||ids.has(card.id)||card.cost<0||card.mpCost<0||card.weight<0)throw new Error(`カードマスターが不正です: ${card.id}`);ids.add(card.id)}
  for(const definition of definitions){if(!cardById.has(definition.cardId))throw new Error(`存在しないカードの効果です: ${definition.cardId}`);if(definition.type==="summon"&&!shikigamiById.has(definition.shikigamiId))throw new Error(`存在しない式神です: ${definition.shikigamiId}`)}
}
validateMaster();

function publicState(state:SessionState):SessionState{return structuredClone(state)}
function currentSession(socketId:string):StoredSession|undefined{const token=socketTokens.get(socketId);return token?sessions.get(token):undefined}
function sendState(socketId:string,state:SessionState):void{io.to(socketId).emit("session:state",publicState(state))}
function drawCard():CardView{
  let cursor=(randomInt(0,1_000_000_000)/1_000_000_000)*totalCardWeight;let selected=cards[cards.length-1];
  for(const card of cards){cursor-=card.weight;if(cursor<0){selected=card;break}}
  return {instanceId:randomUUID(),cardId:selected.id,name:selected.name,category:selected.category,system:selected.system,attribute:selected.attribute,cost:selected.cost,mpCost:selected.mpCost,target:selected.target,timing:selected.timing,effectText:selected.effectText,description:selected.description,flavorText:selected.flavorText,playable:false,unusableReason:"使用可否を確認中です。"};
}
function drawCards(count:number):CardView[]{return Array.from({length:count},drawCard)}
function drawToLimit(hand:CardView[],count:number):void{for(let i=0;i<count&&hand.length<7;i++)hand.push(drawCard())}
function stateForSide(state:SessionState,side:Side):BattlePlayerState{return state.battle![side]}
function attributeForSide(state:SessionState,side:Side):FiveElement{return (side==="player"?state.playerAttribute:state.cpuAttribute)!}
function setAttributeForSide(state:SessionState,side:Side,value:FiveElement):void{if(side==="player")state.playerAttribute=value;else state.cpuAttribute=value}
function otherSide(side:Side):Side{return side==="player"?"cpu":"player"}
function handForSide(session:StoredSession,side:Side):CardView[]{return side==="player"?session.state.battle!.player.hand:session.cpuHand}
function discardForSide(session:StoredSession,side:Side):CardView[]{return side==="player"?session.state.battle!.player.discard:session.cpuDiscard}
function expectedPlayerTarget(definition:CardEffectDefinition):CardTarget{return definition.type==="attack"?"cpu_player":definition.type==="turn"?"player":"player_field"}
function isDefinitionUsable(state:SessionState,side:Side,card:CardView,definition:CardEffectDefinition):string|undefined{
  const actor=stateForSide(state,side);
  if(actor.cost<card.cost)return "コストが不足しています。";
  if(actor.mp<card.mpCost)return "MPが不足しています。";
  if(definition.type==="summon"&&actor.shikigami.length>=3)return "式神枠が満員です。";
  return undefined;
}
function refreshPlayability(state:SessionState):void{
  const battle=state.battle;if(!battle)return;
  for(const card of battle.player.hand){card.playTarget=undefined;const definition=effectByCardId.get(card.cardId);
    if(battle.phase!=="card_use"||battle.activePlayer!=="player"){card.playable=false;card.unusableReason="現在はカードを使用できません。"}
    else if(!definition){card.playable=false;card.unusableReason="このカードの構造化効果データは未接続です。"}
    else{const reason=isDefinitionUsable(state,"player",card,definition);card.playable=!reason;card.unusableReason=reason;card.playTarget=expectedPlayerTarget(definition)}
  }
}
function addCurse(curses:CurseState[],curseId:"curse_poison"|"curse_burn",stacks=1):void{
  const existing=curses.find(curse=>curse.id===curseId);
  if(curseId==="curse_poison"){if(existing)existing.stacks=Math.min(5,existing.stacks+stacks);else curses.push({id:curseId,name:"毒",stacks:Math.min(5,stacks)});return}
  if(existing){existing.stacks=1;existing.remainingTriggers=2}else curses.push({id:curseId,name:"火傷",stacks:1,remainingTriggers:2});
}
function finishIfNeeded(state:SessionState):boolean{
  const battle=state.battle!;if(battle.player.hp<=0){battle.phase="finished";battle.winner="cpu";battle.log.push("プレイヤーのHPが0になり、CPUが勝利した。");return true}
  if(battle.cpu.hp<=0){battle.phase="finished";battle.winner="player";battle.log.push("CPUのHPが0になり、プレイヤーが勝利した。");return true}return false;
}
function applyDamageToPlayer(state:SessionState,side:Side,amount:number):number{
  const target=stateForSide(state,side);const damage=Math.max(0,amount-target.nextDamageReduction);if(target.nextDamageReduction>0)target.nextDamageReduction=0;target.hp=Math.max(0,target.hp-damage);return damage;
}
function applyDamageToUnit(unit:ShikigamiState,amount:number):number{const damage=Math.max(0,amount-unit.nextDamageReduction);if(unit.nextDamageReduction>0)unit.nextDamageReduction=0;unit.hp=Math.max(0,unit.hp-damage);return damage}
function cleanupUnits(state:SessionState,side:Side):void{const owner=stateForSide(state,side);const dead=owner.shikigami.filter(unit=>unit.hp<=0);for(const unit of dead)state.battle!.log.push(`${unit.name}が退場した。`);owner.shikigami=owner.shikigami.filter(unit=>unit.hp>0)}
function resolveAttributeMatchEffect(state:SessionState,side:Side,effect:AttributeMatchEffect):void{
  const battle=state.battle!,actor=stateForSide(state,side),defender=stateForSide(state,otherSide(side));
  if(effect.type==="apply_curse"){addCurse(defender.curses,effect.curseId,effect.stacks);battle.log.push(`${side==="player"?"CPU":"プレイヤー"}に呪い：${effect.curseId==="curse_poison"?"毒":"火傷"}を付与した。`)}
  else if(effect.type==="next_damage_reduction"){actor.nextDamageReduction=Math.max(actor.nextDamageReduction,effect.amount);battle.log.push(`次に受けるダメージを${effect.amount}軽減する効果を得た。`)}
  else if(effect.type==="ignore_damage_reduction")battle.log.push(`この攻撃はダメージ軽減を${effect.amount}無視した。`);
  else{actor.mp=Math.min(30,actor.mp+effect.amount);battle.log.push(`属性固有効果でMPが${effect.amount}増加した。`)}
}
function triggerBurnAfterCard(state:SessionState,side:Side):void{
  const actor=stateForSide(state,side),burn=actor.curses.find(curse=>curse.id==="curse_burn");if(!burn)return;
  const damage=applyDamageToPlayer(state,side,1);state.battle!.log.push(`火傷により${side==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`);burn.remainingTriggers=(burn.remainingTriggers??2)-1;if(burn.remainingTriggers<=0)actor.curses=actor.curses.filter(curse=>curse!==burn);
}
function createShikigami(master:ShikigamiMaster):ShikigamiState{return {instanceId:randomUUID(),shikigamiId:master.id,name:master.name,attribute:master.attribute,hp:master.maxHp,maxHp:master.maxHp,attack:master.attack,aiProfile:master.aiProfile,keywords:master.keywords?master.keywords.split(/[・、,]/).filter(Boolean):[],ability:master.ability,curses:[],nextDamageReduction:0}}
function executeCard(session:StoredSession,side:Side,index:number,externalTarget?:CardTarget):{ok:boolean;message?:string}{
  const state=session.state,battle=state.battle!,hand=handForSide(session,side),card=hand[index],definition=card?effectByCardId.get(card.cardId):undefined;
  if(!card)return {ok:false,message:"手札に存在しないカードです。"};if(!definition)return {ok:false,message:"このカードの効果処理はまだ接続されていません。"};
  if(side==="player"&&externalTarget!==expectedPlayerTarget(definition))return {ok:false,message:"対象が不正です。"};const reason=isDefinitionUsable(state,side,card,definition);if(reason)return {ok:false,message:reason};
  const actor=stateForSide(state,side),defenderSide=otherSide(side),actorAttribute=attributeForSide(state,side),cardElement=cardAttributeToElement[card.attribute];if(!cardElement)return {ok:false,message:"カード属性が不正です。"};
  actor.cost-=card.cost;actor.mp-=card.mpCost;
  if(definition.type==="attack"){
    const match=cardElement===actorAttribute,overcoming=overcomes[cardElement]===attributeForSide(state,defenderSide);const amount=definition.baseDamage+(match?1:0)+(overcoming?2:0);const damage=applyDamageToPlayer(state,defenderSide,amount);
    battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${card.name}を使用し、${side==="player"?"CPU":"プレイヤー"}へ${damage}ダメージ。`);if(match){battle.log.push("属性一致：基本効果量に＋1。");resolveAttributeMatchEffect(state,side,definition.attributeMatchEffect)}if(overcoming)battle.log.push("相剋成立：ダメージに＋2。");
  }else if(definition.type==="turn"){
    const current=FIVE_ELEMENTS.indexOf(actorAttribute),next=FIVE_ELEMENTS[(current+definition.steps%5+5)%5];setAttributeForSide(state,side,next);battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${card.name}を使用し、${elementName[actorAttribute]}から${elementName[next]}へ転輪した。`);
  }else{
    const master=shikigamiById.get(definition.shikigamiId)!;actor.shikigami.push(createShikigami(master));battle.log.push(`${side==="player"?"プレイヤー":"CPU"}が${master.name}を召喚した。`);
  }
  if(generates[actorAttribute]===cardElement){actor.mp=Math.min(30,actor.mp+1);battle.log.push("相生成立：MPが1増加した。")}
  const [used]=hand.splice(index,1);used.playable=false;used.unusableReason="使用済みです。";used.playTarget=undefined;discardForSide(session,side).push(used);if(side==="cpu")battle.cpu.handCount=session.cpuHand.length;triggerBurnAfterCard(state,side);finishIfNeeded(state);refreshPlayability(state);return {ok:true};
}
function usePlayerCard(session:StoredSession,instanceId:string,target:CardTarget):{ok:boolean;message?:string}{
  const battle=session.state.battle;if(!battle||session.state.phase!=="battle"||battle.phase!=="card_use"||battle.activePlayer!=="player")return {ok:false,message:"現在はカードを使用できません。"};const index=battle.player.hand.findIndex(card=>card.instanceId===instanceId);return executeCard(session,"player",index,target);
}
function chooseUnitTarget(state:SessionState,side:Side,unit:ShikigamiState):UnitTarget{
  const opponent=stateForSide(state,otherSide(side));const taunts=opponent.shikigami.filter(target=>target.keywords.includes("挑発"));let units=taunts.length?taunts:opponent.shikigami.filter(target=>!target.keywords.includes("ステルス"));if(taunts.length)return {type:"unit",unit:taunts[randomInt(taunts.length)]};
  if(unit.aiProfile.includes("相手式神")||unit.aiProfile.includes("攻撃力が最も高い")){if(units.length){if(unit.aiProfile.includes("攻撃力"))units=[...units].sort((a,b)=>b.attack-a.attack);return {type:"unit",unit:units[0]}}}
  if(unit.aiProfile.includes("HPが最も低い")){const all:UnitTarget[]=[{type:"player"},...units.map(target=>({type:"unit" as const,unit:target}))];return all.sort((a,b)=>(a.type==="player"?opponent.hp:a.unit.hp)-(b.type==="player"?opponent.hp:b.unit.hp))[0]}
  if(unit.aiProfile.includes("ランダム")){const all:UnitTarget[]=[{type:"player"},...units.map(target=>({type:"unit" as const,unit:target}))];return all[randomInt(all.length)]}
  return {type:"player"};
}
function targetAttribute(state:SessionState,side:Side,target:UnitTarget):FiveElement|undefined{return target.type==="player"?attributeForSide(state,otherSide(side)):cardAttributeToElement[target.unit.attribute]}
function runOneShikigamiAction(state:SessionState,side:Side,unit:ShikigamiState):void{
  const battle=state.battle!,actor=stateForSide(state,side),opponentSide=otherSide(side),opponent=stateForSide(state,opponentSide);
  if(unit.shikigamiId==="shikigami_genki"&&unit.hp<=unit.maxHp/2&&unit.nextDamageReduction<2){unit.nextDamageReduction=2;battle.log.push(`${unit.name}は甲羅籠りを行った。`);return}
  const target=chooseUnitTarget(state,side,unit),unitElement=cardAttributeToElement[unit.attribute]!,targetElement=targetAttribute(state,side,target);let total=unit.attack+(unitElement===attributeForSide(state,side)?1:0)+(targetElement&&overcomes[unitElement]===targetElement?2:0);
  if(unit.shikigamiId==="shikigami_hakuro"){const hpValues=[opponent.hp,...opponent.shikigami.map(enemy=>enemy.hp)];const targetHp=target.type==="player"?opponent.hp:target.unit.hp;if(targetHp===Math.min(...hpValues))total+=1}
  const hits=unit.shikigamiId==="shikigami_kamaitachi"?[Math.ceil(total/2),Math.floor(total/2)]:[total];let dealt=0;for(const hit of hits){if(target.type==="player")dealt+=applyDamageToPlayer(state,opponentSide,hit);else if(target.unit.hp>0)dealt+=applyDamageToUnit(target.unit,hit)}
  battle.log.push(`${unit.name}が${target.type==="player"?(side==="player"?"CPU":"プレイヤー"):target.unit.name}へ${dealt}ダメージ。`);
  if(unit.shikigamiId==="shikigami_orochi"&&target.type==="unit"&&dealt>0&&target.unit.hp>0)addCurse(target.unit.curses,"curse_poison");
  if(unit.shikigamiId==="shikigami_hinotori"&&dealt>0){if(target.type==="player")addCurse(opponent.curses,"curse_burn");else if(target.unit.hp>0)addCurse(target.unit.curses,"curse_burn")}
  if(unit.shikigamiId==="shikigami_karasutengu"){const others=opponent.shikigami.filter(enemy=>target.type!=="unit"||enemy.instanceId!==target.unit.instanceId);if(others.length){const splash=others[randomInt(others.length)];applyDamageToUnit(splash,1);battle.log.push(`天狗風により${splash.name}へ1ダメージ。`)}}
  cleanupUnits(state,opponentSide);
  if(unit.shikigamiId==="shikigami_kanko")actor.mp=Math.min(30,actor.mp+1);
  if(unit.shikigamiId==="shikigami_kappa"&&actor.shikigami.length){const heal=[...actor.shikigami].sort((a,b)=>a.hp/a.maxHp-b.hp/b.maxHp)[0];heal.hp=Math.min(heal.maxHp,heal.hp+1);battle.log.push(`水薬により${heal.name}のHPが1回復。`)}
  if(unit.shikigamiId==="shikigami_komainu")unit.nextDamageReduction=Math.max(unit.nextDamageReduction,1);
}
function runShikigamiPhase(state:SessionState,side:Side):void{for(const instanceId of stateForSide(state,side).shikigami.map(unit=>unit.instanceId)){const unit=stateForSide(state,side).shikigami.find(candidate=>candidate.instanceId===instanceId);if(!unit||finishIfNeeded(state))break;runOneShikigamiAction(state,side,unit)}}
function resolvePoisonAtTurnEnd(state:SessionState,side:Side):void{
  const battle=state.battle!,owner=stateForSide(state,side),poison=owner.curses.find(curse=>curse.id==="curse_poison");if(poison){const damage=applyDamageToPlayer(state,side,poison.stacks);battle.log.push(`毒により${side==="player"?"プレイヤー":"CPU"}へ${damage}ダメージ。`)}
  for(const unit of owner.shikigami){const curse=unit.curses.find(item=>item.id==="curse_poison");if(curse){const damage=applyDamageToUnit(unit,curse.stacks);battle.log.push(`毒により${unit.name}へ${damage}ダメージ。`)}}cleanupUnits(state,side);finishIfNeeded(state);
}
function cpuUseCards(session:StoredSession):void{
  const state=session.state,battle=state.battle!;for(let action=0;action<5&&!finishIfNeeded(state);action++){
    const candidates=session.cpuHand.map((card,index)=>({card,index,definition:effectByCardId.get(card.cardId)})).filter(item=>item.definition&&!isDefinitionUsable(state,"cpu",item.card,item.definition));if(!candidates.length)break;
    const score=(item:typeof candidates[number])=>item.definition!.type==="attack"?3:item.definition!.type==="summon"?2:1;const best=Math.max(...candidates.map(score)),choices=candidates.filter(item=>score(item)===best),chosen=choices[randomInt(choices.length)];executeCard(session,"cpu",chosen.index);
  }battle.cpu.handCount=session.cpuHand.length;
}
function endPlayerTurn(session:StoredSession):{ok:boolean;message?:string}{
  const state=session.state,battle=state.battle;if(!battle||battle.phase!=="card_use"||battle.activePlayer!=="player")return {ok:false,message:"現在はターンを終了できません。"};battle.phase="resolving";battle.log.push("プレイヤーの式神行動フェーズ。");runShikigamiPhase(state,"player");resolvePoisonAtTurnEnd(state,"player");if(finishIfNeeded(state)){refreshPlayability(state);return {ok:true}}
  battle.activePlayer="cpu";stateForSide(state,"cpu").cost=5;drawToLimit(session.cpuHand,5);battle.cpu.handCount=session.cpuHand.length;battle.log.push("CPUターン開始。");cpuUseCards(session);runShikigamiPhase(state,"cpu");resolvePoisonAtTurnEnd(state,"cpu");if(finishIfNeeded(state)){refreshPlayability(state);return {ok:true}}
  battle.turnNumber+=1;battle.activePlayer="player";battle.phase="card_use";battle.player.cost=5;drawToLimit(battle.player.hand,5);battle.log.push(`第${battle.turnNumber}ターン開始。手札とコストを更新した。`);refreshPlayability(state);return {ok:true};
}

app.get("/health",(_request,response)=>response.json({status:"ok"}));app.use(express.static(distributionDirectory));app.get("/",(_request,response)=>response.type("html").send(rootDocument));
io.on("connection",socket=>{
  sendState(socket.id,{phase:"title"});
  socket.on("session:resume",(token,callback)=>{const session=sessions.get(token);if(!session){callback({ok:false,message:"復帰できる対戦がありません。"});return}socketTokens.set(socket.id,token);refreshPlayability(session.state);callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("cpu:start",({playerName},callback)=>{const name=playerName.trim();if(!name){callback({ok:false,message:"プレイヤー名を入力してください。"});return}const previous=socketTokens.get(socket.id);if(previous)sessions.delete(previous);const token=randomUUID(),state:SessionState={phase:"attribute_selection",reconnectToken:token,playerName:name};sessions.set(token,{state,cpuHand:[],cpuDiscard:[]});socketTokens.set(socket.id,token);callback({ok:true,state:publicState(state)});sendState(socket.id,state)});
  socket.on("attribute:select",({attribute},callback)=>{const session=currentSession(socket.id);if(!session||session.state.phase!=="attribute_selection"){callback({ok:false,message:"現在は属性を選択できません。"});return}if(!FIVE_ELEMENTS.includes(attribute)){callback({ok:false,message:"選択した属性が不正です。"});return}session.state.playerAttribute=attribute;session.state.cpuAttribute=FIVE_ELEMENTS[randomInt(FIVE_ELEMENTS.length)];session.state.phase="attribute_reveal";callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("match:enter",callback=>{const session=currentSession(socket.id);if(!session||session.state.phase!=="attribute_reveal"){callback({ok:false,message:"対戦を開始できません。"});return}const hand=drawCards(5);session.cpuHand=drawCards(5);session.state.phase="battle";session.state.battle={turnNumber:1,activePlayer:"player",phase:"card_use",player:{hp:30,mp:0,cost:5,curses:[],nextDamageReduction:0,shikigami:[],hand,discard:[]},cpu:{hp:30,mp:0,cost:5,curses:[],nextDamageReduction:0,shikigami:[],handCount:session.cpuHand.length},log:["対戦を開始した。双方が5枚引いた。"]};refreshPlayability(session.state);callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("card:use",({instanceId,target},callback)=>{const session=currentSession(socket.id);if(!session){callback({ok:false,message:"対戦情報がありません。"});return}const result=usePlayerCard(session,instanceId,target);if(!result.ok){callback(result);return}callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("turn:end",callback=>{const session=currentSession(socket.id);if(!session){callback({ok:false,message:"対戦情報がありません。"});return}const result=endPlayerTurn(session);if(!result.ok){callback(result);return}callback({ok:true,state:publicState(session.state)});sendState(socket.id,session.state)});
  socket.on("session:reset",callback=>{const token=socketTokens.get(socket.id);if(token)sessions.delete(token);socketTokens.delete(socket.id);const state:SessionState={phase:"title"};callback({ok:true,state});sendState(socket.id,state)});socket.on("disconnect",()=>socketTokens.delete(socket.id));
});
server.listen(port,()=>console.log(`五行転輪 server listening on port ${port}`));