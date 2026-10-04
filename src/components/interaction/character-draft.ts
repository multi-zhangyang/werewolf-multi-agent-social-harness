import type { Character } from "@/runtime/types";

export function characterDraft(character?: Character) {
  return {
    name: character?.name ?? "", persona: character?.persona ?? "",
    values: character?.values.join("、") ?? "", goals: character?.goals.join("；") ?? "",
    voice: character?.voice ?? "", traits: character?.traits?.join("、") ?? "",
    anchors: character?.autobiographicalAnchors?.join("\n") ?? "",
    temperament: character?.temperament ? { ...character.temperament } : undefined,
    decisionBiases: character?.decisionBiases ? [...character.decisionBiases] : undefined,
    regulation: character?.regulation,
  };
}

export function characterPayload(draft: ReturnType<typeof characterDraft>) {
  const split = (text: string, separator: RegExp) => text.split(separator).map(s => s.trim()).filter(Boolean);
  return {
    displayName: draft.name, persona: draft.persona, voice: draft.voice,
    traits: split(draft.traits, /[、,，]/).length ? split(draft.traits, /[、,，]/) : ["自定义"],
    values: split(draft.values, /[、,，]/), goals: split(draft.goals, /[；;]/),
    autobiographicalAnchors: split(draft.anchors, /\r?\n/),
    temperament: draft.temperament, decisionBiases: draft.decisionBiases, regulation: draft.regulation,
  };
}
