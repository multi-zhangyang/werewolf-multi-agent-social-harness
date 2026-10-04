import type { SignalingIncentives } from "../types";

export function signalingPayoffs(incentives: SignalingIncentives, highQuality: boolean, accepted: boolean) {
  return !accepted ? { sender: 2, receiver: 2 }
    : { sender: highQuality || incentives === "conflicting" ? 6 : 0, receiver: highQuality ? 6 : 0 };
}

export function trustPayoffs(investment: number, returned: number) {
  return { investor: 10 - investment + returned, trustee: 3 * investment - returned };
}

export function contributionPayoff(own: number, total: number, participants: number) {
  return 10 - own + total * 1.6 / participants;
}
