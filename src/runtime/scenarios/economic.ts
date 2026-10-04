import { z } from "zod";
import { fact, RunError, type ActionSpec, type Character, type EventDraft, type ScenarioAdapter, type Stage, type Channel } from "../types";
import { contributionPayoff, trustPayoffs } from "./payoffs";

export function numberAction(name: string, label: string, max: number): ActionSpec {
  return { name, label, description: `${label}，整数 0–${max}。提交后不可撤回。`, parameters: z.object({ amount: z.number().int().min(0).max(max) }).strict(), fields: [{ name: "amount", label, type: "number", min: 0, max }] };
}

export class EconomicScenario implements ScenarioAdapter {
  checkpoint() { return structuredClone({ ...this }); }
  restore(checkpoint: unknown) { Object.assign(this, structuredClone(checkpoint)); }
  private round = 1;
  private phase = "discussion";
  private amounts: Record<string, number> = {};
  private scores: Record<string, number>;
  private history: Record<string, unknown>[] = [];
  private pledge?: number;
  private repair?: number;
  constructor(readonly scenario: "trust-game" | "public-goods", readonly characters: Character[], readonly rounds: number, readonly protocol: "classic" | "pledge-repair" = "classic") {
    const n = characters.length;
    if (scenario === "trust-game" ? n !== 2 : n < 3 || n > 8) throw new RunError("场景人数不符", 400);
    this.scores = Object.fromEntries(characters.map(c => [c.id, 0]));
  }
  private get ids() { return this.characters.map(c => c.id); }
  private get investor() { return this.ids[(this.round - 1) % 2]; }
  private get trustee() { return this.ids[this.round % 2]; }
  private name(id: string) { return this.characters.find(c => c.id === id)!.name; }
  stage(): Stage | undefined {
    if (this.phase === "done") return;
    const discussion = ["discussion", "response", "reflection", "after-repair"].includes(this.phase);
    const labels: Record<string, string> = { discussion: "自由交流", pledge: "作出承诺", response: "投资已到账", reflection: "面对结果", repair: "是否付出补偿", "after-repair": "回应补偿", invest: "投资中", return: "返还中", contribute: "投入中" };
    return { id: `${this.round}:${this.phase}`, round: this.round, label: labels[this.phase], kind: discussion ? "discussion" : "action", channel: "public", actors: discussion || this.phase === "contribute" ? this.ids : [this.phase === "invest" ? this.investor : this.trustee] };
  }
  observe(actorId: string) {
    const rule = this.scenario === "trust-game"
      ? `本轮${this.name(this.investor)}为投资者，${this.name(this.trustee)}为受托者。投资者有10点，可投资0–10点；投资变为3倍交给受托者，受托者决定返还0到到账总额。投资者所得=10−投资+返还；受托者所得=3×投资−返还。${this.round < this.rounds ? `下一轮${this.name(this.trustee)}决定投资，${this.name(this.investor)}决定返还。` : "这是最后一轮，之后没有新的交易。"}`
      : `每人每轮有10点，可向公共池投入0–10点。所有人提交后公开，池内资源乘1.6再均分。每人所得=10−自己投入+公共池×1.6/${this.ids.length}。`;
    const protocol = this.scenario === "trust-game" && this.protocol === "pledge-repair" ? `\n受托者在投资前公开承诺返还到账资源的0–100%。承诺不强制执行，实际返还仍由自己决定，系统会核对兑现。结算后受托者可从自己累计所得中真实转出补偿；可以选择0，道歉不自动改变资源。${this.pledge === undefined ? "本轮尚未承诺。" : `本轮承诺返还到账的${this.pledge}%，${this.amounts[this.investor] === undefined ? "尚未投资，最低承诺金额待到账后确定" : `最低承诺金额为${Math.floor(this.amounts[this.investor] * 3 * this.pledge / 100)}点`}。`}${this.repair === undefined ? "" : `本轮实际额外补偿${this.repair}点。`}` : "";
    return `${rule}\n共${this.rounds}轮，本轮是第${this.round}轮，${this.stage()?.label ?? "已结束"}。你的累计得分：${this.scores[actorId]}。${this.amounts[this.investor] !== undefined && this.scenario === "trust-game" ? `本轮已投资${this.amounts[this.investor]}点。` : ""}${protocol}`;
  }
  observation(actorId: string) {
    return { actorId, stageId: this.stage()?.id ?? "done", round: this.round,
      rules: this.observe(actorId),
      facts: { ...this.publicState(), participants: this.characters.map(c => ({ id: c.id, name: c.name })), ownRole: this.scenario === "trust-game" ? actorId === this.investor ? "investor" : "trustee" : "contributor", ownScore: this.scores[actorId],
        ...(this.scenario === "trust-game" ? { fundingRecipientId: this.trustee, receivedByTrustee: this.amounts[this.investor] === undefined ? null : 3 * this.amounts[this.investor], investmentSubmitted: this.amounts[this.investor] !== undefined } : {}) },
      legalActions: this.actions(actorId).map(a => ({ name: a.name, description: a.description })) };
  }
  actions(actorId: string): ActionSpec[] {
    const stage = this.stage();
    if (stage?.kind !== "action" || !stage.actors.includes(actorId)) return [];
    if (this.phase === "pledge") return this.pledge === undefined ? [numberAction("pledge_return", "承诺返还比例（%）", 100)] : [];
    if (this.phase === "repair") return this.repair === undefined ? [numberAction("repair_transfer", "额外补偿", Math.floor(this.scores[actorId]))] : [];
    if (this.amounts[actorId] !== undefined) return [];
    return [this.phase === "invest" ? numberAction("invest", "投资", 10) : this.phase === "return" ? numberAction("return_funds", "返还", this.amounts[this.investor] * 3) : numberAction("contribute", "投入", 10)];
  }
  apply(actorId: string, name: string, input: unknown): EventDraft[] {
    const action = this.actions(actorId).find(a => a.name === name);
    if (!action) throw new RunError("这项行动当前不可用或已经提交");
    const { amount } = action.parameters.parse(input) as { amount: number };
    if (name === "pledge_return") {
      this.pledge = amount;
      return [{ type: "action", actorId, visibility: "public", text: `${this.name(actorId)}承诺返还到账资源的 ${amount}%`, data: { action: name, amount, round: this.round, targetId: this.investor, nonbinding: true } }];
    }
    if (name === "repair_transfer") {
      this.repair = amount; this.scores[actorId] -= amount; this.scores[this.investor] += amount;
      return [{ type: "action", actorId, visibility: "public", text: amount ? `${this.name(actorId)}从自己的所得中向${this.name(this.investor)}额外补偿 ${amount} 点` : `${this.name(actorId)}没有付出额外补偿`, data: { action: name, amount, round: this.round, targetId: this.investor } },
        fact(`补偿已结算：${this.name(actorId)}转出 ${amount} 点，${this.name(this.investor)}收到 ${amount} 点；是否修复关系由双方决定`, {
          round: this.round, settlement: true, settlementKind: "repair", repair: { actorId, targetId: this.investor, amount },
          payoffs: { [actorId]: amount === 0 ? 0 : -amount, [this.investor]: amount }, scores: { ...this.scores }, world: this.publicState() })];
    }
    this.amounts[actorId] = amount;
    return [{ type: "action", actorId, visibility: this.scenario === "trust-game" ? "public" : [actorId], text: `${this.name(actorId)}${action.label}了 ${amount} 点`, data: { action: name, amount, round: this.round } }];
  }
  advance(): EventDraft[] {
    if (this.stage()?.kind === "action" && this.stage()!.actors.some(id => this.actions(id).length)) throw new RunError("仍有未完成的行动");
    if (this.phase === "discussion") this.phase = this.scenario === "trust-game" ? this.protocol === "pledge-repair" ? "pledge" : "invest" : "contribute";
    else if (this.phase === "pledge") this.phase = "invest";
    else if (this.phase === "invest") this.phase = "response";
    else if (this.phase === "response") this.phase = "return";
    else if (this.phase === "reflection" && this.protocol === "pledge-repair" && this.scenario === "trust-game") this.phase = "repair";
    else if (this.phase === "repair") this.phase = "after-repair";
    else if (this.phase === "reflection" || this.phase === "after-repair") {
      if (this.round === this.rounds) { this.phase = "done"; return [fact("对局结束", this.publicState())]; }
      this.round++; this.amounts = {}; this.pledge = undefined; this.repair = undefined; this.phase = "discussion";
    } else if (this.phase === "return" || this.phase === "contribute") {
      const payoffs: Record<string, number> = {};
      if (this.scenario === "trust-game") {
        const result = trustPayoffs(this.amounts[this.investor], this.amounts[this.trustee]);
        payoffs[this.investor] = result.investor;
        payoffs[this.trustee] = result.trustee;
      } else {
        const total = Object.values(this.amounts).reduce((a, b) => a + b, 0);
        for (const id of this.ids) payoffs[id] = contributionPayoff(this.amounts[id], total, this.ids.length);
      }
      for (const id of this.ids) this.scores[id] = Math.round((this.scores[id] + payoffs[id]) * 100) / 100;
      const result = { round: this.round, amounts: { ...this.amounts }, payoffs, scores: { ...this.scores },
        ...(this.scenario === "trust-game" ? { investorId: this.investor, trusteeId: this.trustee, investment: this.amounts[this.investor], returned: this.amounts[this.trustee] } : {}) };
      this.history.push(result); this.phase = "reflection";
      const events = [fact(this.ids.map(id => `${this.name(id)}${this.scenario === "public-goods" ? `投入 ${this.amounts[id]}，` : `作为${id === this.investor ? "投资者" : "受托者"}，`}本轮获得 ${Number(payoffs[id].toFixed(2))} 点`).join("；"), { ...result, settlement: true })];
      if (this.scenario === "trust-game" && this.pledge !== undefined) {
        const promised = Math.floor(this.amounts[this.investor] * 3 * this.pledge / 100); const returned = this.amounts[this.trustee];
        events.push(fact(`${this.name(this.trustee)}${returned >= promised ? "兑现了承诺" : "未兑现承诺"}：承诺至少 ${promised} 点，实际返还 ${returned} 点`, { commitment: { actorId: this.trustee, targetId: this.investor, promised, returned, kept: returned >= promised }, round: this.round }));
      }
      return events;
    }
    return [];
  }
  publicState() { return { scenario: this.scenario, protocol: this.protocol, round: this.round, rounds: this.rounds, phase: this.stage()?.label ?? "已结束", phaseId: this.phase, scores: { ...this.scores }, history: this.history, ...(this.scenario === "trust-game" ? { investorId: this.investor, trusteeId: this.trustee, investment: this.amounts[this.investor], returned: this.amounts[this.trustee], pledge: this.pledge, repair: this.repair } : {}) }; }
  canMessage(actorId: string, channel: Channel, recipients: string[]) {
    return this.ids.includes(actorId) && this.stage()?.kind === "discussion" && channel !== "team" && recipients.every(id => this.ids.includes(id));
  }
}
