import { EventEmitter } from "node:events";
import type { ServerPlayerMessage } from "../types/index.js";

/**
 * A VoiceSession-shaped audio sink that drives a remote browser <audio> over WebSocket.
 * The controller calls play/pause/resume/seek/setVolume/skip/stop exactly as it called a
 * VoiceSession; this serializes them into ServerPlayerMessages and forwards them through the
 * injected `send` callback (set by ws.ts when a Player attaches, null when it detaches).
 *
 * End-of-track and playback-error come FROM the client (ws.ts calls onTrackEnded /
 * onPlaybackError), and are re-emitted as 'trackEnd' / 'error' for the controller's
 * advance-exactly-once guard. There is deliberately NO idle timer and NO 'idle' event:
 * the station never stops (spec §3/§4).
 */
export class BrowserPlayerSink extends EventEmitter {
  private send: ((m: ServerPlayerMessage) => void) | null = null;
  private destroyed = false;

  setSend(send: ((m: ServerPlayerMessage) => void) | null): void {
    this.send = send;
  }

  private emitMsg(m: ServerPlayerMessage): void {
    if (this.destroyed) return;
    this.send?.(m);
  }

  play(opts: { audioUrl: string; startMs: number }): void {
    this.emitMsg({ type: "load", audioUrl: opts.audioUrl, startMs: opts.startMs });
    this.emitMsg({ type: "play" });
  }
  pause(): void {
    this.emitMsg({ type: "pause" });
  }
  resume(): void {
    this.emitMsg({ type: "play" });
  }
  // Advancing to the next track is the controller's job (it runs its advance guard on the
  // resulting 'trackEnd'); the sink only tells the browser to stop emitting audio.
  skip(): void {
    this.emitMsg({ type: "pause" });
  }
  seek(ms: number): void {
    this.emitMsg({ type: "seek", ms });
  }
  setVolume(pct: number): void {
    this.emitMsg({ type: "setVolume", pct });
  }
  // NO teardown — the station never ends. stop() just halts the browser audio.
  stop(): void {
    this.emitMsg({ type: "pause" });
  }
  // PlayerRegistry (§3.2) calls this on the PREVIOUS speaker's sink when a new device claims the
  // Player: tell that browser to halt its <audio> so two devices never play at once. No teardown.
  relinquish(): void {
    this.emitMsg({ type: "pause" });
  }

  /** ws.ts → client {type:"trackEnded"}: the browser finished the track. */
  onTrackEnded(): void {
    if (this.destroyed) return;
    this.emit("trackEnd");
  }
  /** ws.ts → client {type:"playbackError",message}: the browser failed to play the track. */
  onPlaybackError(message: string): void {
    if (this.destroyed) return;
    this.emit("error", message);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.send = null;
    this.removeAllListeners();
  }
}
