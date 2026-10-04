import { z } from "zod";
import { deckForPlayerCount, isWolfRole, roleLabel, WEREWOLF_ROLES, type WerewolfRoleId } from "../../society/scenarios/werewolf/roles";
import { fact, RunError, type ActionSpec, type Character, type Channel, type EventDraft, type ScenarioAdapter, type Stage } from "../types";

type Choice = string | boolean | null;
function choice(name: string, label: string, field: string, options: { label: string; value: Choice }[], description = label): ActionSpec {
  const schema = z.literal(options.map(o => o.value));
  return { name, label, description: `${description}。选项：${options.map(o => `${JSON.stringify(o.value)}=${o.label}`).join("；")}`, parameters: z.object({ [field]: schema }).strict(), fields: [{ name: field, label, type: "choice", options }] };
}
export function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed | 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const j = (state >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class WerewolfScenario implements ScenarioAdapter {
  checkpoint() { return structuredClone({ ...this }); }
  restore(checkpoint: unknown) { Object.assign(this, structuredClone(checkpoint)); }
  private roles: Record<string, WerewolfRoleId>;
  private alive: Set<string>;
  private revealed: Record<string, WerewolfRoleId> = {};
  private day = 1;
  private phase = "sheriff-run";
  private generation = 0;
  private decisions: Record<string, Record<string, Choice>> = {};
  private candidates: string[] = [];
  private ran = new Set<string>();
  private sheriff?: string;
  private sheriffTie = false;
  private pk: string[] = [];
  private pkHeld = false;
  private disenfranchised = new Set<string>();
  private curse?: string;
  private charm?: string;
  private antidote = true;
  private poison = true;
  private lastGuard?: string;
  private knightUsed = false;
  private nightTarget?: string;
  private nightChoices: Record<string, Record<string, Choice>> = {};
  private realigned = false;
  private pending: Array<{ actor: string; kind: "badge" | "last-words" | "shot" }> = [];
  private knowledge: Record<string, Record<string, WerewolfRoleId>> = {};
  private jesterWinners: string[] = [];
  private winners: string[] = [];
  constructor(readonly characters: Character[], readonly rounds: number, seed: number) {
    const roles = shuffled(deckForPlayerCount(characters.length).roles, seed);
    this.roles = Object.fromEntries(characters.map((c, i) => [c.id, roles[i]]));
    this.alive = new Set(this.ids);
  }
  private get ids() { return this.characters.map(c => c.id); }
  private get living() { return this.ids.filter(id => this.alive.has(id)); }
  private get wolves() { return this.living.filter(id => isWolfRole(this.roles[id])); }
  private name(id: string) { return this.characters.find(c => c.id === id)!.name; }
  private move(phase: string) { this.phase = phase; this.generation++; this.decisions = {}; }
  private done(id: string, action: string) { return Object.hasOwn(this.decisions[id] ?? {}, action); }
  private electorate() { return this.living.filter(id => !this.ran.has(id)); }
  private voters() { return this.living.filter(id => !this.disenfranchised.has(id) && id !== this.curse && !this.pk.includes(id)); }
  stage(): Stage | undefined {
    if (this.phase === "done") return;
    const p = this.pending[0];
    if (p) return { id: `${this.day}:${this.generation}:${p.kind}:${p.actor}`, label: { badge: "移交警徽", "last-words": "遗言", shot: "开枪决定" }[p.kind], round: this.day, kind: p.kind === "last-words" ? "discussion" : "action", channel: "public", actors: [p.actor], ...(p.kind === "last-words" ? { turnLimit: 1 } : {}) };
    const labels: Record<string, string> = { "sheriff-run": "上警", campaign: "竞选交流", withdraw: "退选", "sheriff-vote": "警长投票", "sheriff-pk": "警长平票", discussion: "白天交流", knight: "骑士决斗", vote: "投票中", pk: "平票陈词", pack: "狼队交流", "pack-vote": "夜袭提名", "pack-realign": "狼队重新交流", night: "夜间行动", witch: "药水决定", dawn: "等待天亮" };
    let actors = this.living;
    if (["campaign", "withdraw", "sheriff-pk"].includes(this.phase)) actors = this.candidates;
    if (this.phase === "sheriff-vote") actors = this.electorate();
    if (this.phase === "vote") actors = this.voters();
    if (this.phase === "pk") actors = this.pk;
    if (["pack", "pack-vote", "pack-realign"].includes(this.phase)) actors = this.wolves;
    if (this.phase === "knight") actors = this.living.filter(id => this.roles[id] === "knight" && !this.knightUsed);
    if (this.phase === "night") actors = this.living.filter(id => ["seer", "guard", "nightmare", "wolf-beauty"].includes(this.roles[id]) || this.roles[id] === "spirit-seer" && this.living.length < this.ids.length);
    if (this.phase === "witch") actors = this.living.filter(id => this.roles[id] === "witch" && (this.antidote || this.poison));
    if (this.phase === "dawn") actors = [];
    const discussion = ["campaign", "sheriff-pk", "discussion", "pk", "pack", "pack-realign"].includes(this.phase);
    return { id: `${this.day}:${this.generation}:${this.phase}`, label: labels[this.phase], round: this.day, kind: discussion ? "discussion" : "action", actors, channel: this.phase.startsWith("pack") ? "team" : "public" };
  }
  observe(id: string): string {
    const role = this.roles[id];
    return [
      "这是虚构的桌面身份游戏。所有动作只改变本局玩家的在场、出局或查验状态；计划与交流用选择、投票、守护、出局描述这些规则效果。",
      `第${this.day}/${this.rounds}天，${this.stage()?.label ?? "已结束"}。本局身份：${roleLabel(role)}。${WEREWOLF_ROLES[role].objective}`,
      `存活：${this.living.map(id => this.name(id)).join("、")}。${this.sheriff ? `警长：${this.name(this.sheriff)}，日票权重1.5。` : "暂无警长。"}`,
      isWolfRole(role) ? `本局狼队：${this.ids.filter(id => isWolfRole(this.roles[id])).map(id => this.name(id)).join("、")}。` : "",
      Object.keys(this.knowledge[id] ?? {}).length ? `你的查验：${Object.entries(this.knowledge[id]).map(([id, role]) => `${this.name(id)}=${roleLabel(role)}`).join("；")}。` : "",
      role === "witch" ? `解药${this.antidote ? "可用" : "已用"}，毒药${this.poison ? "可用" : "已用"}。${this.antidote && this.phase === "witch" && this.nightTarget ? `今晚被袭击者：${this.name(this.nightTarget)}。` : ""}` : "",
      role === "guard" && this.lastGuard ? `上一夜守护：${this.name(this.lastGuard)}，今晚不可重复。` : "",
      this.curse === id ? "你今天被诅咒，不能投票。" : "",
      "日票全部提交后公开；平票者陈词后重新投票，第二次平票无人出局。出局揭晓身份；小丑被投出单独获胜后对局继续。狼人达到人数优势，或村庄未在期限内使全部狼队角色出局，则狼队获胜。",
    ].filter(Boolean).join("\n");
  }
  observation(actorId: string) {
    return { actorId, stageId: this.stage()?.id ?? "done", round: this.day, rules: this.observe(actorId),
      facts: { ...this.publicState(), participants: this.characters.map(c => ({ id: c.id, name: c.name })),
        ownRole: this.roles[actorId], knowledge: { ...this.knowledge[actorId] },
        ...(isWolfRole(this.roles[actorId]) ? { teammates: this.ids.filter(id => isWolfRole(this.roles[id])) } : {}) },
      legalActions: this.actions(actorId).map(a => ({ name: a.name, description: a.description })) };
  }
  private targetAction(name: string, label: string, ids: string[], optional = false, description?: string): ActionSpec {
    const options: { label: string; value: Choice }[] = ids.map(id => ({ label: this.name(id), value: id }));
    if (optional) options.push({ label: "跳过", value: null });
    return choice(name, label, "targetId", options, description);
  }
  actions(id: string): ActionSpec[] {
    const stage = this.stage();
    if (stage?.kind !== "action" || !stage.actors.includes(id)) return [];
    const p = this.pending[0];
    if (p?.kind === "badge") return [this.targetAction("pass_badge", "移交警徽", this.living, true, "指定新警长；null为撕掉警徽。")];
    if (p?.kind === "shot") return [this.targetAction("shoot", "开枪", this.living, true, "选择存活玩家或null压枪。")];
    let result: ActionSpec[] = [];
    if (this.phase === "sheriff-run") result = [choice("run_for_sheriff", "上警", "run", [{ label: "上警", value: true }, { label: "不上警", value: false }])];
    if (this.phase === "withdraw") result = [choice("withdraw", "退选", "withdraw", [{ label: "留任", value: false }, ...(this.candidates.length > 1 ? [{ label: "退选", value: true }] : [])])];
    if (this.phase === "sheriff-vote") result = [this.targetAction("elect_sheriff", "警长投票", this.candidates)];
    if (this.phase === "vote") result = [this.targetAction("vote", "投票", this.pk.length ? this.pk : this.living)];
    if (this.phase === "knight") result = [this.targetAction("duel", "决斗", this.living.filter(x => x !== id), true, "目标为狼则目标死亡，否则自己死亡；null放弃本局决斗。")];
    if (this.phase === "pack-vote") result = [this.targetAction("attack", "夜袭提名", this.living.filter(x => !isWolfRole(this.roles[x])))];
    if (this.phase === "night") {
      const role = this.roles[id];
      if (role === "seer") result.push(this.targetAction("inspect", "查验", this.living.filter(x => x !== id)));
      if (role === "spirit-seer") result.push(this.targetAction("inspect_dead", "查验死者", this.ids.filter(x => !this.alive.has(x))));
      if (role === "guard") result.push(this.targetAction("guard", "守护", this.living.filter(x => x !== this.lastGuard), true, "不能连守；守护与解药同时落在狼刀目标上仍会死亡；守护不抵挡毒药。"));
      if (role === "nightmare" || role === "wolf-beauty") result.push(this.targetAction(role === "nightmare" ? "curse" : "charm", role === "nightmare" ? "诅咒" : "魅惑", this.living.filter(x => !isWolfRole(this.roles[x])), true));
    }
    if (this.phase === "witch") {
      const options: { label: string; value: Choice }[] = [{ label: "不用药", value: "pass" }];
      if (this.antidote && this.nightTarget && this.nightTarget !== id) options.push({ label: `救${this.name(this.nightTarget)}`, value: "save" });
      if (this.poison) options.push(...this.living.map(id => ({ label: `毒${this.name(id)}`, value: `poison:${id}` })));
      result = [choice("potion", "药水", "choice", options, "一夜只可用一瓶药；解药不可自救。")];
    }
    return result.filter(a => !this.done(id, a.name));
  }
  apply(id: string, name: string, input: unknown): EventDraft[] {
    const spec = this.actions(id).find(a => a.name === name);
    if (!spec) throw new RunError("这项行动当前不可用或已经提交");
    const parsed = spec.parameters.parse(input);
    const value = Object.values(parsed)[0] as Choice;
    const events: EventDraft[] = [];
    if (name === "withdraw" && value === true && this.candidates.length <= 1) throw new RunError("最后一位候选人不能退选");
    (this.decisions[id] ??= {})[name] = value;
    const publicAction = ["pass_badge", "shoot", "duel"].includes(name);
    const selected = spec.fields[0].options!.find(o => o.value === value)!.label;
    events.push({ type: "action", actorId: id, visibility: publicAction ? "public" : [id], text: `${this.name(id)}：${selected}`, data: { action: name, input: parsed, day: this.day } });
    if (name === "withdraw" && value === true) this.candidates = this.candidates.filter(x => x !== id);
    if (name === "inspect" || name === "inspect_dead") {
      const target = value as string;
      const role = name === "inspect" && this.roles[target] === "hidden-wolf" ? "villager" : this.roles[target];
      (this.knowledge[id] ??= {})[target] = role;
      events.push(fact(`${this.name(target)}的查验结果：${roleLabel(role)}`, { target, role, day: this.day }, [id]));
    }
    if (name === "pass_badge") {
      this.pending.shift(); this.sheriff = typeof value === "string" ? value : undefined;
      events.push(fact(this.sheriff ? `${this.name(this.sheriff)}成为警长` : "警徽已撕毁", { sheriff: this.sheriff ?? null }));
    }
    if (name === "shoot") { this.pending.shift(); if (typeof value === "string") this.kill(value, "shot", events); }
    if (name === "duel") { this.knightUsed = true; if (typeof value === "string") this.kill(isWolfRole(this.roles[value]) ? value : id, "duel", events); }
    if (["pass_badge", "shoot", "duel"].includes(name)) this.checkWin(events);
    return events;
  }
  advance(): EventDraft[] {
    if (this.stage()?.kind === "action" && this.stage()!.actors.some(id => this.actions(id).length)) throw new RunError("仍有未完成的行动");
    if (this.pending[0]?.kind === "last-words") { this.pending.shift(); this.generation++; const events: EventDraft[] = []; this.checkWin(events); return events; }
    if (this.pending.length) return [];
    const events: EventDraft[] = [];
    const votes = (name: string) => Object.fromEntries(Object.entries(this.decisions).filter(([, d]) => typeof d[name] === "string").map(([id, d]) => [id, d[name] as string]));
    if (this.phase === "sheriff-run") {
      this.candidates = this.living.filter(id => this.decisions[id]?.run_for_sheriff === true); this.ran = new Set(this.candidates);
      events.push(fact(this.candidates.length ? `上警：${this.candidates.map(id => this.name(id)).join("、")}` : "无人上警", { candidates: this.candidates }));
      if (this.candidates.length === 1) { this.sheriff = this.candidates[0]; this.move("discussion"); }
      else this.move(this.candidates.length && this.electorate().length ? "campaign" : "discussion");
    } else if (this.phase === "campaign") this.move("withdraw");
    else if (this.phase === "withdraw") {
      if (this.candidates.length === 1) { this.sheriff = this.candidates[0]; events.push(fact(`${this.name(this.sheriff)}成为警长`, { sheriff: this.sheriff })); this.move("discussion"); }
      else this.move("sheriff-vote");
    } else if (this.phase === "sheriff-pk") this.move("sheriff-vote");
    else if (this.phase === "sheriff-vote") {
      const ballots = votes("elect_sheriff"); const top = this.tally(ballots, false);
      events.push(fact("警长票已揭晓", { ballots, settlement: true }));
      if (top.length > 1 && !this.sheriffTie) { this.candidates = top; this.sheriffTie = true; this.move("sheriff-pk"); }
      else { this.sheriff = top.length === 1 ? top[0] : undefined; events.push(fact(this.sheriff ? `${this.name(this.sheriff)}当选警长` : "警长再次平票，无人当选", { sheriff: this.sheriff ?? null })); this.move("discussion"); }
    } else if (this.phase === "discussion") this.move(this.living.some(id => this.roles[id] === "knight") && !this.knightUsed ? "knight" : "vote");
    else if (this.phase === "knight") { this.move("vote"); this.checkWin(events); }
    else if (this.phase === "pk") this.move("vote");
    else if (this.phase === "vote") {
      const ballots = votes("vote"); const top = this.tally(ballots, true);
      events.push(fact(`投票揭晓：${Object.entries(ballots).map(([id, target]) => `${this.name(id)}→${this.name(target)}`).join("；")}`, { ballots, settlement: true, day: this.day }));
      if (top.length > 1 && !this.pkHeld) { this.pk = top.slice(0, 2); this.pkHeld = true; this.move("pk"); }
      else {
        if (top.length === 1) {
          const id = top[0]; const role = this.roles[id];
          if (role === "idiot" && !this.disenfranchised.has(id)) { this.disenfranchised.add(id); this.revealed[id] = role; events.push(fact(`${this.name(id)}亮明白痴身份，免死并失去投票权`, { actorId: id, role })); }
          else {
            this.kill(id, "vote", events);
            if (role === "jester") { this.jesterWinners.push(id); events.push(fact(`${this.name(id)}以小丑身份单独获胜，对局继续`, { winner: id })); }
            if (role === "white-wolf-king") for (const [voter, target] of Object.entries(ballots)) if (target === id) this.kill(voter, "boom", events);
            if (role === "wolf-beauty" && this.charm) this.kill(this.charm, "charm", events);
          }
        } else events.push(fact("再次平票，无人出局"));
        this.curse = undefined; this.charm = undefined; this.pk = []; this.move("pack"); this.checkWin(events);
      }
    } else if (this.phase === "pack" || this.phase === "pack-realign") this.move("pack-vote");
    else if (this.phase === "pack-vote") {
      const ballots = votes("attack"); const top = this.tally(ballots, false);
      if (top.length > 1 && !this.realigned) { this.realigned = true; events.push(fact("狼队提名平票，可重新讨论", { ballots }, this.wolves)); this.move("pack-realign"); }
      else { this.nightTarget = top.sort()[0]; this.move("night"); }
    } else if (this.phase === "night") { this.nightChoices = this.decisions; this.move("witch"); }
    else if (this.phase === "witch") {
      const potion = Object.values(this.decisions).find(d => d.potion)?.potion as string | undefined;
      const guard = Object.values(this.nightChoices).find(d => Object.hasOwn(d, "guard"))?.guard;
      const save = potion === "save";
      if (save) this.antidote = false;
      const poisoned = potion?.startsWith("poison:") ? potion.slice(7) : undefined;
      if (poisoned) this.poison = false;
      const target = this.nightTarget;
      const guarded = guard === target;
      // Both protections on the same victim cancel each other in the existing rules.
      if (target && ((!guarded && !save) || (guarded && save))) this.kill(target, poisoned === target ? "poison" : "night", events);
      if (poisoned) this.kill(poisoned, "poison", events);
      this.lastGuard = typeof guard === "string" ? guard : undefined;
      const curse = Object.values(this.nightChoices).find(d => d.curse)?.curse;
      const charm = Object.values(this.nightChoices).find(d => d.charm)?.charm;
      this.curse = typeof curse === "string" ? curse : undefined; this.charm = typeof charm === "string" ? charm : undefined;
      events.push(fact("天亮了", { day: this.day, alive: this.living, settlement: true }));
      this.move("dawn"); this.checkWin(events);
    } else if (this.phase === "dawn") {
      if (!this.checkWin(events)) {
        if (this.day >= this.rounds) this.finish(true, events);
        else { this.day++; this.pkHeld = false; this.realigned = false; this.nightTarget = undefined; this.nightChoices = {}; this.move("discussion"); }
      }
    }
    return events;
  }
  private tally(ballots: Record<string, string>, weighted: boolean) {
    const counts = new Map<string, number>();
    for (const [id, target] of Object.entries(ballots)) counts.set(target, (counts.get(target) ?? 0) + (weighted && this.sheriff === id ? 1.5 : 1));
    const max = Math.max(0, ...counts.values()); return [...counts].filter(([, n]) => n === max).map(([id]) => id);
  }
  private kill(id: string, cause: string, events: EventDraft[]) {
    if (!this.alive.delete(id)) return;
    const role = this.roles[id]; this.revealed[id] = role;
    events.push(fact(`${this.name(id)}出局，身份是${roleLabel(role)}`, { actorId: id, role, cause, day: this.day }));
    if (this.sheriff === id) { this.sheriff = undefined; this.pending.push({ actor: id, kind: "badge" }); }
    if (cause === "vote" && role !== "jester") this.pending.push({ actor: id, kind: "last-words" });
    if (role === "hunter" && cause !== "poison" || role === "wolf-king" && ["vote", "shot"].includes(cause)) this.pending.push({ actor: id, kind: "shot" });
  }
  private checkWin(events: EventDraft[]) {
    if (this.pending.length) return false;
    if (this.wolves.length === 0) { this.finish(false, events); return true; }
    if (this.wolves.length >= this.living.length - this.wolves.length) { this.finish(true, events); return true; }
    return false;
  }
  private finish(wolvesWin: boolean, events: EventDraft[]) {
    this.winners = [...this.jesterWinners, ...this.ids.filter(id => wolvesWin ? isWolfRole(this.roles[id]) : WEREWOLF_ROLES[this.roles[id]].faction === "village")];
    this.move("done"); events.push(fact(wolvesWin ? "狼人阵营获胜" : "村庄阵营获胜", { winners: this.winners, roles: this.roles, day: this.day, settlement: true }));
  }
  publicState() { return { scenario: "werewolf", round: this.day, phase: this.stage()?.label ?? "已结束", alive: this.living, revealed: { ...this.revealed }, sheriff: this.sheriff, winners: this.winners }; }
  canMessage(id: string, channel: Channel, recipients: string[]) {
    const stage = this.stage();
    if (!stage || stage.kind !== "discussion") return false;
    if (this.pending[0]?.kind === "last-words") return id === this.pending[0].actor && channel === "public";
    if (!this.alive.has(id) || !recipients.every(x => this.alive.has(x))) return false;
    if (this.phase.startsWith("pack")) return channel === "team" && this.wolves.includes(id) && recipients.every(x => this.wolves.includes(x));
    return channel !== "team" && (channel !== "public" || stage.actors.includes(id));
  }
}
