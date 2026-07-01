import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// Type-only imports pull in the `declare module "fastify"` augmentations these plugins
// ship: @fastify/session adds `req.session`/`req.sessionStore`, @fastify/cookie adds
// `reply.clearCookie`. Under verbatimModuleSyntax both are fully erased at emit, so this
// adds no runtime dependency — it only makes the augmented types visible to tsc.
import type {} from "@fastify/session";
import type {} from "@fastify/cookie";
import type { WebConfig } from "../config.js";
import type { LoginRequest, SessionInfo } from "../types/index.js";

/**
 * Constant-time string comparison. timingSafeEqual throws on unequal lengths, so we
 * guard with Buffer.byteLength first and return false (a length mismatch is already a
 * non-match; the early return leaks only length, never content).
 */
export function verifyPassword(input: string, expected: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sessionInfo(req: FastifyRequest): SessionInfo | null {
  const s = req.session;
  if (!s.authed || !s.deviceId || !s.displayName) return null;
  return { displayName: s.displayName, deviceId: s.deviceId };
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (req.session.authed === true) return true;
  await reply.code(401).send({ error: "unauthenticated" });
  return false;
}

export function registerAuthRoutes(app: FastifyInstance, cfg: WebConfig): void {
  app.post<{ Body: Partial<LoginRequest> }>("/api/login", async (req, reply) => {
    const password = (req.body?.password ?? "").toString();
    const displayName = (req.body?.displayName ?? "").toString().trim();
    const deviceId = (req.body?.deviceId ?? "").toString().trim();
    if (!displayName || !deviceId) {
      return reply.code(400).send({ error: "displayName and deviceId are required" });
    }
    // In no-password mode (config: VIEWER_PASSWORD omitted + ALLOW_NO_PASSWORD=true, which
    // sets cfg.viewerPassword="" and cfg.allowNoPassword=true) the password check is bypassed
    // entirely — any submitted password is accepted. Without this branch the empty expected
    // password would only match an exactly-empty submitted value, locking out a client that
    // sends any non-empty value (e.g. a password-manager autofill), so the documented
    // "bypass" would not actually bypass.
    if (!cfg.allowNoPassword && !verifyPassword(password, cfg.viewerPassword)) {
      return reply.code(401).send({ error: "invalid_password" });
    }
    // Rotate the session id to defeat fixation, then destroy the consumed pre-login
    // record. regenerate() replaces req.session in place but leaves the old store entry,
    // so capture its id first and destroy it explicitly.
    const oldId = req.session.sessionId;
    await req.session.regenerate();
    if (oldId && oldId !== req.session.sessionId) {
      await new Promise<void>((res) => req.sessionStore.destroy(oldId, () => res()));
    }
    req.session.authed = true;
    req.session.displayName = displayName;
    req.session.deviceId = deviceId;
    return reply.send({ displayName, deviceId } satisfies SessionInfo);
  });

  app.post("/api/logout", async (req, reply) => {
    await req.session.destroy();
    return reply.clearCookie("sid", { path: "/" }).code(204).send();
  });
}
