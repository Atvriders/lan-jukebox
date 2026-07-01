import type {
  AddRequest,
  AddResponse,
  ControlAction,
  ControlRequest,
  ControlResponse,
  LoginRequest,
  LyricsResult,
  PickRequest,
  PickResponse,
  SessionInfo,
  SpeakerAction,
  SpeakerRequest,
  SpeakerResponse,
  StationStateResponse,
} from "../types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  // 204 / empty bodies: calling res.json() would throw — short-circuit.
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined as T;
  return (await res.json()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  // Only attach a JSON content-type when there is a body (Fastify 400s on an empty
  // body sent with application/json).
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return req<T>(url, init);
}

export const api = {
  login: (body: LoginRequest) => post<SessionInfo>("/api/login", body),
  logout: () => post<void>("/api/logout"),
  state: () => req<StationStateResponse>("/api/state"),
  add: (urlOrQuery: string) => post<AddResponse>("/api/add", { urlOrQuery } satisfies AddRequest),
  pick: (candidateId: string) =>
    post<PickResponse>("/api/pick", { candidateId } satisfies PickRequest),
  control: (action: ControlAction, value?: ControlRequest["value"]) =>
    post<ControlResponse>(
      "/api/control",
      value === undefined ? { action } : ({ action, value } satisfies ControlRequest),
    ),
  speaker: (action: SpeakerAction) =>
    post<SpeakerResponse>("/api/speaker", { action } satisfies SpeakerRequest),
  lyrics: (trackId: string) =>
    req<LyricsResult>(`/api/lyrics?trackId=${encodeURIComponent(trackId)}`),
};
