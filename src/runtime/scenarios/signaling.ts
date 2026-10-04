import { z } from "zod";
import { fact, RunError, type ActionSpec, type ActorObservation, type Channel, type Character, type EventDraft, type ScenarioAdapter, type SignalingIncentives, type Stage } from "../types";

export interface SignalingResult {
  round: number;
  incentives: SignalingIncentives;
  senderId: string;
  receiverId: string;
  highQuality: boolean;
  reportedHighQuality: boolean;
  reportAccurate: boolean;
  accepted: boolean;
  payoffs: Record<string, number>;
  scores: Record<string, number>;
}

const reportAction: ActionSpec = {
  name: "declare_quality", label: "报告质量",
  description: "向接收者公开报告本轮质量。highQuality=true 表示报告高质量，false 表示报告低质量。报告不改变真实质量，提交后不能修改；结算时核对。",
  parameters: z.object({ highQuality: z.boolean() }).strict(),
  fields: [{ name: "highQuality", label: "公开报告", type: "choice", options: [{ label: "高质量", value: true }, { label: "低质量", value: false }] }],
};
const offerAction: ActionSpec = {
  name: "choose_offer", label: "决定是否接受",
  description: "accept=true 接受本轮交易，false 拒绝。实际收益由真实质量和已公开的收益表决定；拒绝双方各得 2 点。提交后不能修改。",
  parameters: z.object({ accept: z.boolean() }).strict(),
  fields: [{ name: "accept", label: "交易决定", type: "choice", options: [{ label: "接受", value: true }, { label: "拒绝", value: false }] }],
};
const labels = { report: "发送者报告", discussion: "核对与交流", choose: "接收者决定", reflection: "公开结果与复盘", done: "已结束" };

/** Repeated, nonbinding factual reports; rules create incentives but never choose an agent's action. */
export class SignalingScenario implements ScenarioAdapter {
  private round = 1;
  private phase: keyof typeof labels = "report";
  private randomState: number;
  private highQuality: boolean;
  private reportedHighQuality?: boolean;
  private accepted?: boolean;
  private scores: Record<string, number>;
  private history: SignalingResult[] = [];

