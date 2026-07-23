import { describe, expect, it } from "vitest";
import type { AgentPendingAction } from "../src/core/pending";
import type { GameCommand } from "../src/core/types";
import { SocialCommunicationBus, type SocialActorStepReceipt, type SocialChannel, type SocialMessage } from "../src/harness/social";
import { WerewolfAgentActor, reduceCommittedWerewolfSocialAction } from "../src/harness/actor";
import { hashStableState } from "../src/harness/hash";
import type { AgentHarnessState, HarnessPlayerView } from "../src/harness/types";

describe("Werewolf agent social claim ingestion", () => {
  it("derives evidence-backed action claims only from visible social messages", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const messages: SocialMessage[] = [
      socialMessage({
        id: "msg-1",
        seq: 1,
        senderId: "voter",
        visibility: "public",
        content: "voter voted for target-a.",
        metadata: { kind: "public-vote", day: 2, targetId: "target-a", abstain: false }
      }),
      socialMessage({
        id: "msg-2",
        seq: 2,
        senderId: "voter",
        visibility: "public",
        content: "voter voted for target-b.",
        metadata: { kind: "public-vote", day: 3, targetId: "target-b", abstain: false }
      }),
      socialMessage({
        id: "msg-3",
        seq: 3,
        senderId: "hunter",
        visibility: "public",
        content: "hunter shot target-c.",
        metadata: { kind: "public-hunter-shot", targetId: "target-c" }
      }),
      socialMessage({
        id: "msg-4",
        seq: 4,
        channelId: "werewolf-team",
        senderId: "wolf",
        recipientIds: ["observer"],
        visibility: "team",
        content: "wolf selected target-d as the night kill target.",
        metadata: { kind: "werewolf-kill-vote", targetId: "target-d" }
      }),
      socialMessage({
        id: "msg-5",
        seq: 5,
        senderId: "observer",
        visibility: "public",
        content: "observer voted for target-e.",
        metadata: { kind: "public-vote", day: 3, targetId: "target-e", abstain: false }
      })
    ];

    actor.observe(viewFor("observer", messages), { traceId: "trace-observe-1", turnIndex: 1 });

    const social = actor.state.social;
    expect(social).toBeDefined();
    expect(social?.memory.maxEntries).toBe(64);
    expect(social?.journal?.maxEntries).toBe(64);
    const observationMemory = social?.memory.entries.find((entry) => entry.kind === "observation");
    expect(observationMemory).toMatchObject({
      metadata: {
        observationProjection: "werewolf.memory-core.v1",
        visibleMessageCount: 5,
        publicSpeechCount: 0,
        voteCount: 0,
        recentEventCount: 0
      },
      observation: {
        you: { id: "observer" },
        pendingAction: { kind: "vote" },
        speeches: [],
        votes: [],
        recentEvents: []
      }
    });
    expect(observationMemory?.observation).not.toHaveProperty("social");
    expect(JSON.stringify(observationMemory?.observation)).not.toContain("voter voted for target-a");
    const beliefs = social?.beliefs.claims ?? {};

    expect(beliefs["voter:publicVoteTarget"]).toMatchObject({
      subject: "voter",
      predicate: "publicVoteTarget",
      value: "target-b",
      confidence: 1,
      evidenceRefs: [
        { artifact: "message", id: "msg-1", seq: 1, description: "table" },
        { artifact: "message", id: "msg-2", seq: 2, description: "table" }
      ],
      contradictions: [
        expect.objectContaining({
          value: "target-a",
          evidenceRefs: [{ artifact: "message", id: "msg-1", seq: 1, description: "table" }]
        })
      ],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "voter",
        claimSource: "social-message",
        claimKind: "public-vote",
        channelId: "table",
        visibility: "public",
        messageId: "msg-2",
        messageSeq: 2,
        targetId: "target-b",
        observedActionOnly: true
      })
    });
    expect(beliefs["hunter:hunterShotTarget"]).toMatchObject({
      subject: "hunter",
      predicate: "hunterShotTarget",
      value: "target-c",
      evidenceRefs: [{ artifact: "message", id: "msg-3", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        claimKind: "public-hunter-shot",
        targetId: "target-c",
        observedActionOnly: true
      })
    });
    expect(beliefs["wolf:wolfKillPreference"]).toMatchObject({
      subject: "wolf",
      predicate: "wolfKillPreference",
      value: "target-d",
      evidenceRefs: [{ artifact: "message", id: "msg-4", seq: 4, description: "werewolf-team" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        claimKind: "werewolf-kill-vote",
        channelId: "werewolf-team",
        visibility: "team",
        targetId: "target-d",
        observedActionOnly: true
      })
    });
    expect(beliefs["observer:publicVoteTarget"]).toBeUndefined();

    const socialMessageEntries = social?.memory.entries.filter((entry) => entry.kind === "message") ?? [];
    expect(socialMessageEntries).toHaveLength(5);
    expect(socialMessageEntries.find((entry) => entry.source === "voter")?.tags).toEqual(expect.arrayContaining(["claim:vote"]));
    expect(socialMessageEntries.find((entry) => entry.source === "hunter")?.tags).toEqual(expect.arrayContaining(["claim:hunter-shot"]));
    expect(socialMessageEntries.find((entry) => entry.source === "wolf")?.tags).toEqual(expect.arrayContaining(["claim:wolf-kill-preference"]));

    const journal = social?.journal?.entries ?? [];
    expect(journal.length).toBeGreaterThan(socialMessageEntries.length);
    expect(journal.map((entry) => entry.journalSeq)).toEqual(journal.map((_, index) => index + 1));
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    const voteBeliefMutation = journal.find(
      (entry) =>
        entry.mutationKind === "belief.upserted" &&
        entry.subjectId === "voter" &&
        entry.afterSummary?.predicate === "publicVoteTarget" &&
        entry.messageSeqRange?.start === 2
    );
    expect(voteBeliefMutation).toMatchObject({
      store: "beliefs",
      messageSeqRange: { start: 2, end: 2 },
      evidenceRefs: [{ artifact: "message", id: "msg-2", seq: 2, description: "table" }],
      afterSummary: expect.objectContaining({
        value: "target-b"
      }),
      deltaSummary: expect.objectContaining({
        valueChanged: true,
        contradictionCountDelta: 1
      })
    });
    expect(
      journal.some(
        (entry) =>
          entry.mutationKind === "belief.upserted" &&
          entry.subjectId === "observer" &&
          entry.afterSummary?.predicate === "publicVoteTarget"
      )
    ).toBe(false);
    expect(journal.some((entry) => entry.mutationKind === "relationship.updated")).toBe(false);
    expect(journal.some((entry) => entry.mutationKind === "reputation.updated")).toBe(false);
  });

  it("derives evidence-backed asserted claims only from visible top-level speechActs", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-speech-act",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "I am the seer and target-a is under pressure.",
      metadata: { kind: "public-speech" }
    });
    const visibleRoleClaim = socialMessage({
      id: "msg-visible-role-claim",
      seq: 2,
      senderId: "voter",
      visibility: "public",
      content: "structured role claim",
      metadata: { kind: "public-speech", claimedRole: "villager" },
      speechActs: [
        {
          id: "act-role-claim",
          kind: "role_claim",
          subjectId: "voter",
          value: "seer",
          confidence: 0.72,
          evidenceRefs: []
        }
      ]
    });
    const visibleAccusation = socialMessage({
      id: "msg-visible-accusation",
      seq: 3,
      senderId: "hunter",
      visibility: "public",
      content: "structured pressure target",
      metadata: { kind: "public-speech", pressureTargetId: "target-b" },
      speechActs: [
        {
          id: "act-accuse-target-a",
          kind: "accusation",
          subjectId: "hunter",
          targetId: "target-a",
          value: "wolf-read",
          confidence: 0.61,
          evidenceRefs: []
        }
      ]
    });
    const visibleVoteIntent = socialMessage({
      id: "msg-visible-vote-intent",
      seq: 4,
      senderId: "voter",
      visibility: "public",
      content: "structured vote intent",
      metadata: { kind: "public-speech" },
      speechActs: [
        {
          id: "act-vote-intent",
          kind: "vote_intent",
          subjectId: "voter",
          targetId: "target-c",
          value: "vote.intent",
          confidence: 0.66,
          evidenceRefs: []
        }
      ]
    });
    const visibleClaim = socialMessage({
      id: "msg-visible-claim",
      seq: 5,
      senderId: "hunter",
      visibility: "public",
      content: "structured social claim",
      metadata: { kind: "public-speech" },
      speechActs: [
        {
          id: "act-claim-target-a",
          kind: "claim",
          subjectId: "target-a",
          value: "target-a contradicted public votes",
          confidence: 0.55,
          evidenceRefs: [],
          metadata: { topic: "contradiction", valence: "negative" }
        }
      ]
    });
    const hiddenSpeechAct = socialMessage({
      id: "msg-hidden-speech-act",
      seq: 6,
      senderId: "hidden",
      visibility: "private",
      content: "hidden pressure",
      recipientIds: ["hidden"],
      metadata: { kind: "private-speech" },
      speechActs: [
        {
          id: "act-hidden-role-claim",
          kind: "role_claim",
          subjectId: "hidden",
          value: "seer",
          confidence: 1,
          evidenceRefs: []
        }
      ]
    });
    const scopedMessages = [naturalLanguageOnly, visibleRoleClaim, visibleAccusation, visibleVoteIntent, visibleClaim];
    expect(scopedMessages.some((message) => message.id === hiddenSpeechAct.id)).toBe(false);

    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-speech-acts", turnIndex: 3 });

    const social = actor.state.social;
    expect(social).toBeDefined();
    const beliefs = social?.beliefs.claims ?? {};
    expect(beliefs["voter:claimedRole"]).toMatchObject({
      subject: "voter",
      predicate: "claimedRole",
      value: "seer",
      confidence: 0.72,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-role-claim", seq: 2, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "voter",
        claimSource: "social-message-speech-act",
        claimKind: "public-speech",
        speechActId: "act-role-claim",
        speechActKind: "role_claim",
        speechActSubjectId: "voter",
        channelId: "table",
        visibility: "public",
        messageId: "msg-visible-role-claim",
        messageSeq: 2,
        assertedClaimOnly: true
      })
    });
    expect(beliefs["voter:claimedRole"]?.contradictions).toHaveLength(0);
    expect(beliefs["hunter:pressuredTarget"]).toMatchObject({
      subject: "hunter",
      predicate: "pressuredTarget",
      value: "target-a",
      confidence: 0.61,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-accusation", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        claimSource: "social-message-speech-act",
        speechActId: "act-accuse-target-a",
        speechActKind: "accusation",
        targetId: "target-a",
        assertedClaimOnly: true
      })
    });
    expect(beliefs["hunter:pressuredTarget"]?.contradictions).toHaveLength(0);
    expect(beliefs["voter:voteIntentTarget"]).toMatchObject({
      subject: "voter",
      predicate: "voteIntentTarget",
      value: "target-c",
      confidence: 0.66,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-vote-intent", seq: 4, description: "table" }],
      metadata: expect.objectContaining({
        claimSource: "social-message-speech-act",
        speechActId: "act-vote-intent",
        speechActKind: "vote_intent",
        targetId: "target-c",
        assertedIntentOnly: true
      })
    });
    expect(beliefs["voter:publicVoteTarget"]).toBeUndefined();
    expect(beliefs["natural:claimedRole"]).toBeUndefined();
    expect(beliefs["natural:pressuredTarget"]).toBeUndefined();
    expect(beliefs["hidden:claimedRole"]).toBeUndefined();

    expect(social?.gossip?.records["msg-visible-accusation:speech-act:act-accuse-target-a:gossip"]).toMatchObject({
      speakerId: "hunter",
      subjectId: "target-a",
      topic: "accusation",
      claim: "wolf-read",
      valence: "negative",
      confidence: 0.61,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-accusation", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        factSource: "social-message-speech-act",
        speechActId: "act-accuse-target-a",
        speechActKind: "accusation"
      })
    });
    expect(social?.gossip?.records["msg-visible-claim:speech-act:act-claim-target-a:claim"]).toMatchObject({
      speakerId: "hunter",
      subjectId: "target-a",
      topic: "contradiction",
      claim: "target-a contradicted public votes",
      valence: "negative",
      confidence: 0.55,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-claim", seq: 5, description: "table" }],
      metadata: expect.objectContaining({
        factSource: "social-message-speech-act",
        speechActId: "act-claim-target-a",
        speechActKind: "claim"
      })
    });

    const socialMessageEntries = social?.memory.entries.filter((entry) => entry.kind === "message") ?? [];
    expect(socialMessageEntries.find((entry) => entry.source === "natural")?.tags).not.toEqual(
      expect.arrayContaining(["claim:role", "claim:pressure", "social:speech-act"])
    );
    expect(socialMessageEntries.find((entry) => entry.source === "voter" && entry.metadata?.messageId === "msg-visible-role-claim")?.tags).toEqual(
      expect.arrayContaining(["claim:role", "social:speech-act"])
    );
    expect(socialMessageEntries.find((entry) => entry.source === "hunter" && entry.metadata?.messageId === "msg-visible-accusation")?.tags).toEqual(
      expect.arrayContaining(["claim:pressure", "social:speech-act"])
    );
    expect(
      socialMessageEntries.find((entry) => entry.metadata?.messageId === "msg-visible-vote-intent")?.metadata
    ).toMatchObject({
      speechActCount: 1,
      speechActIds: ["act-vote-intent"],
      speechActKinds: ["vote_intent"]
    });

    const journal = social?.journal?.entries ?? [];
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "beliefs",
          mutationKind: "belief.upserted",
          subjectId: "voter",
          traceId: "trace-observe-speech-acts",
          turnIndex: 3,
          messageSeqRange: { start: 2, end: 2 },
          evidenceRefs: [{ artifact: "message", id: "msg-visible-role-claim", seq: 2, description: "table" }],
          afterSummary: expect.objectContaining({
            predicate: "claimedRole",
            value: "seer"
          })
        }),
        expect.objectContaining({
          store: "beliefs",
          mutationKind: "belief.upserted",
          subjectId: "hunter",
          traceId: "trace-observe-speech-acts",
          turnIndex: 3,
          messageSeqRange: { start: 3, end: 3 },
          evidenceRefs: [{ artifact: "message", id: "msg-visible-accusation", seq: 3, description: "table" }],
          afterSummary: expect.objectContaining({
            predicate: "pressuredTarget",
            value: "target-a"
          })
        }),
        expect.objectContaining({
          store: "gossip",
          mutationKind: "gossip.added",
          subjectId: "msg-visible-claim:speech-act:act-claim-target-a:claim",
          traceId: "trace-observe-speech-acts",
          turnIndex: 3,
          messageSeqRange: { start: 5, end: 5 },
          evidenceRefs: [{ artifact: "message", id: "msg-visible-claim", seq: 5, description: "table" }]
        })
      ])
    );
    expect(JSON.stringify(social)).not.toContain("act-hidden-role-claim");
    expect(JSON.stringify(social)).not.toContain("hidden pressure");
  });

  it("records commitments and coalitions only from visible top-level speechActs", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-speech-act-social",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "I promise to vote with observer and hunter is with voter.",
      metadata: { kind: "public-speech" }
    });
    const commitmentSpeechAct = socialMessage({
      id: "msg-speech-act-commitment",
      seq: 2,
      senderId: "voter",
      visibility: "public",
      content: "structured top-level commitment",
      metadata: { kind: "public-speech" },
      speechActs: [
        {
          id: "act-commit-voter",
          kind: "commitment",
          subjectId: "voter",
          targetId: "target-a",
          value: "vote target-a",
          confidence: 0.82,
          evidenceRefs: [],
          metadata: {
            commitmentId: "commit-speech-voter-target-a",
            audienceIds: ["observer", "observer"],
            stance: "vote with observer",
            deadlinePhase: "day_vote",
            deadlineDay: 3,
            status: "active"
          }
        }
      ]
    });
    const coalitionSpeechAct = socialMessage({
      id: "msg-speech-act-coalition",
      seq: 3,
      senderId: "hunter",
      visibility: "public",
      content: "structured top-level coalition signal",
      metadata: { kind: "public-speech" },
      speechActs: [
        {
          id: "act-coalition-hunter-voter",
          kind: "coalition_signal",
          subjectId: "hunter",
          targetId: "target-a",
          value: "pressure target-a",
          confidence: 0.74,
          evidenceRefs: [],
          metadata: {
            coalitionId: "coalition-speech-hunter-voter",
            memberIds: ["hunter", "voter", "voter"],
            sharedGoal: "pressure target-a",
            status: "active"
          }
        }
      ]
    });
    const hiddenSpeechAct = socialMessage({
      id: "msg-hidden-speech-act-social",
      seq: 4,
      senderId: "hidden",
      visibility: "private",
      content: "hidden social plan",
      recipientIds: ["hidden"],
      metadata: { kind: "private-speech" },
      speechActs: [
        {
          id: "act-hidden-commitment",
          kind: "commitment",
          subjectId: "hidden",
          value: "hidden promise",
          confidence: 1,
          evidenceRefs: [],
          metadata: {
            commitmentId: "commit-hidden-speech-act"
          }
        }
      ]
    });
    const scopedMessages = [naturalLanguageOnly, commitmentSpeechAct, coalitionSpeechAct];

    expect(scopedMessages.some((message) => message.id === hiddenSpeechAct.id)).toBe(false);
    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-speech-act-social-facts", turnIndex: 4 });

    const social = actor.state.social;
    expect(Object.keys(social?.commitments?.records ?? {})).toEqual(["commit-speech-voter-target-a"]);
    expect(social?.commitments?.records["commit-speech-voter-target-a"]).toMatchObject({
      id: "commit-speech-voter-target-a",
      actorId: "voter",
      audienceIds: ["observer"],
      visibility: "public",
      promisedAction: "vote target-a",
      stance: "vote with observer",
      targetId: "target-a",
      deadlinePhase: "day_vote",
      deadlineDay: 3,
      status: "active",
      confidence: 0.82,
      evidenceRefs: [{ artifact: "message", id: "msg-speech-act-commitment", seq: 2, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "voter",
        factSource: "social-message-speech-act",
        factKind: "commitment",
        speechActId: "act-commit-voter",
        speechActKind: "commitment",
        factSemantic: "commitment",
        messageId: "msg-speech-act-commitment",
        messageSeq: 2,
        targetId: "target-a"
      })
    });
    expect(social?.commitments?.records["commit-hidden-speech-act"]).toBeUndefined();

    expect(Object.keys(social?.coalitions?.records ?? {})).toEqual(["coalition-speech-hunter-voter"]);
    expect(social?.coalitions?.records["coalition-speech-hunter-voter"]).toMatchObject({
      id: "coalition-speech-hunter-voter",
      memberIds: ["hunter", "voter"],
      visibility: "public",
      sharedGoal: "pressure target-a",
      targetId: "target-a",
      status: "active",
      confidence: 0.74,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-speech-act-coalition", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "hunter",
        factSource: "social-message-speech-act",
        factKind: "coalition_signal",
        speechActId: "act-coalition-hunter-voter",
        speechActKind: "coalition_signal",
        factSemantic: "coalition",
        messageId: "msg-speech-act-coalition",
        messageSeq: 3,
        targetId: "target-a"
      })
    });

    const entries = social?.memory.entries.filter((entry) => entry.kind === "message") ?? [];
    expect(entries.find((entry) => entry.source === "natural")?.tags).not.toEqual(expect.arrayContaining(["social:commitment", "social:coalition", "social:speech-act"]));
    expect(entries.find((entry) => entry.metadata?.messageId === "msg-speech-act-commitment")?.tags).toEqual(
      expect.arrayContaining(["social:commitment", "social:speech-act"])
    );
    expect(entries.find((entry) => entry.metadata?.messageId === "msg-speech-act-coalition")?.tags).toEqual(
      expect.arrayContaining(["social:coalition", "social:speech-act"])
    );

    const journal = social?.journal?.entries ?? [];
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "commitments",
          mutationKind: "commitment.added",
          subjectId: "commit-speech-voter-target-a",
          traceId: "trace-observe-speech-act-social-facts",
          turnIndex: 4,
          messageSeqRange: { start: 2, end: 2 },
          evidenceRefs: [{ artifact: "message", id: "msg-speech-act-commitment", seq: 2, description: "table" }]
        }),
        expect.objectContaining({
          store: "coalitions",
          mutationKind: "coalition.added",
          subjectId: "coalition-speech-hunter-voter",
          traceId: "trace-observe-speech-act-social-facts",
          turnIndex: 4,
          messageSeqRange: { start: 3, end: 3 },
          evidenceRefs: [{ artifact: "message", id: "msg-speech-act-coalition", seq: 3, description: "table" }]
        })
      ])
    );
    expect(JSON.stringify(social)).not.toContain("commit-hidden-speech-act");
    expect(JSON.stringify(social)).not.toContain("hidden social plan");
  });

  it("records commitments and coalitions only from explicit structured visible metadata", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "I promise to vote with observer, and hunter is with us.",
      metadata: { kind: "public-speech" }
    });
    const hiddenStructured = socialMessage({
      id: "msg-hidden",
      seq: 2,
      senderId: "hidden",
      visibility: "private",
      content: "hidden promise",
      recipientIds: ["hidden"],
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "commitment",
            id: "commit-hidden",
            stance: "vote with observer",
            audienceIds: ["observer"],
            visibility: "private"
          }
        ]
      }
    });
    const commitmentMessage = socialMessage({
      id: "msg-commit",
      seq: 3,
      senderId: "voter",
      visibility: "public",
      content: "voter made a public commitment.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "commitment",
            id: "commit-voter-observer",
            audienceIds: ["observer", "observer"],
            stance: "vote with observer",
            targetId: "target-a",
            deadlinePhase: "day_vote",
            deadlineDay: 3,
            confidence: 0.8
          }
        ]
      }
    });
    const commitmentStatusMessage = socialMessage({
      id: "msg-commit-status",
      seq: 4,
      senderId: "system",
      visibility: "public",
      content: "commitment result was observed.",
      metadata: {
        kind: "commitment-outcome",
        socialFacts: [
          {
            kind: "commitment-status",
            id: "commit-voter-observer",
            status: "fulfilled"
          }
        ]
      }
    });
    const coalitionMessage = socialMessage({
      id: "msg-coalition",
      seq: 5,
      senderId: "hunter",
      visibility: "public",
      content: "hunter coordinated with voter.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "coalition",
            id: "coalition-hunter-voter",
            memberIds: ["hunter", "voter", "voter"],
            sharedGoal: "pressure target-a",
            targetId: "target-a",
            confidence: 0.7
          }
        ]
      }
    });
    const coalitionEvidenceMessage = socialMessage({
      id: "msg-coalition-evidence",
      seq: 6,
      senderId: "voter",
      visibility: "public",
      content: "voter followed the coalition plan.",
      metadata: {
        kind: "public-vote",
        targetId: "target-a",
        socialFacts: [
          {
            kind: "coalition-evidence",
            id: "coalition-hunter-voter",
            evidenceKind: "coordination",
            status: "active",
            confidence: 0.9
          }
        ]
      }
    });
    const scopedMessages = [naturalLanguageOnly, commitmentMessage, commitmentStatusMessage, coalitionMessage, coalitionEvidenceMessage];

    expect(scopedMessages.some((message) => message.id === hiddenStructured.id)).toBe(false);
    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-structured-social", turnIndex: 7 });

    const social = actor.state.social;
    expect(social).toBeDefined();
    expect(Object.keys(social?.commitments?.records ?? {})).toEqual(["commit-voter-observer"]);
    expect(social?.commitments?.records["commit-voter-observer"]).toMatchObject({
      id: "commit-voter-observer",
      actorId: "voter",
      audienceIds: ["observer"],
      visibility: "public",
      stance: "vote with observer",
      targetId: "target-a",
      deadlinePhase: "day_vote",
      deadlineDay: 3,
      status: "fulfilled",
      confidence: 0.8,
      evidenceRefs: [
        { artifact: "message", id: "msg-commit", seq: 3, description: "table" },
        { artifact: "message", id: "msg-commit-status", seq: 4, description: "table" }
      ],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "system",
        factSource: "social-message-metadata",
        factKind: "commitment-status",
        messageId: "msg-commit-status",
        messageSeq: 4
      })
    });
    expect(social?.commitments?.records["commit-hidden"]).toBeUndefined();

    expect(Object.keys(social?.coalitions?.records ?? {})).toEqual(["coalition-hunter-voter"]);
    expect(social?.coalitions?.records["coalition-hunter-voter"]).toMatchObject({
      id: "coalition-hunter-voter",
      memberIds: ["hunter", "voter"],
      visibility: "public",
      sharedGoal: "pressure target-a",
      targetId: "target-a",
      status: "active",
      confidence: 0.9,
      formationEvidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 5, description: "table" }],
      coordinationEvidenceRefs: [{ artifact: "message", id: "msg-coalition-evidence", seq: 6, description: "table" }],
      evidenceRefs: [
        { artifact: "message", id: "msg-coalition", seq: 5, description: "table" },
        { artifact: "message", id: "msg-coalition-evidence", seq: 6, description: "table" }
      ]
    });

    const entries = social?.memory.entries ?? [];
    expect(entries.find((entry) => entry.source === "natural")?.tags).not.toEqual(expect.arrayContaining(["social:commitment"]));
    expect(entries.find((entry) => entry.source === "voter" && entry.metadata?.messageId === "msg-commit")?.tags).toEqual(
      expect.arrayContaining(["social:commitment"])
    );
    expect(entries.find((entry) => entry.source === "hunter")?.tags).toEqual(expect.arrayContaining(["social:coalition"]));

    const journal = social?.journal?.entries ?? [];
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "commitments",
          mutationKind: "commitment.added",
          subjectId: "commit-voter-observer",
          traceId: "trace-observe-structured-social",
          turnIndex: 7,
          messageSeqRange: { start: 3, end: 3 },
          evidenceRefs: [{ artifact: "message", id: "msg-commit", seq: 3, description: "table" }]
        }),
        expect.objectContaining({
          store: "commitments",
          mutationKind: "commitment.status.updated",
          subjectId: "commit-voter-observer",
          messageSeqRange: { start: 4, end: 4 },
          evidenceRefs: [{ artifact: "message", id: "msg-commit-status", seq: 4, description: "table" }]
        }),
        expect.objectContaining({
          store: "coalitions",
          mutationKind: "coalition.added",
          subjectId: "coalition-hunter-voter",
          messageSeqRange: { start: 5, end: 5 },
          evidenceRefs: [{ artifact: "message", id: "msg-coalition", seq: 5, description: "table" }]
        }),
        expect.objectContaining({
          store: "coalitions",
          mutationKind: "coalition.evidence.recorded",
          subjectId: "coalition-hunter-voter",
          messageSeqRange: { start: 6, end: 6 },
          evidenceRefs: [{ artifact: "message", id: "msg-coalition-evidence", seq: 6, description: "table" }]
        })
      ])
    );
    expect(JSON.stringify(social)).not.toContain("commit-hidden");

    const actorWithoutHiddenMessage = new WerewolfAgentActor(agentState("observer-no-hidden"));
    actorWithoutHiddenMessage.observe(viewFor("observer-no-hidden", []), { traceId: "trace-observe-without-hidden", turnIndex: 8 });
    expect(JSON.stringify(actorWithoutHiddenMessage.state.social)).not.toContain("commit-hidden");
  });

  it("records relationship and reputation consequences only from explicit structured visible metadata", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-consequence",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "target-a repaired trust and should gain reputation.",
      metadata: { kind: "public-speech" }
    });
    const hiddenConsequence = socialMessage({
      id: "msg-hidden-consequence",
      seq: 2,
      senderId: "hidden",
      visibility: "private",
      content: "hidden consequence",
      recipientIds: ["hidden"],
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: { trust: 0.9 },
            reason: "hidden relationship update"
          },
          {
            kind: "reputation",
            subjectId: "target-a",
            deltas: { honesty: 0.9 },
            reason: "hidden reputation update"
          }
        ]
      }
    });
    const consequenceMessage = socialMessage({
      id: "msg-visible-consequence",
      seq: 3,
      senderId: "system",
      visibility: "public",
      content: "accepted repair consequences were recorded.",
      metadata: {
        kind: "social-consequence",
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: {
              trust: 0.25,
              suspicion: -0.15,
              affinity: 0.1,
              respect: 0.2
            },
            confidence: 0.8,
            reason: "accepted repair",
            triggerKind: "trust-repair-status",
            triggerId: "repair-target-a"
          },
          {
            kind: "reputation",
            subjectId: "target-a",
            deltas: {
              honesty: 0.18,
              cooperation: 0.12,
              normCompliance: 0.2
            },
            confidence: 0.75,
            reason: "accepted repair",
            triggerKind: "trust-repair-status",
            triggerId: "repair-target-a"
          },
          {
            kind: "relationship",
            targetId: "target-b",
            deltas: { trust: "high" },
            reason: "invalid non-numeric relationship delta"
          },
          {
            kind: "reputation",
            subjectId: "target-b",
            deltas: { honesty: "high" },
            reason: "invalid non-numeric reputation delta"
          }
        ]
      }
    });
    const scopedMessages = [naturalLanguageOnly, consequenceMessage];

    expect(scopedMessages.some((message) => message.id === hiddenConsequence.id)).toBe(false);
    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-social-consequences", turnIndex: 9 });

    const social = actor.state.social;
    expect(Object.keys(social?.relationships.edges ?? {})).toEqual(["target-a"]);
    expect(Object.keys(social?.reputation.records ?? {})).toEqual(["target-a"]);
    expect(social?.relationships.edges["target-a"]).toMatchObject({
      targetId: "target-a",
      trust: 0.25,
      suspicion: -0.15,
      affinity: 0.1,
      respect: 0.2,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-consequence", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "system",
        factSource: "social-message-metadata",
        factKind: "relationship",
        factIndex: 0,
        targetId: "target-a",
        reason: "accepted repair",
        triggerKind: "trust-repair-status",
        triggerId: "repair-target-a",
        confidence: 0.8,
        messageId: "msg-visible-consequence",
        messageSeq: 3
      })
    });
    expect(social?.reputation.records["target-a"]).toMatchObject({
      subjectId: "target-a",
      honesty: 0.18,
      cooperation: 0.12,
      normCompliance: 0.2,
      evidenceRefs: [{ artifact: "message", id: "msg-visible-consequence", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "system",
        factSource: "social-message-metadata",
        factKind: "reputation",
        factIndex: 1,
        subjectId: "target-a",
        reason: "accepted repair",
        triggerKind: "trust-repair-status",
        triggerId: "repair-target-a",
        confidence: 0.75,
        messageId: "msg-visible-consequence",
        messageSeq: 3
      })
    });
    expect(social?.relationships.edges["target-b"]).toBeUndefined();
    expect(social?.reputation.records["target-b"]).toBeUndefined();

    const journal = social?.journal?.entries ?? [];
    const relationshipAndReputationMutations = journal.filter(
      (entry) => entry.mutationKind === "relationship.updated" || entry.mutationKind === "reputation.updated"
    );
    expect(relationshipAndReputationMutations).toHaveLength(2);
    expect(relationshipAndReputationMutations.every((entry) => entry.messageSeqRange?.start === 3 && entry.messageSeqRange.end === 3)).toBe(true);
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "relationships",
          mutationKind: "relationship.updated",
          subjectId: "target-a",
          traceId: "trace-observe-social-consequences",
          turnIndex: 9,
          messageSeqRange: { start: 3, end: 3 },
          evidenceRefs: [{ artifact: "message", id: "msg-visible-consequence", seq: 3, description: "table" }],
          deltaSummary: expect.objectContaining({
            trust: 0.25,
            suspicion: -0.15,
            affinity: 0.1,
            respect: 0.2
          })
        }),
        expect.objectContaining({
          store: "reputation",
          mutationKind: "reputation.updated",
          subjectId: "target-a",
          traceId: "trace-observe-social-consequences",
          turnIndex: 9,
          messageSeqRange: { start: 3, end: 3 },
          evidenceRefs: [{ artifact: "message", id: "msg-visible-consequence", seq: 3, description: "table" }],
          deltaSummary: expect.objectContaining({
            honesty: 0.18,
            cooperation: 0.12,
            normCompliance: 0.2
          })
        })
      ])
    );
    expect(JSON.stringify(social)).not.toContain("hidden relationship update");
    expect(JSON.stringify(social)).not.toContain("hidden reputation update");
    expect(JSON.stringify(social)).not.toContain("msg-hidden-consequence");
  });

  it("records gossip, norms, and norm sanctions only from explicit structured visible metadata", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-gossip",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "target-a is unreliable and should be warned for breaking table norms.",
      metadata: { kind: "public-speech" }
    });
    const hiddenStructured = socialMessage({
      id: "msg-hidden-gossip",
      seq: 2,
      senderId: "hidden",
      visibility: "private",
      content: "hidden gossip",
      recipientIds: ["hidden"],
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "gossip",
            id: "gossip-hidden",
            subjectId: "target-a",
            claim: "hidden claim"
          },
          {
            kind: "norm-sanction",
            id: "sanction-hidden",
            normId: "norm-hidden",
            targetId: "target-a",
            sanctionKind: "warning"
          }
        ]
      }
    });
    const gossipMessage = socialMessage({
      id: "msg-gossip",
      seq: 3,
      senderId: "voter",
      visibility: "public",
      content: "voter repeated a sourced table claim about target-a.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "gossip",
            id: "gossip-voter-target",
            subjectId: "target-a",
            audienceIds: ["observer", "observer"],
            topic: "credibility",
            claim: "target-a contradicted a public vote claim",
            sourceId: "hunter",
            valence: "negative",
            confidence: 0.6
          }
        ]
      }
    });
    const normMessage = socialMessage({
      id: "msg-norm",
      seq: 4,
      senderId: "hunter",
      visibility: "public",
      content: "hunter stated a public table norm.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "norm",
            id: "norm-public-evidence",
            normKind: "obligation",
            scope: "public-table",
            expectedBehavior: "cite evidence before accusations",
            sanction: "public warning",
            source: "hunter",
            targetId: "target-a",
            confidence: 0.8
          }
        ]
      }
    });
    const sanctionMessage = socialMessage({
      id: "msg-sanction",
      seq: 5,
      senderId: "voter",
      visibility: "public",
      content: "voter proposed a warning for target-a.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "norm-sanction",
            id: "sanction-voter-target",
            normId: "norm-public-evidence",
            targetId: "target-a",
            sanctionKind: "warning",
            status: "proposed",
            reason: "target-a accused without evidence",
            requestedRepair: "state evidence before the vote",
            confidence: 0.9
          }
        ]
      }
    });
    const normStatusMessage = socialMessage({
      id: "msg-norm-status",
      seq: 6,
      senderId: "system",
      visibility: "public",
      content: "the table recorded a norm violation.",
      metadata: {
        kind: "norm-outcome",
        socialFacts: [
          {
            kind: "norm-status",
            id: "norm-public-evidence",
            status: "violated"
          }
        ]
      }
    });
    const sanctionStatusMessage = socialMessage({
      id: "msg-sanction-status",
      seq: 7,
      senderId: "system",
      visibility: "public",
      content: "the proposed warning was applied.",
      metadata: {
        kind: "norm-sanction-outcome",
        socialFacts: [
          {
            kind: "norm-sanction-status",
            id: "sanction-voter-target",
            status: "applied"
          }
        ]
      }
    });
    const scopedMessages = [naturalLanguageOnly, gossipMessage, normMessage, sanctionMessage, normStatusMessage, sanctionStatusMessage];

    expect(scopedMessages.some((message) => message.id === hiddenStructured.id)).toBe(false);
    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-gossip-norm", turnIndex: 11 });

    const social = actor.state.social;
    expect(social).toBeDefined();
    expect(Object.keys(social?.gossip?.records ?? {})).toEqual(["gossip-voter-target"]);
    expect(social?.gossip?.records["gossip-voter-target"]).toMatchObject({
      id: "gossip-voter-target",
      speakerId: "voter",
      subjectId: "target-a",
      audienceIds: ["observer"],
      visibility: "public",
      topic: "credibility",
      claim: "target-a contradicted a public vote claim",
      sourceId: "hunter",
      valence: "negative",
      confidence: 0.6,
      evidenceRefs: [{ artifact: "message", id: "msg-gossip", seq: 3, description: "table" }],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "voter",
        factKind: "gossip",
        messageId: "msg-gossip",
        messageSeq: 3
      })
    });
    expect(social?.gossip?.records["gossip-hidden"]).toBeUndefined();

    expect(social?.norms.norms["norm-public-evidence"]).toMatchObject({
      id: "norm-public-evidence",
      kind: "obligation",
      scope: "public-table",
      expectedBehavior: "cite evidence before accusations",
      sanction: "public warning",
      source: "hunter",
      status: "violated",
      confidence: 0.8,
      evidenceRefs: [
        { artifact: "message", id: "msg-norm", seq: 4, description: "table" },
        { artifact: "message", id: "msg-norm-status", seq: 6, description: "table" }
      ],
      metadata: expect.objectContaining({
        factKind: "norm-status",
        messageId: "msg-norm-status",
        messageSeq: 6
      })
    });
    expect(Object.keys(social?.normSanctions?.records ?? {})).toEqual(["sanction-voter-target"]);
    expect(social?.normSanctions?.records["sanction-voter-target"]).toMatchObject({
      id: "sanction-voter-target",
      normId: "norm-public-evidence",
      actorId: "voter",
      targetId: "target-a",
      audienceIds: ["observer"],
      visibility: "public",
      kind: "warning",
      status: "applied",
      confidence: 0.9,
      evidenceRefs: [
        { artifact: "message", id: "msg-sanction", seq: 5, description: "table" },
        { artifact: "message", id: "msg-sanction-status", seq: 7, description: "table" }
      ]
    });
    expect(social?.normSanctions?.records["sanction-hidden"]).toBeUndefined();

    const entries = social?.memory.entries ?? [];
    expect(entries.find((entry) => entry.source === "natural")?.tags).not.toEqual(expect.arrayContaining(["social:gossip", "social:norm", "social:norm-sanction"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 3))?.tags).toEqual(expect.arrayContaining(["social:gossip"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 4))?.tags).toEqual(expect.arrayContaining(["social:norm"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 5))?.tags).toEqual(expect.arrayContaining(["social:norm-sanction"]));

    const journal = social?.journal?.entries ?? [];
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "gossip",
          mutationKind: "gossip.added",
          subjectId: "gossip-voter-target",
          traceId: "trace-observe-gossip-norm",
          turnIndex: 11,
          messageSeqRange: { start: 3, end: 3 },
          evidenceRefs: [{ artifact: "message", id: "msg-gossip", seq: 3, description: "table" }]
        }),
        expect.objectContaining({
          store: "norms",
          mutationKind: "norm.added",
          subjectId: "norm-public-evidence",
          messageSeqRange: { start: 4, end: 4 },
          afterSummary: expect.objectContaining({ hasSanction: true })
        }),
        expect.objectContaining({
          store: "normSanctions",
          mutationKind: "norm_sanction.added",
          subjectId: "sanction-voter-target",
          messageSeqRange: { start: 5, end: 5 },
          afterSummary: expect.objectContaining({ kind: "warning", status: "proposed" })
        }),
        expect.objectContaining({
          store: "norms",
          mutationKind: "norm.status.updated",
          subjectId: "norm-public-evidence",
          messageSeqRange: { start: 6, end: 6 },
          deltaSummary: expect.objectContaining({ previousStatus: "active", nextStatus: "violated" })
        }),
        expect.objectContaining({
          store: "normSanctions",
          mutationKind: "norm_sanction.status.updated",
          subjectId: "sanction-voter-target",
          messageSeqRange: { start: 7, end: 7 },
          deltaSummary: expect.objectContaining({ previousStatus: "proposed", nextStatus: "applied" })
        })
      ])
    );
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(JSON.stringify(social)).not.toContain("gossip-hidden");
    expect(JSON.stringify(social)).not.toContain("sanction-hidden");
  });

  it("records trust repairs only from explicit structured visible metadata", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-repair",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "I apologize and will repair trust with evidence before the vote.",
      metadata: { kind: "public-speech" }
    });
    const hiddenStructured = socialMessage({
      id: "msg-hidden-repair",
      seq: 2,
      senderId: "hidden",
      visibility: "private",
      content: "hidden trust repair",
      recipientIds: ["hidden"],
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "trust-repair",
            id: "repair-hidden",
            targetId: "target-a",
            repairKind: "apology",
            offeredRepair: "hidden apology"
          }
        ]
      }
    });
    const invalidRepairMessage = socialMessage({
      id: "msg-invalid-repair",
      seq: 3,
      senderId: "voter",
      visibility: "public",
      content: "voter omitted target and repair kind.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "trust-repair",
            id: "repair-invalid",
            offeredRepair: "not enough structured fields"
          },
          {
            kind: "trust-repair-status",
            id: "repair-unknown",
            status: "accepted"
          }
        ]
      }
    });
    const repairMessage = socialMessage({
      id: "msg-repair",
      seq: 4,
      senderId: "voter",
      visibility: "public",
      content: "voter offered public repair evidence.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "trust-repair",
            id: "repair-voter-target",
            targetId: "target-a",
            audienceIds: ["observer", "observer"],
            repairKind: "evidence_provided",
            triggerKind: "norm_sanction",
            triggerId: "sanction-voter-target",
            relatedNormSanctionId: "sanction-voter-target",
            requestedById: "hunter",
            reason: "target-a asked for public evidence",
            requestedRepair: "state evidence before the vote",
            offeredRepair: "here is the public vote evidence",
            confidence: 0.8
          }
        ]
      }
    });
    const repairStatusMessage = socialMessage({
      id: "msg-repair-status",
      seq: 5,
      senderId: "system",
      visibility: "public",
      content: "the repair response was accepted as a lifecycle status.",
      metadata: {
        kind: "trust-repair-outcome",
        socialFacts: [
          {
            kind: "trust-repair-status",
            id: "repair-voter-target",
            status: "accepted"
          },
          {
            kind: "trust-repair-status",
            id: "repair-voter-target",
            status: "not-a-valid-status"
          }
        ]
      }
    });
    const scopedMessages = [naturalLanguageOnly, invalidRepairMessage, repairMessage, repairStatusMessage];

    expect(scopedMessages.some((message) => message.id === hiddenStructured.id)).toBe(false);
    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-trust-repair", turnIndex: 13 });

    const social = actor.state.social;
    expect(social).toBeDefined();
    expect(Object.keys(social?.trustRepairs?.records ?? {})).toEqual(["repair-voter-target"]);
    expect(social?.trustRepairs?.records["repair-voter-target"]).toMatchObject({
      id: "repair-voter-target",
      actorId: "voter",
      targetId: "target-a",
      audienceIds: ["observer"],
      visibility: "public",
      kind: "evidence_provided",
      status: "accepted",
      triggerKind: "norm_sanction",
      triggerId: "sanction-voter-target",
      relatedNormSanctionId: "sanction-voter-target",
      requestedById: "hunter",
      reason: "target-a asked for public evidence",
      requestedRepair: "state evidence before the vote",
      offeredRepair: "here is the public vote evidence",
      confidence: 0.8,
      evidenceRefs: [
        { artifact: "message", id: "msg-repair", seq: 4, description: "table" },
        { artifact: "message", id: "msg-repair-status", seq: 5, description: "table" }
      ],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "system",
        factKind: "trust-repair-status",
        messageId: "msg-repair-status",
        messageSeq: 5
      })
    });
    expect(social?.trustRepairs?.records["repair-hidden"]).toBeUndefined();
    expect(social?.trustRepairs?.records["repair-invalid"]).toBeUndefined();
    expect(social?.trustRepairs?.records["repair-unknown"]).toBeUndefined();
    expect(social?.relationships.edges["target-a"]).toBeUndefined();
    expect(social?.reputation.records["target-a"]).toBeUndefined();

    const entries = social?.memory.entries ?? [];
    expect(entries.find((entry) => entry.source === "natural")?.tags).not.toEqual(expect.arrayContaining(["social:trust-repair"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 4))?.tags).toEqual(expect.arrayContaining(["social:trust-repair"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 5))?.tags).toEqual(expect.arrayContaining(["social:trust-repair"]));

    const journal = social?.journal?.entries ?? [];
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "trustRepairs",
          mutationKind: "trust_repair.added",
          subjectId: "repair-voter-target",
          traceId: "trace-observe-trust-repair",
          turnIndex: 13,
          messageSeqRange: { start: 4, end: 4 },
          evidenceRefs: [{ artifact: "message", id: "msg-repair", seq: 4, description: "table" }],
          afterSummary: expect.objectContaining({
            kind: "evidence_provided",
            status: "proposed",
            hasRequestedRepair: true,
            requestedRepairLength: "state evidence before the vote".length,
            hasOfferedRepair: true,
            offeredRepairLength: "here is the public vote evidence".length
          })
        }),
        expect.objectContaining({
          store: "trustRepairs",
          mutationKind: "trust_repair.status.updated",
          subjectId: "repair-voter-target",
          messageSeqRange: { start: 5, end: 5 },
          deltaSummary: expect.objectContaining({ previousStatus: "proposed", nextStatus: "accepted" })
        })
      ])
    );
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(JSON.stringify(journal)).not.toContain("here is the public vote evidence");
    expect(JSON.stringify(social)).not.toContain("repair-hidden");
    expect(JSON.stringify(social)).not.toContain("hidden apology");
  });

  it("records betrayals only from explicit structured visible metadata", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-betrayal",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "voter betrayed target-a and broke the coalition.",
      metadata: { kind: "public-speech" }
    });
    const hiddenStructured = socialMessage({
      id: "msg-hidden-betrayal",
      seq: 2,
      senderId: "hidden",
      visibility: "private",
      content: "hidden betrayal allegation",
      recipientIds: ["hidden"],
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "betrayal",
            id: "betrayal-hidden",
            targetId: "target-a",
            betrayalKind: "coalition_betrayal",
            claim: "hidden betrayal claim"
          }
        ]
      }
    });
    const invalidBetrayalMessage = socialMessage({
      id: "msg-invalid-betrayal",
      seq: 3,
      senderId: "voter",
      visibility: "public",
      content: "voter omitted required structured betrayal fields.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "betrayal",
            id: "betrayal-invalid-missing-target",
            betrayalKind: "commitment_broken",
            claim: "missing target"
          },
          {
            kind: "betrayal",
            id: "betrayal-invalid-kind",
            targetId: "target-a",
            betrayalKind: "not-a-valid-kind"
          },
          {
            kind: "betrayal-evidence",
            id: "betrayal-unknown",
            evidenceKind: "corroboration",
            status: "confirmed"
          }
        ]
      }
    });
    const betrayalMessage = socialMessage({
      id: "msg-betrayal",
      seq: 4,
      senderId: "voter",
      visibility: "public",
      content: "voter's coalition break was recorded as structured metadata.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "betrayal",
            id: "betrayal-voter-target",
            actorId: "voter",
            targetId: "target-a",
            audienceIds: ["observer", "observer"],
            visibility: "public",
            betrayalKind: "coalition_betrayal",
            triggerKind: "coalition",
            triggerId: "coalition-hunter-voter",
            relatedCoalitionId: "coalition-hunter-voter",
            claim: "voter flipped against the coalition",
            impact: "target-a lost public support",
            confidence: 0.75
          }
        ]
      }
    });
    const betrayalEvidenceMessage = socialMessage({
      id: "msg-betrayal-evidence",
      seq: 5,
      senderId: "system",
      visibility: "public",
      content: "the table recorded corroborating betrayal evidence.",
      metadata: {
        kind: "betrayal-outcome",
        socialFacts: [
          {
            kind: "betrayal-evidence",
            id: "betrayal-voter-target",
            evidenceKind: "corroboration",
            status: "confirmed"
          },
          {
            kind: "betrayal-evidence",
            id: "betrayal-voter-target",
            evidenceKind: "not-a-valid-kind",
            status: "withdrawn"
          }
        ]
      }
    });
    const scopedMessages = [naturalLanguageOnly, invalidBetrayalMessage, betrayalMessage, betrayalEvidenceMessage];

    expect(scopedMessages.some((message) => message.id === hiddenStructured.id)).toBe(false);
    actor.observe(viewFor("observer", scopedMessages), { traceId: "trace-observe-betrayal", turnIndex: 15 });

    const social = actor.state.social;
    expect(social).toBeDefined();
    expect(Object.keys(social?.betrayals?.records ?? {})).toEqual(["betrayal-voter-target"]);
    expect(social?.betrayals?.records["betrayal-voter-target"]).toMatchObject({
      id: "betrayal-voter-target",
      actorId: "voter",
      targetId: "target-a",
      audienceIds: ["observer"],
      visibility: "public",
      kind: "coalition_betrayal",
      status: "confirmed",
      triggerKind: "coalition",
      triggerId: "coalition-hunter-voter",
      relatedCoalitionId: "coalition-hunter-voter",
      claim: "voter flipped against the coalition",
      impact: "target-a lost public support",
      confidence: 0.75,
      allegationEvidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 4, description: "table" }],
      corroborationEvidenceRefs: [{ artifact: "message", id: "msg-betrayal-evidence", seq: 5, description: "table" }],
      evidenceRefs: [
        { artifact: "message", id: "msg-betrayal", seq: 4, description: "table" },
        { artifact: "message", id: "msg-betrayal-evidence", seq: 5, description: "table" }
      ],
      metadata: expect.objectContaining({
        observerId: "observer",
        speakerId: "system",
        factSource: "social-message-metadata",
        factKind: "betrayal-evidence",
        messageId: "msg-betrayal-evidence",
        messageSeq: 5
      })
    });
    expect(social?.betrayals?.records["betrayal-hidden"]).toBeUndefined();
    expect(social?.betrayals?.records["betrayal-invalid-missing-target"]).toBeUndefined();
    expect(social?.betrayals?.records["betrayal-invalid-kind"]).toBeUndefined();
    expect(social?.betrayals?.records["betrayal-unknown"]).toBeUndefined();
    expect(social?.relationships.edges["target-a"]).toBeUndefined();
    expect(social?.reputation.records["target-a"]).toBeUndefined();

    const entries = social?.memory.entries ?? [];
    expect(entries.find((entry) => entry.source === "natural")?.tags).not.toEqual(expect.arrayContaining(["social:betrayal"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 4))?.tags).toEqual(expect.arrayContaining(["social:betrayal"]));
    expect(entries.find((entry) => entry.evidenceRefs.some((ref) => ref.seq === 5))?.tags).toEqual(expect.arrayContaining(["social:betrayal"]));

    const journal = social?.journal?.entries ?? [];
    expect(journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: "betrayals",
          mutationKind: "betrayal.added",
          subjectId: "betrayal-voter-target",
          traceId: "trace-observe-betrayal",
          turnIndex: 15,
          messageSeqRange: { start: 4, end: 4 },
          evidenceRefs: [{ artifact: "message", id: "msg-betrayal", seq: 4, description: "table" }],
          afterSummary: expect.objectContaining({
            kind: "coalition_betrayal",
            status: "alleged",
            triggerKind: "coalition",
            triggerId: "coalition-hunter-voter",
            relatedCoalitionId: "coalition-hunter-voter",
            hasClaim: true,
            claimLength: "voter flipped against the coalition".length,
            hasImpact: true,
            impactLength: "target-a lost public support".length,
            allegationEvidenceRefCount: 1,
            corroborationEvidenceRefCount: 0
          })
        }),
        expect.objectContaining({
          store: "betrayals",
          mutationKind: "betrayal.evidence.recorded",
          subjectId: "betrayal-voter-target",
          messageSeqRange: { start: 5, end: 5 },
          evidenceRefs: [{ artifact: "message", id: "msg-betrayal-evidence", seq: 5, description: "table" }],
          deltaSummary: expect.objectContaining({
            evidenceKind: "corroboration",
            previousStatus: "alleged",
            nextStatus: "confirmed",
            evidenceAdded: 1
          }),
          afterSummary: expect.objectContaining({
            status: "confirmed",
            corroborationEvidenceRefCount: 1
          })
        })
      ])
    );
    expect(journal.every((entry) => entry.hiddenTruthUsed === false)).toBe(true);
    expect(JSON.stringify(journal)).not.toContain("voter flipped against the coalition");
    expect(JSON.stringify(journal)).not.toContain("target-a lost public support");
    expect(JSON.stringify(social)).not.toContain("betrayal-hidden");
    expect(JSON.stringify(social)).not.toContain("hidden betrayal claim");
  });

  it("uses only visible structured society facts from observations in policy arbitration", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const rawVisibleLedgerText = "raw visible ledger narrative must not enter arbitration";
    const rawHiddenLedgerText = "hidden structured pressure must not be observed";
    const naturalLanguageOnly = socialMessage({
      id: "msg-natural-policy-pressure",
      seq: 1,
      senderId: "natural",
      visibility: "public",
      content: "target-a is the obvious vote, target-b is safe, and this text alone must not create a ledger.",
      metadata: { kind: "public-speech" }
    });
    const hiddenStructured = socialMessage({
      id: "msg-hidden-policy-pressure",
      seq: 2,
      senderId: "hidden",
      visibility: "private",
      recipientIds: ["hidden"],
      content: rawHiddenLedgerText,
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "betrayal",
            id: "betrayal-hidden-policy",
            actorId: "target-a",
            targetId: "target-b",
            betrayalKind: "deception",
            status: "confirmed",
            claim: rawHiddenLedgerText
          },
          {
            kind: "gossip",
            id: "gossip-hidden-policy",
            subjectId: "target-a",
            claim: rawHiddenLedgerText,
            valence: "negative"
          }
        ]
      }
    });
    const commitmentMessage = socialMessage({
      id: "msg-visible-policy-commitment",
      seq: 3,
      senderId: "target-b",
      visibility: "public",
      content: "target-b fulfilled a public commitment.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "commitment",
            id: "commit-target-b-policy",
            actorId: "target-b",
            audienceIds: ["observer"],
            stance: rawVisibleLedgerText,
            status: "fulfilled",
            confidence: 1
          }
        ]
      }
    });
    const coalitionMessage = socialMessage({
      id: "msg-visible-policy-coalition",
      seq: 4,
      senderId: "hunter",
      visibility: "public",
      content: "hunter explicitly coordinated with target-b.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "coalition",
            id: "coalition-target-b-policy",
            memberIds: ["target-b", "hunter"],
            sharedGoal: rawVisibleLedgerText,
            status: "active",
            confidence: 1
          }
        ]
      }
    });
    const repairMessage = socialMessage({
      id: "msg-visible-policy-repair",
      seq: 5,
      senderId: "target-b",
      visibility: "public",
      content: "target-b provided explicit repair evidence.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "trust-repair",
            id: "repair-target-b-policy",
            actorId: "target-b",
            targetId: "target-a",
            audienceIds: ["observer"],
            repairKind: "evidence_provided",
            status: "accepted",
            offeredRepair: rawVisibleLedgerText,
            confidence: 1
          }
        ]
      }
    });
    const scopedMessages = [naturalLanguageOnly, commitmentMessage, coalitionMessage, repairMessage];
    const view = viewFor("observer", scopedMessages);

    expect(scopedMessages.some((message) => message.id === hiddenStructured.id)).toBe(false);
    actor.observe(view, { traceId: "trace-observe-policy-ledgers", turnIndex: 17 });
    const pendingAction = view.pendingAction as Extract<AgentPendingAction, { kind: "vote" }>;
    const plan = actor.plan(pendingAction);

    const social = actor.state.social;
    const selectedCandidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "target-b");
    const targetA = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "target-a");

    expect(plan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "target-village",
      selectedTargetId: "target-b"
    });
    expect(plan.command).toMatchObject({ type: "vote.cast", actorId: "observer", targetId: "target-b" });
    expect(plan.arbitration?.candidates.some((candidate) => candidate.targetId === "hidden")).toBe(false);
    expect(selectedCandidate?.finalScore).toBeGreaterThan(targetA?.finalScore ?? 0);
    expect(selectedCandidate?.reasons).toEqual(
      expect.arrayContaining(["commitment:fulfilled", "coalition:active", "trustRepair:evidence_provided", "trustRepair:accepted"])
    );
    expect(selectedCandidate?.evidenceRefs).toEqual(
      expect.arrayContaining([
        { artifact: "message", id: "msg-visible-policy-commitment", seq: 3, description: "table" },
        { artifact: "message", id: "msg-visible-policy-coalition", seq: 4, description: "table" },
        { artifact: "message", id: "msg-visible-policy-repair", seq: 5, description: "table" }
      ])
    );
    expect(Object.keys(social?.commitments?.records ?? {})).toEqual(["commit-target-b-policy"]);
    expect(Object.keys(social?.coalitions?.records ?? {})).toEqual(["coalition-target-b-policy"]);
    expect(Object.keys(social?.trustRepairs?.records ?? {})).toEqual(["repair-target-b-policy"]);
    expect(social?.betrayals?.records["betrayal-hidden-policy"]).toBeUndefined();
    expect(social?.gossip?.records["gossip-hidden-policy"]).toBeUndefined();
    expect(JSON.stringify(social)).not.toContain(rawHiddenLedgerText);
    expect(JSON.stringify(plan.arbitration)).not.toContain(rawVisibleLedgerText);
    expect(JSON.stringify(plan.arbitration)).not.toContain(rawHiddenLedgerText);
    expect(JSON.stringify(plan.arbitration)).not.toContain("target-a is the obvious vote");
  });

  it("keeps bus-hidden structured facts out of actor ledgers and policy arbitration", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const rawVisibleLedgerText = "bus visible ledger narrative must not enter arbitration";
    const rawHiddenLedgerText = "bus hidden structured pressure must not reach observer";
    const channels: SocialChannel[] = [
      {
        id: "table",
        kind: "public",
        participantIds: ["observer", "target-a", "target-b", "hunter", "hidden"],
        readableBy: "all"
      },
      {
        id: "hidden-room",
        kind: "private",
        participantIds: ["hidden", "target-a"],
        readableBy: "participants"
      }
    ];
    const bus = new SocialCommunicationBus(channels);
    const hiddenMessage = bus.publish({
      channelId: "hidden-room",
      senderId: "hidden",
      recipientIds: ["target-a"],
      visibility: "private",
      content: rawHiddenLedgerText,
      metadata: {
        kind: "private-speech",
        socialFacts: [
          {
            kind: "betrayal",
            id: "bus-hidden-betrayal",
            actorId: "target-b",
            targetId: "target-a",
            betrayalKind: "deception",
            status: "confirmed",
            claim: rawHiddenLedgerText,
            confidence: 1
          },
          {
            kind: "gossip",
            id: "bus-hidden-gossip",
            subjectId: "target-b",
            claim: rawHiddenLedgerText,
            valence: "negative",
            confidence: 1
          }
        ]
      }
    });
    const commitmentMessage = bus.publish({
      channelId: "table",
      senderId: "target-b",
      recipientIds: ["observer"],
      visibility: "public",
      content: "target-b fulfilled a table commitment.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "commitment",
            id: "bus-visible-commitment",
            actorId: "target-b",
            audienceIds: ["observer"],
            stance: rawVisibleLedgerText,
            status: "fulfilled",
            confidence: 1
          }
        ]
      }
    });
    const coalitionMessage = bus.publish({
      channelId: "table",
      senderId: "hunter",
      recipientIds: ["observer"],
      visibility: "public",
      content: "hunter coordinated with target-b in public.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "coalition",
            id: "bus-visible-coalition",
            memberIds: ["target-b", "hunter"],
            sharedGoal: rawVisibleLedgerText,
            status: "active",
            confidence: 1
          }
        ]
      }
    });
    const repairMessage = bus.publish({
      channelId: "table",
      senderId: "target-b",
      recipientIds: ["observer"],
      visibility: "public",
      content: "target-b provided public repair evidence.",
      metadata: {
        kind: "public-speech",
        socialFacts: [
          {
            kind: "trust-repair",
            id: "bus-visible-repair",
            actorId: "target-b",
            targetId: "target-a",
            audienceIds: ["observer"],
            repairKind: "evidence_provided",
            status: "accepted",
            offeredRepair: rawVisibleLedgerText,
            confidence: 1
          }
        ]
      }
    });
    const scopedSocial = bus.observe("observer");
    const view = viewFor("observer", scopedSocial.messages);

    expect(scopedSocial.channels.map((channel) => channel.id)).toEqual(["table"]);
    expect(scopedSocial.messages.map((message) => message.id)).toEqual([commitmentMessage.id, coalitionMessage.id, repairMessage.id]);
    expect(scopedSocial.messages.some((message) => message.id === hiddenMessage.id)).toBe(false);

    actor.observe(view, { traceId: "trace-bus-scoped-policy-ledgers", turnIndex: 18 });
    const pendingAction = view.pendingAction as Extract<AgentPendingAction, { kind: "vote" }>;
    const plan = actor.plan(pendingAction);
    const social = actor.state.social;
    const selectedCandidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "target-b");

    expect(plan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "target-village",
      selectedTargetId: "target-b"
    });
    expect(selectedCandidate?.reasons).toEqual(
      expect.arrayContaining(["commitment:fulfilled", "coalition:active", "trustRepair:evidence_provided", "trustRepair:accepted"])
    );
    expect(selectedCandidate?.evidenceRefs).toEqual(
      expect.arrayContaining([
        { artifact: "message", id: commitmentMessage.id, seq: commitmentMessage.seq, description: "table" },
        { artifact: "message", id: coalitionMessage.id, seq: coalitionMessage.seq, description: "table" },
        { artifact: "message", id: repairMessage.id, seq: repairMessage.seq, description: "table" }
      ])
    );
    expect(Object.keys(social?.commitments?.records ?? {})).toEqual(["bus-visible-commitment"]);
    expect(Object.keys(social?.coalitions?.records ?? {})).toEqual(["bus-visible-coalition"]);
    expect(Object.keys(social?.trustRepairs?.records ?? {})).toEqual(["bus-visible-repair"]);
    expect(social?.betrayals?.records["bus-hidden-betrayal"]).toBeUndefined();
    expect(social?.gossip?.records["bus-hidden-gossip"]).toBeUndefined();
    expect(JSON.stringify(social)).not.toContain(rawHiddenLedgerText);
    expect(JSON.stringify(plan.arbitration)).not.toContain(rawVisibleLedgerText);
    expect(JSON.stringify(plan.arbitration)).not.toContain(rawHiddenLedgerText);
  });

  it("preserves visible-message exact-once ingestion when a Werewolf actor is restored after memory trimming", () => {
    const firstMessage = socialMessage({
      id: "msg-werewolf-durable-first",
      seq: 12,
      senderId: "voter",
      visibility: "public",
      content: "explicit relationship consequence",
      metadata: {
        socialFacts: [
          {
            kind: "relationship",
            targetId: "target-a",
            deltas: { suspicion: 0.25 }
          }
        ]
      }
    });
    const secondMessage = socialMessage({
      id: "msg-werewolf-durable-second",
      seq: 13,
      senderId: "hunter",
      visibility: "public",
      content: "ordinary visible follow-up"
    });
    const actor = new WerewolfAgentActor(agentState("observer"));
    if (!actor.state.social) throw new Error("Expected initialized social state.");
    actor.state.social.memory.maxEntries = 2;

    actor.observe(viewFor("observer", [firstMessage]), { traceId: "trace-durable-first", turnIndex: 19 });
    actor.observe(viewFor("observer", [firstMessage, secondMessage]), { traceId: "trace-durable-second", turnIndex: 20 });

    expect(actor.state.social.memory.entries.some((entry) => entry.evidenceRefs.some((ref) => ref.id === firstMessage.id))).toBe(false);
    expect(actor.state.social.relationships.edges["target-a"].suspicion).toBe(0.25);
    expect(actor.state.social.messageIngestion?.seenMessageIds).toEqual([firstMessage.id, secondMessage.id]);
    const restoredState = JSON.parse(JSON.stringify(actor.state)) as AgentHarnessState;
    const restoredHash = restoredState.socialStateHash;
    const restored = new WerewolfAgentActor(restoredState);

    expect(restored.state.socialStateHash).toBe(restoredHash);
    restored.observe(viewFor("observer", [firstMessage, secondMessage]), { traceId: "trace-durable-restored", turnIndex: 21 });

    expect(restored.state.social?.relationships.edges["target-a"].suspicion).toBe(0.25);
    expect(restored.state.social?.messageIngestion?.seenMessageIds).toEqual([firstMessage.id, secondMessage.id]);
    expect(
      restored.state.social?.journal?.entries.filter(
        (entry) => entry.store === "relationships" && entry.metadata?.messageId === firstMessage.id
      )
    ).toHaveLength(1);
  });

  it("rejects hash-consistent restored Werewolf state that violates bounded sequence contracts", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    if (!actor.state.social?.journal) throw new Error("Expected initialized social journal.");

    const overLimit = JSON.parse(JSON.stringify(actor.state)) as AgentHarnessState;
    overLimit.social!.memory.maxEntries = 200;
    overLimit.social!.journal!.maxEntries = 1000;
    overLimit.socialStateHash = hashStableState(overLimit.social);
    expect(() => new WerewolfAgentActor(overLimit)).toThrow(/memory\.maxEntries exceeds.*journal\.maxEntries exceeds/);

    const sequenceReuse = JSON.parse(JSON.stringify(actor.state)) as AgentHarnessState;
    sequenceReuse.social!.memory.nextSeq = 9;
    sequenceReuse.social!.journal!.nextSeq = 9;
    sequenceReuse.socialStateHash = hashStableState(sequenceReuse.social);
    expect(() => new WerewolfAgentActor(sequenceReuse)).toThrow(/must retain 8 sequence entries/);
  });

  it("creates and resolves linked commitment goals only from delivered typed vote evidence", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const commitmentMessage = withObserverDelivery(socialMessage({
      id: "msg-production-commitment",
      seq: 20,
      senderId: "voter",
      visibility: "public",
      content: "free text is not interpreted",
      speechActs: [{
        id: "act-production-commitment",
        kind: "commitment",
        subjectId: "voter",
        targetId: "target-a",
        value: "vote.cast",
        confidence: 0.9,
        evidenceRefs: [],
        metadata: {
          commitmentId: "commit-production-voter-target-a",
          promisedAction: "vote.cast",
          deadlinePhase: "day_vote",
          deadlineDay: 3
        }
      }],
      metadata: { kind: "public-speech", day: 3 }
    }));

    actor.observe(viewFor("observer", [commitmentMessage]), { traceId: "trace-production-commitment", turnIndex: 30 });

    expect(actor.state.social?.commitments?.records["commit-production-voter-target-a"]).toMatchObject({
      actorId: "voter",
      promisedAction: "vote.cast",
      targetId: "target-a",
      deadlinePhase: "day_vote",
      deadlineDay: 3,
      status: "active",
      metadata: expect.objectContaining({ linkedGoalId: "commit-production-voter-target-a:goal" })
    });
    expect(actor.state.social?.goals.goals.find((goal) => goal.id === "commit-production-voter-target-a:goal")).toMatchObject({
      kind: "commitment",
      status: "active"
    });

    const committedVote = withObserverDelivery(socialMessage({
      id: "msg-production-vote",
      seq: 21,
      senderId: "voter",
      visibility: "public",
      content: "this text is not used to resolve the commitment",
      speechActs: [{
        id: "act-production-vote",
        kind: "vote_intent",
        subjectId: "voter",
        targetId: "target-a",
        value: "vote.cast",
        confidence: 1,
        evidenceRefs: [],
        metadata: { source: "metadata.targetId", abstain: false }
      }],
      metadata: { kind: "public-vote", day: 3, targetId: "target-a", abstain: false }
    }));
    actor.observe(viewFor("observer", [commitmentMessage, committedVote]), {
      traceId: "trace-production-vote",
      turnIndex: 31
    });

    expect(actor.state.social?.commitments?.records["commit-production-voter-target-a"]?.status).toBe("fulfilled");
    expect(actor.state.social?.goals.goals.find((goal) => goal.id === "commit-production-voter-target-a:goal")?.status).toBe("completed");
    expect(actor.state.social?.commitments?.records["commit-production-voter-target-a"]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: committedVote.id }),
        expect.objectContaining({ artifact: "delivery_receipt", id: `${committedVote.id}:delivery:observer` })
      ])
    );
  });

  it("does not create linked goals or resolve commitments from free text or missing delivery receipts", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const naturalLanguageOnly = socialMessage({
      id: "msg-production-free-text",
      seq: 22,
      senderId: "voter",
      visibility: "public",
      content: "I promise to vote for target-a.",
      metadata: { kind: "public-speech", day: 3 }
    });
    const typedWithoutReceipt = socialMessage({
      id: "msg-production-no-receipt",
      seq: 23,
      senderId: "voter",
      visibility: "public",
      content: "typed but not receipt-bound",
      speechActs: [{
        id: "act-production-no-receipt",
        kind: "commitment",
        subjectId: "voter",
        targetId: "target-a",
        value: "vote.cast",
        confidence: 1,
        evidenceRefs: [],
        metadata: {
          commitmentId: "commit-production-no-receipt",
          promisedAction: "vote.cast",
          deadlinePhase: "day_vote",
          deadlineDay: 3
        }
      }],
      metadata: { kind: "public-speech", day: 3 }
    });
    const voteWithoutReceipt = socialMessage({
      id: "msg-production-vote-no-receipt",
      seq: 24,
      senderId: "voter",
      visibility: "public",
      content: "voter voted for target-a",
      speechActs: [{
        id: "act-production-vote-no-receipt",
        kind: "vote_intent",
        subjectId: "voter",
        targetId: "target-a",
        value: "vote.cast",
        confidence: 1,
        evidenceRefs: [],
        metadata: { source: "metadata.targetId", abstain: false }
      }],
      metadata: { kind: "public-vote", day: 3, targetId: "target-a", abstain: false }
    });

    actor.observe(viewFor("observer", [naturalLanguageOnly, typedWithoutReceipt, voteWithoutReceipt]), {
      traceId: "trace-production-no-receipt",
      turnIndex: 32
    });

    expect(actor.state.social?.goals.goals.some((goal) => goal.id === "commit-production-no-receipt:goal")).toBe(false);
    expect(actor.state.social?.commitments?.records["commit-production-no-receipt"]?.status).toBe("active");
    expect(Object.values(actor.state.social?.commitments?.records ?? {})).toHaveLength(1);
  });

  it("records reputation consequences only after an observed public role claim is publicly disproved", () => {
    const actor = new WerewolfAgentActor(agentState("observer"));
    const claimMessage = withObserverDelivery(socialMessage({
      id: "msg-production-role-claim",
      seq: 25,
      senderId: "voter",
      visibility: "public",
      content: "content is not parsed",
      speechActs: [{
        id: "act-production-role-claim",
        kind: "role_claim",
        subjectId: "voter",
        value: "seer",
        confidence: 1,
        evidenceRefs: [],
        metadata: { source: "reasoner.social-intent" }
      }],
      metadata: { kind: "public-speech", day: 3 }
    }));
    actor.observe(viewFor("observer", [claimMessage]), { traceId: "trace-role-claim-before-reveal", turnIndex: 33 });

    expect(Object.keys(actor.state.social?.betrayals?.records ?? {})).toEqual([]);
    expect(actor.state.social?.reputation.records["voter"]).toBeUndefined();

    const revealedView = viewFor("observer", []);
    revealedView.publicPlayers = revealedView.publicPlayers.map((player) =>
      player.id === "voter" ? { ...player, alive: false, revealedRole: "villager" } : player
    );
    actor.observe(revealedView, { traceId: "trace-role-claim-public-reveal", turnIndex: 34 });

    expect(actor.state.social?.betrayals?.records["observer:false-public-role-claim:msg-production-role-claim"]).toMatchObject({
      actorId: "voter",
      targetId: "observer",
      kind: "deception",
      status: "confirmed",
      metadata: expect.objectContaining({ claimedRole: "seer", revealedRole: "villager" })
    });
    expect(actor.state.social?.reputation.records["voter"]).toMatchObject({ honesty: -0.25 });

    actor.observe(revealedView, { traceId: "trace-role-claim-public-reveal-repeat", turnIndex: 35 });
    expect(actor.state.social?.reputation.records["voter"]?.honesty).toBe(-0.25);

    const hiddenTruthOnlyActor = new WerewolfAgentActor(agentState("observer"));
    const hiddenTruthView = viewFor("observer", [claimMessage]);
    hiddenTruthView.privateInfo.werewolfAllies = ["voter"];
    hiddenTruthOnlyActor.observe(hiddenTruthView, { traceId: "trace-role-claim-hidden-truth", turnIndex: 36 });
    expect(Object.keys(hiddenTruthOnlyActor.state.social?.betrayals?.records ?? {})).toEqual([]);
    expect(hiddenTruthOnlyActor.state.social?.reputation.records["voter"]).toBeUndefined();
  });

  it("reduces committed typed action receipts and leaves rejected receipts mutation-free", () => {
    const actor = new WerewolfAgentActor(agentState("voter"));
    if (!actor.state.social) throw new Error("Expected initialized social state.");
    const declarationReceipt: SocialActorStepReceipt<unknown, AgentPendingAction, GameCommand> = {
      id: "receipt-production-declaration",
      status: "committed",
      traceId: "trace-production-declaration",
      turnIndex: 40,
      actorId: "voter",
      pendingAction: { kind: "speech", phase: "day_speech", actorId: "voter", legalPressureTargetIds: ["target-a"] },
      action: {
        actorId: "voter",
        kind: "speech.submit",
        traceId: "trace-production-declaration",
        command: { type: "speech.submit", actorId: "voter", text: "not parsed" },
        messages: [{
          channelId: "table",
          senderId: "voter",
          recipientIds: ["observer"],
          visibility: "public",
          content: "not parsed",
          speechActs: [{
            id: "act-receipt-commitment",
            kind: "commitment",
            subjectId: "voter",
            targetId: "target-a",
            value: "vote.cast",
            confidence: 1,
            evidenceRefs: [],
            metadata: {
              commitmentId: "commit-receipt-voter-target-a",
              promisedAction: "vote.cast",
              deadlinePhase: "day_vote",
              deadlineDay: 3
            }
          }],
          metadata: { kind: "public-speech", day: 3 }
        }]
      },
      messageSeqRange: [30, 30]
    };
    reduceCommittedWerewolfSocialAction(actor.state.social, declarationReceipt);
    expect(actor.state.social.commitments?.records["commit-receipt-voter-target-a"]?.status).toBe("active");

    const beforeRejected = JSON.stringify(actor.state.social);
    reduceCommittedWerewolfSocialAction(actor.state.social, {
      ...declarationReceipt,
      id: "receipt-production-rejected",
      status: "rejected",
      traceId: "trace-production-rejected"
    });
    expect(JSON.stringify(actor.state.social)).toBe(beforeRejected);

    reduceCommittedWerewolfSocialAction(actor.state.social, {
      id: "receipt-production-vote",
      status: "committed",
      traceId: "trace-production-vote-receipt",
      turnIndex: 41,
      actorId: "voter",
      pendingAction: { kind: "vote", phase: "day_vote", actorId: "voter", legalTargetIds: ["target-a", "target-b"] },
      action: {
        actorId: "voter",
        kind: "vote.cast",
        traceId: "trace-production-vote-receipt",
        command: { type: "vote.cast", actorId: "voter", targetId: "target-b" },
        messages: [{
          channelId: "table",
          senderId: "voter",
          recipientIds: ["observer"],
          visibility: "public",
          content: "text claims a different target and is ignored",
          speechActs: [{
            id: "act-receipt-vote",
            kind: "vote_intent",
            subjectId: "voter",
            targetId: "target-b",
            value: "vote.cast",
            confidence: 1,
            evidenceRefs: [],
            metadata: { source: "metadata.targetId", abstain: false }
          }],
          metadata: { kind: "public-vote", day: 3, targetId: "target-b", abstain: false }
        }]
      },
      messageSeqRange: [31, 31]
    });
    expect(actor.state.social.commitments?.records["commit-receipt-voter-target-a"]?.status).toBe("broken");
    expect(actor.state.social.goals.goals.find((goal) => goal.id === "commit-receipt-voter-target-a:goal")?.status).toBe("failed");
  });
});

