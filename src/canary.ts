import type { Logger } from "pino";
import type { YouTubeService } from "./youtube/index.js";

// "Me at the zoo" — the first, permanently-public YouTube video.
const KNOWN_GOOD_VIDEO_ID = "jNQXAC9IVRw";

export async function startupCanary(
  youtube: Pick<YouTubeService, "resolve">,
  log: Logger,
): Promise<boolean> {
  try {
    const meta = await youtube.resolve(KNOWN_GOOD_VIDEO_ID);
    log.info({ title: meta.title }, "extraction canary passed");
    return true;
  } catch (err) {
    log.error({ err }, "extraction canary FAILED — yt-dlp may be stale or the IP blocked");
    return false;
  }
}