  constructor(readonly characters: Character[], readonly rounds: number, seed: number, readonly incentives: SignalingIncentives = "conflicting") {
    if (characters.length !== 2 || new Set(characters.map(c => c.id)).size !== 2) throw new RunError("信息交易需要两位不同的参与者", 400);
    if (!Number.isSafeInteger(seed) || !Number.isInteger(rounds) || rounds < 2 || rounds > 16) throw new RunError("信息交易的轮次或种子无效", 400);
    if (!["aligned", "conflicting"].includes(incentives)) throw new RunError("信息交易的收益条件无效", 400);
    this.randomState = seed >>> 0;
    this.highQuality = this.drawQuality();
    this.scores = Object.fromEntries(characters.map(c => [c.id, 0]));
  }
  checkpoint() { return structuredClone({ ...this }); }
  restore(checkpoint: unknown) { Object.assign(this, structuredClone(checkpoint)); }
  private get sender() { return this.characters[0]; }
  private get receiver() { return this.characters[1]; }
  private get ids() { return this.characters.map(c => c.id); }
  private drawQuality() {
    // Mulberry32: reproducible across incentive conditions; neither state nor seed enters observations.
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let value = this.randomState;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296 < .5;
  }
  private assertActor(actorId: string) {
    if (!this.ids.includes(actorId)) throw new RunError("该人物不在本局", 403);
  }
  stage(): Stage | undefined {
    if (this.phase === "done") return;
    const discussion = this.phase === "discussion" || this.phase === "reflection";
    return { id: `${this.round}:${this.phase}`, round: this.round, label: labels[this.phase], kind: discussion ? "discussion" : "action", channel: "public",
      actors: discussion ? this.ids : [this.phase === "report" ? this.sender.id : this.receiver.id] };
  }
  private get payoffTable() {
    return { acceptHigh: { sender: 6, receiver: 6 }, acceptLow: { sender: this.incentives === "aligned" ? 0 : 6, receiver: 0 }, reject: { sender: 2, receiver: 2 } };
  }
  observe(actorId: string) {
    this.assertActor(actorId);
    const known = actorId === this.sender.id || this.phase === "reflection" || this.phase === "done";
    return `信息交易共${this.rounds}轮，现在第${this.round}轮，${labels[this.phase]}。${this.sender.name}始终是发送者，${this.receiver.name}始终是接收者。` +
      `每轮高、低质量各有50%机会，独立生成。发送者在报告前已检查真实质量；接收者在选择前无法检查，只能依据报告、交流和以前的结算判断。` +
      `发送者先用 declare_quality 报告高或低质量，双方交流后，接收者用 choose_offer 接受或拒绝。报告没有强制约束，不改变质量和收益表。` +
      `当前收益条件是${this.incentives === "aligned" ? "利益一致" : "利益冲突"}，双方都知道：接受高质量双方各得6点；接受低质量发送者得${this.payoffTable.acceptLow.sender}点、接收者得0点；拒绝双方各得2点。` +
      `无论接受还是拒绝，随后都会公开本轮真值、报告是否一致和双方所得，留出复盘交流，然后进入下一轮。` +
      `你的角色是${actorId === this.sender.id ? "发送者" : "接收者"}，累计${this.scores[actorId]}点。` +
      (known ? `本轮真实质量：${this.highQuality ? "高" : "低"}。` : "本轮真实质量尚未向你公开。") +
      (this.reportedHighQuality === undefined ? "发送者尚未报告。" : `发送者本轮公开报告：${this.reportedHighQuality ? "高" : "低"}质量；结算前不能把报告当成已核验事实。`) +
      (this.accepted === undefined ? "接收者尚未决定。" : `接收者已${this.accepted ? "接受" : "拒绝"}。`) +
      (this.round === this.rounds ? "这是最后一轮，复盘后结束。" : "双方将在下一轮继续互动。");
  }
  observation(actorId: string): ActorObservation {
    this.assertActor(actorId);
    return { actorId, stageId: this.stage()?.id ?? "done", round: this.round, rules: this.observe(actorId),
      facts: { ...this.publicState(), participants: this.characters.map(c => ({ id: c.id, name: c.name })), ownRole: actorId === this.sender.id ? "sender" : "receiver",
        ownScore: this.scores[actorId], ...(actorId === this.sender.id ? { privateInformation: { highQuality: this.highQuality, source: "own-inspection" } } : {}) },
      legalActions: this.actions(actorId).map(action => ({ name: action.name, description: action.description })) };
  }
  actions(actorId: string): ActionSpec[] {
    if (this.phase === "report" && actorId === this.sender.id && this.reportedHighQuality === undefined) return [reportAction];
    if (this.phase === "choose" && actorId === this.receiver.id && this.accepted === undefined) return [offerAction];
    return [];
  }
  apply(actorId: string, name: string, input: unknown): EventDraft[] {
    const action = this.actions(actorId).find(item => item.name === name);
    if (!action) throw new RunError("这项行动当前不可用或已经提交");
    if (name === "declare_quality") {
      const { highQuality } = reportAction.parameters.parse(input) as { highQuality: boolean };
      this.reportedHighQuality = highQuality;
      return [{ type: "action", actorId, visibility: "public", text: `${this.sender.name}报告本轮为${highQuality ? "高" : "低"}质量（尚未核验）`,
        data: { action: name, round: this.round, highQuality } }];
    }
    const { accept } = offerAction.parameters.parse(input) as { accept: boolean };
    this.accepted = accept;
    return [{ type: "action", actorId, visibility: "public", text: `${this.receiver.name}${accept ? "接受" : "拒绝"}本轮交易`, data: { action: name, round: this.round, accept } }];
  }
  advance(): EventDraft[] {
    if (this.phase === "done") return [];
    if (this.stage()?.kind === "action" && this.stage()!.actors.some(id => this.actions(id).length)) throw new RunError("仍有未完成的行动");
    if (this.phase === "report") this.phase = "discussion";
    else if (this.phase === "discussion") this.phase = "choose";
    else if (this.phase === "choose") {
      const payoff = !this.accepted ? this.payoffTable.reject : this.highQuality ? this.payoffTable.acceptHigh : this.payoffTable.acceptLow;
      const payoffs = { [this.sender.id]: payoff.sender, [this.receiver.id]: payoff.receiver };
      for (const id of this.ids) this.scores[id] += payoffs[id];
      const result: SignalingResult = { round: this.round, incentives: this.incentives, senderId: this.sender.id, receiverId: this.receiver.id,
        highQuality: this.highQuality, reportedHighQuality: this.reportedHighQuality!, reportAccurate: this.reportedHighQuality === this.highQuality,
        accepted: this.accepted!, payoffs, scores: { ...this.scores } };
      this.history.push(result); this.phase = "reflection";
      return [fact(`公开核验：本轮真实质量为${this.highQuality ? "高" : "低"}，发送者报告${result.reportAccurate ? "与真值一致" : "与真值不一致"}；${this.sender.name}得到${payoff.sender}点，${this.receiver.name}得到${payoff.receiver}点。`,
        { ...structuredClone(result), settlement: true, rewardScale: 6 })];
    } else if (this.round === this.rounds) {
      this.phase = "done"; return [fact("信息交易结束", this.publicState())];
    } else {
      this.round++; this.reportedHighQuality = undefined; this.accepted = undefined;
      this.highQuality = this.drawQuality(); this.phase = "report";
    }
    return [];
  }
  publicState() {
    return { scenario: "signaling-game", incentives: this.incentives, round: this.round, rounds: this.rounds, phase: labels[this.phase], phaseId: this.phase,
      senderId: this.sender.id, receiverId: this.receiver.id, payoffTable: this.payoffTable,
      reportedHighQuality: this.reportedHighQuality, accepted: this.accepted, scores: { ...this.scores }, history: structuredClone(this.history),
      ...(this.phase === "reflection" || this.phase === "done" ? { highQuality: this.highQuality, reportAccurate: this.reportedHighQuality === this.highQuality } : {}) };
  }
  canMessage(actorId: string, channel: Channel, recipients: string[]) {
    return this.ids.includes(actorId) && this.stage()?.kind === "discussion" && channel !== "team" && recipients.every(id => this.ids.includes(id));
  }
}
