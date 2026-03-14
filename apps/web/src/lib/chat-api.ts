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

export async function streamAppSource(params: {
  prompt: string;
  agentId?: string;
  threadId?: string;
  name?: string;
  description?: string;
  currentSource?: string;
  onDelta?: (delta: string, accumulated: string) => void;
}): Promise<{
  prompt: string;
  source: string;
  model: string;
  generatedAt: string;
  threadId: string | null;
}> {
  type StreamedAppSource = {
    prompt: string;
    source: string;
    model: string;
    generatedAt: string;
    threadId: string | null;
  };
  const { onDelta, ...body } = params;
  const response = await fetch(`${chatServerUrl}/ai/app-source/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error || "Unable to stream app source.");
  }

  if (!response.body) {
    throw new Error("Streaming response body is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let finalPayload: StreamedAppSource | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex < 0) {
        break;
      }

      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const parsedEvent = parseSseEvent(rawEvent);
      if (!parsedEvent) {
        continue;
      }

      if (parsedEvent.event === "delta") {
        const payload = JSON.parse(parsedEvent.data) as { delta?: string };
        const delta = payload.delta ?? "";
        accumulated += delta;
        onDelta?.(delta, accumulated);
        continue;
      }

      if (parsedEvent.event === "done") {
        finalPayload = JSON.parse(parsedEvent.data) as StreamedAppSource;
        continue;
      }

      if (parsedEvent.event === "error") {
        const payload = JSON.parse(parsedEvent.data) as { error?: string };
        throw new Error(payload.error || "Unable to stream app source.");
      }
    }

    if (done) {
      break;
    }
  }

  if (!finalPayload) {
    throw new Error("Streaming response ended before completion.");
  }

  return finalPayload;
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

function parseSseEvent(rawEvent: string): {
  data: string;
  event: string;
} | null {
  const trimmedEvent = rawEvent.trim();
  if (!trimmedEvent) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of trimmedEvent.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  return {
    event: eventName,
    data: dataLines.join("\n")
  };
}
