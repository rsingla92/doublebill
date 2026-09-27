import { describe, expect, it } from "vitest";
import { localPoster } from "./posters";

describe("localPoster", () => {
  it("maps a fetched poster to the site's copy and leaves the rest as they are", () => {
    const files = { "https://image.tmdb.org/t/p/w500/abc.jpg": "0123456789abcdef0123.jpg" };
    expect(localPoster("https://image.tmdb.org/t/p/w500/abc.jpg", files)).toBe("/posters/0123456789abcdef0123.jpg");
    expect(localPoster("https://viff.org/media/still.jpg", files)).toBe("https://viff.org/media/still.jpg");
    expect(localPoster("", files)).toBe("");
  });
});
