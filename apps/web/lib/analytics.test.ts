import { describe, expect, it } from "vitest";
import { goatCounterEndpoint } from "./analytics";

describe("goatCounterEndpoint", () => {
  it("builds the count endpoint from a site code", () => {
    expect(goatCounterEndpoint("doublebill")).toBe("https://doublebill.goatcounter.com/count");
    expect(goatCounterEndpoint(" Double-Bill ")).toBe("https://double-bill.goatcounter.com/count");
  });

  it("stays off without a code", () => {
    expect(goatCounterEndpoint(undefined)).toBeNull();
    expect(goatCounterEndpoint("")).toBeNull();
    expect(goatCounterEndpoint("   ")).toBeNull();
  });

  it("refuses anything that is not a bare site code", () => {
    expect(goatCounterEndpoint("https://doublebill.goatcounter.com/count")).toBeNull();
    expect(goatCounterEndpoint("doublebill.goatcounter.com")).toBeNull();
    expect(goatCounterEndpoint("evil.example/x")).toBeNull();
    expect(goatCounterEndpoint("-doublebill")).toBeNull();
  });
});
