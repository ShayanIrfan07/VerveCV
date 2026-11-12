import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("binds to all interfaces and port 3000 by default", () => {
    expect(loadConfig({})).toMatchObject({ host: "0.0.0.0", port: 3000, databaseUrl: null });
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow(/PORT/);
  });
});