function agentState(playerId: string): AgentHarnessState {
  return {
    playerId,
    profileId: `${playerId}-profile`,
    model: "deterministic-test-model",
    temperature: 0,
    policyName: "balanced",
    turns: 0,
    observations: 0,
    beliefs: {},
    privateMemos: []
  };
}

function socialMessage(input: {
  id: string;
  seq: number;
  senderId: string;
  visibility: SocialMessage["visibility"];
  content: string;
  channelId?: string;
  recipientIds?: string[];
  speechActs?: SocialMessage["speechActs"];
  deliveryReceipts?: SocialMessage["deliveryReceipts"];
  metadata?: Record<string, unknown>;
}): SocialMessage {
  return {
    id: input.id,
    seq: input.seq,
    channelId: input.channelId ?? "table",
    senderId: input.senderId,
    recipientIds: input.recipientIds ?? ["observer"],
    visibility: input.visibility,
    content: input.content,
    speechActs: input.speechActs,
    deliveryReceipts: input.deliveryReceipts,
    createdAt: new Date(input.seq * 1000).toISOString(),
    metadata: input.metadata
  };
}

function withObserverDelivery(message: SocialMessage, observerId = "observer"): SocialMessage {
  return {
    ...message,
    deliveryReceipts: [{
      id: `${message.id}:delivery:${observerId}`,
      messageId: message.id,
      messageSeq: message.seq,
      channelId: message.channelId,
      senderId: message.senderId,
      observerId,
      visibility: message.visibility,
      deliveredAtTurn: message.seq,
      redactionPolicy: `runtime-visible:${message.visibility}`
    }]
  };
}

function viewFor(observerId: string, messages: SocialMessage[]): HarnessPlayerView {
  return {
    phase: "day_vote",
    day: 3,
    you: {
      id: observerId,
      seat: 1,
      name: "Observer",
      role: "werewolf",
      team: "werewolves",
      alive: true,
      ability: {
        witchSaveAvailable: false,
        witchPoisonAvailable: false,
        hunterShotAvailable: false
      }
    },
    publicPlayers: ["observer", "voter", "hunter", "wolf", "target-a", "target-b", "target-c", "target-d", "target-e"].map(
      (id, index) => ({
        id,
        seat: index + 1,
        name: id,
        alive: true,
        isSheriff: false
      })
    ),
    privateInfo: {
      werewolfAllies: ["wolf"]
    },
    speeches: [],
    votes: [],
    deaths: [],
    recentEvents: [],
    pendingAction: {
      kind: "vote",
      phase: "day_vote",
      actorId: observerId,
      legalTargetIds: ["target-a", "target-b", "target-c", "target-d", "target-e"]
    },
    social: {
      channels: [],
      messages
    }
  };
}
