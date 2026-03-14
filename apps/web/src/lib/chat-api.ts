import type { ChatCommand, ThreadSearchResponse } from "@social/shared";

export const chatServerUrl =
  process.env.NEXT_PUBLIC_CHAT_SERVER_URL ?? "http://localhost:4000";

export async function sendCommand<T = { ok: boolean }>(
  command: ChatCommand
): Promise<T> {
  return fetchJson<T>(`${chatServerUrl}/commands`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
}

export async function searchThreadMessages(params: {
  agentId: string;
  threadId: string;
  query: string;
  limit?: number;
}): Promise<ThreadSearchResponse> {
  const searchParams = new URLSearchParams({
    agentId: params.agentId,
    query: params.query
  });

  if (params.limit) {
    searchParams.set("limit", String(params.limit));
  }

  return fetchJson<ThreadSearchResponse>(
    `${chatServerUrl}/threads/${encodeURIComponent(params.threadId)}/search?${searchParams.toString()}`
  );
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload
        ? payload.error || "Request failed."
        : "Request failed."
    );
  }

  return payload as T;
}
