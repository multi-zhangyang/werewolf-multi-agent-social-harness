import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashStableState } from "../src/harness/hash";

describe("hashStableState", () => {
  it("preserves the lowercase SHA-256 artifact contract across canonical key ordering and timestamp redaction", () => {
    const first = {
      b: 2,
      a: 1,
      createdAt: "2026-07-21T00:00:00.000Z",
      nested: { z: true, a: ["中", null] }
    };
    const second = {
      nested: { a: ["中", null], z: true },
      createdAt: "2099-01-01T00:00:00.000Z",
      a: 1,
      b: 2
    };
    const normalizedJson = '{"a":1,"b":2,"createdAt":"<timestamp>","nested":{"a":["中",null],"z":true}}';
    const nodeSha256 = createHash("sha256").update(normalizedJson).digest("hex");

    expect(nodeSha256).toBe("e3aa4e7490a827df93de6d6ab8f7718c68a22e41f4b4c1283e606641a274ced0");
    expect(hashStableState(first)).toBe(nodeSha256);
    expect(hashStableState(second)).toBe(nodeSha256);
  });

  it("remains synchronous and rejects values that cannot be serialized", () => {
    expect(hashStableState([{ actor: "a", turn: 1 }, { actor: "b", turn: 2 }])).toBe(
      "3484c5416f8b3cb4f5d9b7c87636f8858bf7146e32ab83a42219cace0b9db7b8"
    );
    expect(() => hashStableState(undefined)).toThrow(TypeError);
  });
});
