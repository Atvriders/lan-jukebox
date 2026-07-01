import { loadConfig } from "./config.js";
import { YouTubeService } from "./youtube/index.js";
import { AudioCache } from "./cache/index.js";
import { Semaphore } from "./util/semaphore.js";
import { StationController } from "./orchestrator/index.js";
import { DEFAULT_SETTINGS } from "./types/index.js";
import { RadioEngine } from "./radio/index.js";
import { PlayerRegistry } from "./players/registry.js";
import { buildApp } from "./server/app.js";
import { StationBroadcaster } from "./server/ws.js";
import { createLogger, setRootLogger } from "./util/logger.js";
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
  const station = new StationController({
    // The controller's download dep reports progress as a plain percent number, while
    // YouTubeService.download reports a DownloadProgress record — bridge the two here.
    download: (videoId, opts) =>
      youtube.download(videoId, media.cacheDir, {
        onProgress: opts?.onProgress ? (p) => opts.onProgress!(p.percent) : undefined,
      }),
    // Register the freshly-downloaded file in the LRU cache, then pin it so the audio route
    // can serve it and it is not evicted while it is the current track.
    pin: (videoId, path) => {
      cache.register(videoId, path);
      cache.pin(videoId);
    },
    unpin: (videoId) => cache.unpin(videoId),
    prefetch: (videoId) =>
      downloads.run(() => youtube.download(videoId, media.cacheDir)).then(() => {}),
    settings: { ...DEFAULT_SETTINGS, maxTrackDurationSec: media.maxTrackDurationSec ?? 0 },
    onSettingsChanged: () => scheduleSnapshot(),
  });
  // Persist queue/settings/playback changes (debounced) so the station survives a restart.
  station.on("changed", scheduleSnapshot);

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
