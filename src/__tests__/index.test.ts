import { Secploy } from "../index";

const config = {
  apiKey: "test-api-key",
  environmentKey: "test-env",
  organizationId: "test-org",
  ingestUrl: "https://ingest.secploy.com",
};

describe("Secploy", () => {
  let client: Secploy | null = null;

  afterEach(async () => {
    if (client) {
      await client.stop();
      client = null;
    }
  });

  it("creates an instance from the required config", () => {
    client = new Secploy(config);
    expect(client).toBeInstanceOf(Secploy);
  });

  it("exposes the gate and its collaborators", () => {
    client = new Secploy(config);
    expect(client.gate).toBeDefined();
    expect(client.securityPolicy).toBeDefined();
    expect(client.identities).toBeDefined();
    expect(typeof client.gate.express).toBe("function");
    expect(typeof client.gate.koa).toBe("function");
    expect(typeof client.gate.fastify).toBe("function");
  });

  it("requires each credential", () => {
    expect(() => new Secploy({ ...config, apiKey: "" })).toThrow("API key is required");
    expect(() => new Secploy({ ...config, environmentKey: "" })).toThrow(
      "Environment key is required",
    );
    expect(() => new Secploy({ ...config, organizationId: "" })).toThrow(
      "Organization ID is required",
    );
    expect(() => new Secploy({ ...config, ingestUrl: "" })).toThrow("Ingest URL is required");
  });

  it("rejects an unknown gate mode", () => {
    expect(() => new Secploy({ ...config, gateMode: "bogus" as any })).toThrow(
      /Invalid gateMode/,
    );
  });

  it("defaults to remote so upgrading changes nothing on its own", () => {
    client = new Secploy(config);
    // A cached gate must be opted into, never switched on by an SDK upgrade.
    expect(client.securityPolicy.isLoaded).toBe(false);
  });
});
