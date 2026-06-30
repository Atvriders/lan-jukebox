export type ParsedInput =
  | { kind: "video"; videoId: string }
  | { kind: "query"; query: string }
  | { kind: "reject"; reason: string };

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(["shorts", "embed", "live", "v"]);

export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) return { kind: "reject", reason: "empty input" };

  const hasScheme = /^https?:\/\//i.test(input);
  const looksLikeUrl = hasScheme || /^[\w-]+(\.[\w-]+)+\//.test(input);
  if (!looksLikeUrl) return { kind: "query", query: input };

  let url: URL;
  try {
    url = new URL(hasScheme ? input : `https://${input}`);
  } catch {
    return { kind: "query", query: input };
  }

  const host = url.hostname.toLowerCase();

  // The protocol-less heuristic also fires on legitimate `word.tld/path` search queries
  // (e.g. "fly.me/to/the/moon", "death.grips/get.got"). When there is no explicit scheme
  // and the inferred host is not a recognized YouTube host, treat the input as a search
  // query rather than rejecting it. Inputs that carry an explicit http(s):// scheme but
  // point at a non-YouTube host still fall through to the reject branch below.
  if (!hasScheme && host !== "youtu.be" && !YT_HOSTS.has(host)) {
    return { kind: "query", query: input };
  }

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return VIDEO_ID.test(id)
      ? { kind: "video", videoId: id }
      : { kind: "reject", reason: "invalid youtu.be video id" };
  }

  if (YT_HOSTS.has(host)) {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID.test(v)) return { kind: "video", videoId: v };

    const segs = url.pathname.split("/").filter(Boolean);
    const prefix = segs[0];
    const candidate = segs[1];
    if (prefix && candidate && PATH_PREFIXES.has(prefix) && VIDEO_ID.test(candidate)) {
      return { kind: "video", videoId: candidate };
    }

    if (url.searchParams.get("list")) {
      return { kind: "reject", reason: "playlist URLs are not supported — link a single video" };
    }
    return { kind: "reject", reason: "could not find a video id in the YouTube URL" };
  }

  return { kind: "reject", reason: "only YouTube links are accepted" };
}
