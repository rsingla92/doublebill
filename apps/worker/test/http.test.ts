import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, fetchText, HttpError, isBlocked, NetworkError } from "../src/http.js";

const url = new URL("https://example.test/schedule");

afterEach(() => vi.unstubAllGlobals());

describe("fetchText", () => {
  it("does not retry a non-retryable status", async () => {
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchText(url)).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and returns the eventual success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchText(url)).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("names the reason when the host cannot be reached on any attempt", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed", { cause: reset }); }));
    const failure = fetchText(url, { attempts: 2 });
    await expect(failure).rejects.toBeInstanceOf(NetworkError);
    await expect(failure).rejects.toThrow("GET https://example.test/schedule failed: fetch failed (ECONNRESET: read ECONNRESET)");
  });

  it("gives up after the configured number of attempts", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchText(url, { attempts: 2 })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchJson", () => {
  it("parses a JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(fetchJson(url)).resolves.toEqual({ ok: true });
  });
});

describe("isBlocked", () => {
  it("recognises a firewall's refusal and nothing else", () => {
    expect(isBlocked(new HttpError(url.toString(), 403))).toBe(true);
    expect(isBlocked(new HttpError(url.toString(), 429))).toBe(true);
    expect(isBlocked(new HttpError(url.toString(), 404))).toBe(false);
    expect(isBlocked(new HttpError(url.toString(), 503))).toBe(false);
    expect(isBlocked(new NetworkError(url.toString(), new TypeError("fetch failed")))).toBe(true);
    expect(isBlocked(new TypeError("unexpected"))).toBe(false);
  });
});
