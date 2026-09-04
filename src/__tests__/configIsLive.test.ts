import * as fs from "fs";
import * as path from "path";

import { Secploy } from "../index";
import { LogLevel } from "../types";

/**
 * A guard against configuration that does not do anything.
 *
 * Three separate settings in this project turned out to be declared,
 * defaulted, and never read - the sampling rate, the queue bound, and the
 * ingest's rate limit. Each was found by accident, months apart, and each had
 * been quietly lying to whoever set it.
 *
 * Fixing them one at a time does not stop a fourth.
 */

const SRC = path.resolve(__dirname, "..");

/** Every option the public config declares. */
function declaredOptions(): string[] {
  const types = fs.readFileSync(path.join(SRC, "types.ts"), "utf8");
  const block = types.match(/export interface SecployConfig \{([\s\S]*?)\n\}/);
  if (!block) throw new Error("could not find SecployConfig");

  return [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** Every identifier read anywhere in the package, excluding the declarations. */
function identifiersRead(): Set<string> {
  const seen = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      // The declaration itself is not a use, or every option would look read.
      if (entry.name === "types.ts") continue;

      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/\.(\w+)/g)) seen.add(match[1]);
      for (const match of source.matchAll(/["'](\w+)["']/g)) seen.add(match[1]);
    }
  };
  walk(SRC);

  return seen;
}

describe("configuration is live", () => {
  it("reads every option it declares", () => {
    const read = identifiersRead();
    const dead = declaredOptions().filter((option) => !read.has(option));

    expect(dead).toEqual([]);
  });

  it("would notice a new dead option", () => {
    // A guard that cannot fail is not a guard.
    expect(identifiersRead().has("anOptionNobodyReads")).toBe(false);
  });
});

describe("logLevel", () => {
  const clients: Secploy[] = [];

  const build = (overrides: Record<string, unknown>) => {
    const client = new Secploy({
      apiKey: "k", environmentKey: "e", organizationId: "o",
      ingestUrl: "https://ingest.example.com/ingest",
      captureUncaught: false, realtime: false,
      ...overrides,
    } as any);
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    while (clients.length) await clients.pop()!.stop();
    jest.restoreAllMocks();
  });

  it("leaves quieter methods untouched", () => {
    // It was declared, defaulted and never read: every console level was
    // captured whatever it was set to, so an application asking for errors
    // only still shipped its debug output.
    const originalDebug = console.debug;
    const originalError = console.error;

    build({ captureConsole: true, logLevel: LogLevel.ERROR });

    expect(console.debug).toBe(originalDebug);
    expect(console.error).not.toBe(originalError);
  });

  it("captures everything at the lowest level", () => {
    const originalDebug = console.debug;
    build({ captureConsole: true, logLevel: LogLevel.DEBUG });
    expect(console.debug).not.toBe(originalDebug);
  });

  it("restores only what it replaced", () => {
    const before = { debug: console.debug, error: console.error };
    const client = build({ captureConsole: true, logLevel: LogLevel.ERROR });

    return client.stop().then(() => {
      expect(console.debug).toBe(before.debug);
      expect(console.error).toBe(before.error);
    });
  });
});

describe("debug", () => {
  it("reports what the SDK is doing", async () => {
    // It used to gate console capture. When that became a setting of its own,
    // `debug` was left declared and unread - turning it on did nothing.
    const info = jest.spyOn(console, "info").mockImplementation(() => {});

    const client = new Secploy({
      apiKey: "k", environmentKey: "e", organizationId: "o",
      ingestUrl: "https://ingest.example.com/ingest",
      captureUncaught: false, captureConsole: false, realtime: false,
      debug: true,
    } as any);

    expect(info).toHaveBeenCalled();
    expect(String(info.mock.calls[0][0])).toContain("[secploy] started");

    await client.stop();
    info.mockRestore();
  });

  it("says nothing when off", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});

    const client = new Secploy({
      apiKey: "k", environmentKey: "e", organizationId: "o",
      ingestUrl: "https://ingest.example.com/ingest",
      captureUncaught: false, captureConsole: false, realtime: false,
      debug: false,
    } as any);

    expect(info).not.toHaveBeenCalled();

    await client.stop();
    info.mockRestore();
  });
});
