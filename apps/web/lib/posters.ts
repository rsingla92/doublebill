import { readFileSync } from "node:fs";
import path from "node:path";
import { withBase } from "./base-path";

/** Source address to file name under public/posters/, written by scripts/fetch-posters.mjs before the build. */
export type PosterManifest = Record<string, string>;

let loaded: PosterManifest | undefined;

function manifest(): PosterManifest {
  if (loaded === undefined) {
    try {
      loaded = JSON.parse(readFileSync(path.join(process.cwd(), "public", "posters", "manifest.json"), "utf8")) as PosterManifest;
    } catch {
      loaded = {};
    }
  }
  return loaded;
}

/** The site's own copy of a poster when the build fetched one, else the remote address as it was. */
export function localPoster(url: string, files: PosterManifest = manifest()): string {
  const name = files[url];
  return name ? withBase(`/posters/${name}`) : url;
}
