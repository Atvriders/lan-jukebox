import { loadConfig, materializeCookies } from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { StationController } from "./orchestrator/index.js";
import { Queue } from "./queue/index.js";
import { DEFAULT_SETTINGS } from "./types/index.js";
import { RadioEngine } from "./radio/index.js";
import { PlayerRegistry } from "./players/registry.js";
import { buildApp } from "./server/app.js";
import { StationBroadcaster } from "./server/ws.js";
import { createLogger, setRootLogger } from "./util/logger.js";
import { createCoalescedDownload } from "./util/coalesce-download.js";
import { installCrashHandlers, installSignalHandlers } from "./lifecycle.js";
import { startupCanary } from "./canary.js";
import {
  collectStationSnapshot,
  writeStationSnapshot,
  readStationSnapshot,
  restoreStationSnapshot,
} from "./orchestrator/snapshot.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { media, station: stationCfg, web } = cfg;
  const log = createLogger(stationCfg.logLevel);
  // Publish the configured logger as the process-wide root so module-scope consumers log
  // at LOG_LEVEL instead of their own default-"info" instance.
  setRootLogger(log);
  installCrashHandlers(log);

  // Materialize inline YT_COOKIES_TEXT (pasted into compose) to a file for yt-dlp's --cookies;
  // an explicit YT_COOKIES path wins. No-op when neither is set.
  media.ytCookiesFile = await materializeCookies(media);

  const youtube = new YouTubeService(media);
  const cache = new AudioCache(media.cacheDir, media.cacheMaxBytes);
  await cache.init();
  const downloads = new Semaphore(stationCfg.maxConcurrentDownloads);

  // Debounced snapshot writer — defined before the controller so its 'changed' handler
  // (wired below) closes over it. Coalesces bursts of queue/settings changes into one write.
  // collectStationSnapshot(station, activePlayerDeviceId, now) per snapshot.ts (Task 1.7);
  // the active-player id comes off the registry, not the orchestrator.
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  // Once shutdown begins, app.close() fires each WS socket's close handler, which runs
  // registry.onDisconnect -> station.detachSink()/pause(), both of which emit('changed').
  // That 'changed' listener is scheduleSnapshot — so without this guard the timer the
  // shutdown task just cleared would be re-armed against a torn-down station/registry.
  let shuttingDown = false;
  const scheduleSnapshot = (): void => {
    if (shuttingDown) return;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      writeStationSnapshot(
        media.cacheDir,
        collectStationSnapshot(station, registry.activePlayerDeviceId, Date.now()),
      ).catch((err) => log.error({ err }, "station snapshot write failed"));
    }, 3000);
  };

  const broadcaster = new StationBroadcaster();

  // StationController owns the queue + sink; its deps are the download fn + cache pin/unpin +
  // settings + onSettingsChanged (see StationControllerDeps, Task 1.5). It does NOT take the
  // youtube/radio objects directly — the radio plugs in via setRadioContinuation / setRadioTopUp.
  // Inject the Queue built with the configured history ring size so HISTORY_MAX_ITEMS is
  // actually honored (StationController would otherwise default to new Queue() = 100).
  const queue = new Queue({ historyMax: media.historyMaxItems });
  // Single download function shared by BOTH the load path (deps.download) and the prefetch path
  // (deps.prefetch). It coalesces concurrent downloads of the same videoId and consults the cache
  // first, so a track enqueued into an idle queue (prefetch fires, then it is promoted to current
  // and loaded) is fetched by exactly ONE yt-dlp — not two racing processes writing the same
  // `--no-part` file, which corrupted the audio and made the browser skip the user's song into a
  // radio track. Every download runs through the `downloads` semaphore so the cap actually bounds
  // concurrency (deps.download previously bypassed it).
  const coalescedDownload = createCoalescedDownload({
    download: (videoId, opts) => youtube.download(videoId, media.cacheDir, opts),
    cacheGet: (videoId) => cache.get(videoId),
    cacheGetAudio: (videoId) => cache.getAudio(videoId),
    semaphore: downloads,
  });
  const station = new StationController({
    queue,
    // The controller's download dep reports progress as a plain percent number, while
    // YouTubeService.download reports a DownloadProgress record — bridge the two here.
    // durationSec is forwarded so YouTubeService.download can auto-scale the yt-dlp
    // timeout for long mixes/concerts instead of killing them at the short default.
    download: (videoId, opts) =>
      coalescedDownload(videoId, {
        durationSec: opts?.durationSec,
        onProgress: opts?.onProgress ? (p) => opts.onProgress!(p.percent) : undefined,
      }),
    // Register the freshly-downloaded file in the LRU cache WITH its real audio format, then pin
    // it so the audio route can serve it AND (crucially) serve a browser-playable opus/webm/m4a
    // as-is instead of transcoding — chooseDelivery treats a null audio as "must transcode", so
    // dropping the AudioInfo here forced a redundant ffmpeg pass on every orchestrator-downloaded
    // track. Not evicted while it is the current track.
    pin: (videoId, path, audio) => {
      cache.register(videoId, path, audio);
      cache.pin(videoId);
    },
    // Unpin BOTH the source key and the derived `${videoId}.m4a` transcode key: the audio route
    // pins the transcode under that derived key (audio/index.ts) and nothing else ever unpins it,
    // so without this the transcoded .m4a of every played track would stay pinned forever and
    // grow the cache past CACHE_MAX_MB. Releasing both here lets the LRU reclaim them.
    unpin: (videoId) => {
      cache.unpin(videoId);
      cache.unpin(`${videoId}.m4a`);
    },
    // Prefetch the upcoming head. Register the resulting file in the LRU cache (NOT pinned)
    // so its bytes are tracked + evictable and loadCurrentLocked can hit it instead of
    // re-downloading. Without register() the file was an untracked on-disk orphan the
    // CACHE_MAX_MB cap could never reclaim. durationSec scales the timeout for long tracks.
    prefetch: (videoId, durationSec) =>
      coalescedDownload(videoId, { durationSec })
        .then((r) => {
          cache.register(videoId, r.path, r.audio);
        })
        .catch(() => {}),
    settings: { ...DEFAULT_SETTINGS, maxTrackDurationSec: media.maxTrackDurationSec ?? 0 },
    onSettingsChanged: () => scheduleSnapshot(),
  });
  // Persist queue/settings/playback changes (debounced) so the station survives a restart.
  station.on("changed", scheduleSnapshot);

  // A track that fails to download or play is discarded and skipped; surface WHY to every
  // subscriber so the client's "Skipped '<title>' — <reason>" banner is not dead UI.
  station.on("trackError", (e: { videoId: string; title: string; reason: string }) => {
    broadcaster.broadcast({ type: "trackError", ...e });
  });

  // RadioEngine deps are { youtube, station, settings } (Task 1.6). Wire it into the controller
  // via the continuation hooks so a drained queue pulls the next related/artist track forever.
  const radio = new RadioEngine({
    youtube,
    station,
    settings: () => ({
      autoplay: station.settings.autoplay,
      autoplaySource: station.settings.autoplaySource,
    }),
  });
  station.setRadioContinuation(() => radio.nextCandidate());
  station.setRadioTopUp(() => {
    void radio.ensureAhead(stationCfg.prefetchDepth);
  });

  // Active-player + device memory. PlayerRegistry deps are { dir, station } (Task 3.2); init
  // reads the persisted device registry. The broadcaster pushes 'state' to all sockets.
  const registry = new PlayerRegistry({ dir: media.cacheDir, station });
  await registry.init();
  broadcaster.attach(station);

  // Build + listen IMMEDIATELY — there is no gateway/login to wait for (unlike the bot).
  const app = await buildApp({
    cfg: web,
    station,
    youtube,
    registry,
    broadcaster,
    cache,
    cacheDir: media.cacheDir,
    downloads,
    radio,
    searchLimit: media.searchResultCount,
  });
  await app.listen({ port: web.port, host: web.host });
  log.info({ host: web.host, port: web.port }, "lan-jukebox listening");

  // Restore the persisted station (current/queue/seed/position/settings). restoreStationSnapshot
  // is (file, station, log) per Task 1.7 — the active-player id is reattached when the speaker
  // reconnects via PlayerRegistry.onConnect, so it is not replayed here.
  const snap = await readStationSnapshot(media.cacheDir);
  if (snap) await restoreStationSnapshot(snap, station, log);

  // Register signal handlers AFTER listen so a SIGTERM flushes the live snapshot and closes
  // the app. Every task is guarded so it is safe even if a signal arrives mid-startup.
  installSignalHandlers(
    [
      async () => {
        // Latch shutdown BEFORE clearing so any 'changed' emitted during the subsequent
        // app.close() task is ignored by scheduleSnapshot and cannot re-arm the timer.
        shuttingDown = true;
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
          snapshotTimer = null;
        }
        await writeStationSnapshot(
          media.cacheDir,
          collectStationSnapshot(station, registry.activePlayerDeviceId, Date.now()),
        );
      },
      async () => {
        await app.close();
      },
    ],
    { graceMs: 8000 },
    log,
  );

  // Startup canary — log only, never abort.
  await startupCanary(youtube, log);
}

// A fatal startup rejection (bad config, EADDRINUSE on listen, …) must crash-and-exit
// non-zero so the supervisor restarts/alerts — NOT get swallowed by the lenient
// unhandledRejection policy. Log through pino when possible; some failures happen before
// the logger exists (a bad env thrown from loadConfig), so fall back to console.error.
main().catch((err) => {
  try {
    createLogger().fatal({ err }, "startup failed");
  } catch {
    console.error("startup failed", err);
  }
  process.exit(1);
});
