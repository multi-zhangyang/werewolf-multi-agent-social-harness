import type { SignalingIncentives, SignalingPayoffProfile } from "../types";

export const signalingQualityPrior = .5;
export function signalingPayoffs(incentives: SignalingIncentives, highQuality: boolean, accepted: boolean, profile: SignalingPayoffProfile = "legacy") {
  return !accepted ? { sender: 2, receiver: profile === "diagnostic" ? 4 : 2 }
    : { sender: highQuality || incentives === "conflicting" ? 6 : 0, receiver: highQuality ? 6 : 0 };
}

export function signalingPayoffTable(incentives: SignalingIncentives, profile: SignalingPayoffProfile = "legacy") {
  return { acceptHigh: signalingPayoffs(incentives, true, true, profile), acceptLow: signalingPayoffs(incentives, false, true, profile), reject: signalingPayoffs(incentives, false, false, profile) };
}
export function signalingBreakEven(incentives: SignalingIncentives, profile: SignalingPayoffProfile = "legacy") {
  const table = signalingPayoffTable(incentives, profile);
  return (table.reject.receiver - table.acceptLow.receiver) / (table.acceptHigh.receiver - table.acceptLow.receiver);
}
export function signalingPayoffText(incentives: SignalingIncentives, profile: SignalingPayoffProfile = "legacy") {
  const t = signalingPayoffTable(incentives, profile);
  return `接受高质量发送者得 ${t.acceptHigh.sender} 点、接收者得 ${t.acceptHigh.receiver} 点；接受低质量发送者得 ${t.acceptLow.sender} 点、接收者得 ${t.acceptLow.receiver} 点；拒绝发送者得 ${t.reject.sender} 点、接收者得 ${t.reject.receiver} 点。高质量先验 ${signalingQualityPrior * 100}%；高质量概率超过 ${t.reject.receiver - t.acceptLow.receiver}/${t.acceptHigh.receiver - t.acceptLow.receiver} 时，接受的期望点数高于拒绝。`;
}

export function trustPayoffs(investment: number, returned: number) {
  return { investor: 10 - investment + returned, trustee: 3 * investment - returned };
}

export function contributionPayoff(own: number, total: number, participants: number) {
  return 10 - own + total * 1.6 / participants;
}
