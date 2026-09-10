import { createHash } from "crypto";

import { base64ToBytes } from "../portable/base64";
import { hashSessionId as portableHash, newEventId, newSessionId } from "../portable/ids";
import { sha256Hex, utf8Encode } from "../portable/sha256";
import { parseStack } from "../portable/stack";
import { hashSessionId as nodeHash } from "../scrubbing";
import { parseStack as nodeParseStack } from "../errors";

describe("portable sha256", () => {
  const inputs = [
    "",
    "abc",
    "a".repeat(55), // one block, length fits exactly
    "a".repeat(56), // padding spills into a second block
    "a".repeat(64),
    "a".repeat(1000),
    "session-cookie-value-3f9a",
    "ünïcödé ✓ 🎉",
    "lone \ud800 surrogate",
    "trailing \udc00",
  ];

  it.each(inputs)("matches Node's crypto for %j", (input) => {
    expect(sha256Hex(input)).toBe(
      createHash("sha256").update(input, "utf8").digest("hex"),
    );
  });

  it("encodes UTF-8 the way Buffer does, lone surrogates included", () => {
    for (const input of inputs) {
      expect(Buffer.from(utf8Encode(input))).toEqual(Buffer.from(input, "utf8"));
    }
  });
});

describe("portable ids", () => {
  it("hashes a session id byte-identically to the Node SDK", () => {
    for (const raw of ["abc", "s:%2Fcookie.value", "ünï"]) {
      expect(portableHash(raw)).toBe(nodeHash(raw));
    }
  });

  it("is idempotent on its own output, like the Node version", () => {
    const once = portableHash("cookie");
    expect(portableHash(once)).toBe(once);
    expect(portableHash("")).toBe("");
  });

  it("mints session ids in the shape the ingest and upload endpoint require", () => {
    const id = newSessionId();
    expect(id).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(newSessionId()).not.toBe(id);
  });

  it("mints version 4 UUIDs", () => {
    expect(newEventId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("base64ToBytes", () => {
  it("decodes what Buffer encodes, with and without padding and prefixes", () => {
    for (const length of [0, 1, 2, 3, 4, 100, 257]) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37) & 0xff));
      const encoded = bytes.toString("base64");
      expect(Buffer.from(base64ToBytes(encoded))).toEqual(bytes);
      expect(Buffer.from(base64ToBytes(encoded.replace(/=+$/, "")))).toEqual(bytes);
      expect(
        Buffer.from(base64ToBytes(`data:image/jpeg;base64,${encoded}`)),
      ).toEqual(bytes);
    }
  });

  it("refuses characters outside the alphabet rather than guessing", () => {
    expect(() => base64ToBytes("ab$c")).toThrow(/invalid base64/);
  });
});

describe("portable stack parsing", () => {
  it("reads Firefox and Safari frames when asked, innermost last", () => {
    const stack = [
      "inner@https://app.example.com/static/js/main.js?v=3:10:5",
      "@https://app.example.com/static/js/main.js:20:1",
      "outer@https://cdn.example.com/node_modules/lib/index.js:1:2",
    ].join("\n");

    const frames = parseStack(stack, undefined, { gecko: true });
    expect(frames.map((f) => f.function)).toEqual(["outer", "", "inner"]);
    expect(frames[2]).toMatchObject({
      module: "static/js/main.js",
      lineno: 10,
      colno: 5,
      in_app: true,
    });
    expect(frames[0].in_app).toBe(false);
  });

  it("leaves `@` lines alone by default, so Node parsing is unchanged", () => {
    const stack = "Error: user@host:1:2 failed\n    at run (/app/src/x.js:3:4)";
    expect(parseStack(stack)).toHaveLength(1);
    expect(nodeParseStack(stack, "/app")).toEqual([
      expect.objectContaining({ module: "src/x.js", function: "run" }),
    ]);
  });
});
