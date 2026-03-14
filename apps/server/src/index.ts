import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import * as Automerge from "@automerge/automerge";
import type { Response } from "express";
import cors from "cors";
import express from "express";

import {
  type AgentKind,
  type AppJsonValue,
  type AppPathSegment,
  type AiContextMessage,
  type AiParticipantContext,
  type AiSummary,
  type ChatCommand,
  type ChatMessage,
  type ChatThread,
  type ClientSnapshot,
  type CommandRecommendation,
  type CommandRecommendationResponse,
  type ThreadAppState,
  type ThreadSearchResponse,
  type UserProfile,
  createProceduralAvatar,
  defaultThreadAppTemplates,
  extractMessageText,
  isAppJsonValue,
  isRecord,
  sortByUpdatedAtDescending,
  uniqueIds
} from "@social/shared";

import {
  buildCommandDocument,
  commandCategories,
  commandDefinitions
} from "./command-directory.js";
import { aiConfigured, env } from "./env.js";
import {
  answerWithContext,
  embedText,
  embedTexts,
  generateAppSource,
  generateProfileSummary,
  generateThreadSummary,
  isAiAvailable,
  streamAppSource,
  summarizeContext
} from "./openai-service.js";
import {
  buildSnippet,
  cosineSimilarity,
  normalizeSearchText,
  scoreDirectTextMatch
} from "./search.js";
import { loadStateFromDisk, saveStateToDisk } from "./persistence.js";
import {
  createEmptyState,
  type StoreState,
  type StoredEmbedding
} from "./state.js";

interface ConnectedClient {
  agentId: string;
  response: Response;
  heartbeat: NodeJS.Timeout;
}

interface CommandOutcome {
  actorId: string | null;
  appId?: string;
  threadId?: string;
  messageId?: string;
  authorId?: string;
}

interface SearchParams {
  agentId: string;
  threadId: string;
  query: string;
  limit: number;
}

type ThreadAppDocument = {
  value: AppJsonValue;
};

const app = express();
const state = createEmptyState();
const clients = new Map<string, ConnectedClient>();
const threadWorkQueues = new Map<string, Promise<void>>();
const userWorkQueues = new Map<string, Promise<void>>();
const queryEmbeddingCache = new Map<string, number[]>();
let commandEmbeddingPromise: Promise<void> | null = null;
let persistQueued = false;
let persistWriting = false;
let persistPromise: Promise<void> = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_request, response) => {
  response.json({
    ok: true,
    service: "social-platform-server",
    events: "/events?agentId=<agent-id>",
    commands: "POST /commands",
    search: "GET /threads/:threadId/search?agentId=<agent-id>&query=<text>",
    ai: {
      appSource: "POST /ai/app-source",
      appSourceStream: "POST /ai/app-source/stream",
      summarize: "POST /ai/summarize",
      respond: "POST /ai/respond",
      commandDirectory: "GET /ai/command-directory",
      commandRecommendations: "POST /ai/command-recommendations"
    }
  });
});

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    users: state.users.size,
    threads: state.threads.size,
    clients: clients.size,
    stateFile: env.stateFile,
    aiConfigured,
    embeddedMessages: state.messageEmbeddings.size,
    embeddedCommands: state.commandEmbeddings.size
  });
});

app.get("/events", (request, response) => {
  const agentId = request.query.agentId;

  if (typeof agentId !== "string" || !agentId.trim()) {
    response.status(400).json({ error: "agentId query parameter is required." });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  const clientId = randomUUID();
  const heartbeat = setInterval(() => {
    response.write(": ping\n\n");
  }, 15_000);

  clients.set(clientId, { agentId, response, heartbeat });

  sendEvent(response, "connected", {
    clientId,
    serverTime: new Date().toISOString()
  });
  sendSnapshot(agentId, response);

  request.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    response.end();
  });
});

app.post("/commands", (request, response) => {
  const command = parseCommand(request.body);

  if (!command) {
    response.status(400).json({ error: "Invalid command payload." });
    return;
  }

  try {
    const outcome = applyCommand(command);
    schedulePersist();
    broadcastSnapshots();

    if (outcome.threadId && outcome.messageId && outcome.authorId) {
      void scheduleThreadRefresh(outcome.threadId, outcome.messageId, outcome.authorId);
    }

    response.status(200).json({
      ok: true,
      outcome,
      snapshot: outcome.actorId ? buildSnapshot(outcome.actorId) : null
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
});

app.get("/threads/:threadId/search", async (request, response) => {
  const agentId = asRequiredString(request.query.agentId, "agentId is required.");
  const query = asRequiredString(request.query.query, "query is required.");
  const limit = parseLimit(request.query.limit, env.searchResultLimit);

  if (!agentId || !query) {
    response.status(400).json({ error: "agentId and query are required." });
    return;
  }

  try {
    const result = await searchThreadMessages({
      agentId,
      threadId: request.params.threadId,
      query,
      limit
    });
    response.status(200).json(result);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to search thread."
    });
  }
});

app.post("/ai/summarize", async (request, response) => {
  if (!isAiAvailable()) {
    response.status(503).json({ error: "OpenAI is not configured on the server." });
    return;
  }

  const body = request.body;
  const maxParagraphs = parseLimit(
    isRecord(body) ? body.maxParagraphs : undefined,
    2
  );

  try {
    if (isRecord(body) && typeof body.threadId === "string") {
      if (typeof body.agentId !== "string" || !body.agentId.trim()) {
        response.status(400).json({ error: "agentId is required for thread summaries." });
        return;
      }

      const thread = getThreadForAgent(body.threadId, body.agentId);
      const summary = await refreshThreadSummary(thread.id, true, maxParagraphs);
      const contextMessages = buildThreadContextMessages(thread.id).slice(
        -env.aiContextMessageLimit
      );

      response.status(200).json({
        prompt: `Summarize ${getThreadLabel(thread, body.agentId)}`,
        output: summary?.content ?? "",
        model: summary?.model ?? env.summaryModel,
        generatedAt: new Date().toISOString(),
        threadId: thread.id,
        threadSummary: summary,
        contextMessages,
        participantSummaries: buildParticipantContext(thread)
      });
      return;
    }

    const context = extractSummaryContext(body);
    if (!context) {
      response.status(400).json({
        error: "Provide either threadId + agentId or a text/context payload."
      });
      return;
    }

    const summary = await summarizeContext({
      context,
      maxParagraphs
    });

    response.status(200).json({
      prompt: "Summarize the provided context",
      output: summary.text,
      model: summary.model,
      generatedAt: new Date().toISOString(),
      threadId: null,
      threadSummary: null,
      contextMessages: [],
      participantSummaries: []
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to summarize."
    });
  }
});

app.post("/ai/respond", async (request, response) => {
  if (!isAiAvailable()) {
    response.status(503).json({ error: "OpenAI is not configured on the server." });
    return;
  }

  const body = request.body;

  if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
    response.status(400).json({ error: "prompt is required." });
    return;
  }

  try {
    const prompt = body.prompt.trim();
    const threadId =
      typeof body.threadId === "string" && body.threadId.trim()
        ? body.threadId
        : null;
    const agentId =
      typeof body.agentId === "string" && body.agentId.trim()
        ? body.agentId
        : null;
    let thread: ChatThread | null = null;
    let threadSummary: AiSummary | null = null;
    let contextMessages: AiContextMessage[] = [];
    let participantSummaries: AiParticipantContext[] = [];

    if (threadId) {
      if (!agentId) {
        response.status(400).json({ error: "agentId is required with threadId." });
        return;
      }

      thread = getThreadForAgent(threadId, agentId);
      threadSummary = thread.summary ?? (await refreshThreadSummary(thread.id, true));
      contextMessages = await buildAiAnswerContext(thread, agentId, prompt);
      participantSummaries = buildParticipantContext(thread);
    }

    const aiResponse = await answerWithContext({
      prompt,
      threadLabel: thread ? getThreadLabel(thread, agentId ?? "") : undefined,
      threadSummary: threadSummary?.content ?? null,
      participantSummaries: participantSummaries.map((participant) => ({
        username: participant.username,
        summary: participant.summary?.content ?? null
      })),
      messages: contextMessages
    });

    response.status(200).json({
      prompt,
      output: aiResponse.text,
      model: aiResponse.model,
      generatedAt: new Date().toISOString(),
      threadId: thread?.id ?? null,
      threadSummary,
      contextMessages,
      participantSummaries
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to generate AI response."
    });
  }
});

app.post("/ai/app-source", async (request, response) => {
  if (!isAiAvailable()) {
    response.status(503).json({ error: "OpenAI is not configured on the server." });
    return;
  }

  const body = request.body;

  if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
    response.status(400).json({ error: "prompt is required." });
    return;
  }

  try {
    const prompt = body.prompt.trim();
    const threadId =
      typeof body.threadId === "string" && body.threadId.trim()
        ? body.threadId
        : null;
    const agentId =
      typeof body.agentId === "string" && body.agentId.trim()
        ? body.agentId
        : null;
    let thread: ChatThread | null = null;
    let threadLabel: string | null = null;
    let contextMessages: AiContextMessage[] = [];

    if (threadId) {
      if (!agentId) {
        response.status(400).json({ error: "agentId is required with threadId." });
        return;
      }

      thread = getThreadForAgent(threadId, agentId);
      threadLabel = getThreadLabel(thread, agentId);
      contextMessages = buildThreadContextMessages(thread.id).slice(
        -Math.min(env.aiContextMessageLimit, 12)
      );
    }

    const result = await generateAppSource({
      prompt,
      appName: typeof body.name === "string" ? body.name : null,
      appDescription: typeof body.description === "string" ? body.description : null,
      currentSource: typeof body.currentSource === "string" ? body.currentSource : null,
      threadLabel,
      messages: contextMessages
    });

    response.status(200).json({
      prompt,
      source: result.source,
      model: result.model,
      generatedAt: new Date().toISOString(),
      threadId: thread?.id ?? null
    });
  } catch (error) {
    response.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to generate app source."
    });
  }
});

app.post("/ai/app-source/stream", async (request, response) => {
  if (!isAiAvailable()) {
    response.status(503).json({ error: "OpenAI is not configured on the server." });
    return;
  }

  const body = request.body;

  if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
    response.status(400).json({ error: "prompt is required." });
    return;
  }

  const prompt = body.prompt.trim();
  const threadId =
    typeof body.threadId === "string" && body.threadId.trim()
      ? body.threadId
      : null;
  const agentId =
    typeof body.agentId === "string" && body.agentId.trim()
      ? body.agentId
      : null;
  let thread: ChatThread | null = null;
  let threadLabel: string | null = null;
  let contextMessages: AiContextMessage[] = [];

  if (threadId) {
    if (!agentId) {
      response.status(400).json({ error: "agentId is required with threadId." });
      return;
    }

    try {
      thread = getThreadForAgent(threadId, agentId);
      threadLabel = getThreadLabel(thread, agentId);
      contextMessages = buildThreadContextMessages(thread.id).slice(
        -Math.min(env.aiContextMessageLimit, 12)
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Unable to load thread context."
      });
      return;
    }
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  try {
    const result = await streamAppSource(
      {
        prompt,
        appName: typeof body.name === "string" ? body.name : null,
        appDescription: typeof body.description === "string" ? body.description : null,
        currentSource: typeof body.currentSource === "string" ? body.currentSource : null,
        threadLabel,
        messages: contextMessages
      },
      (delta) => {
        sendEvent(response, "delta", { delta });
      }
    );

    sendEvent(response, "done", {
      prompt,
      source: result.source,
      model: result.model,
      generatedAt: new Date().toISOString(),
      threadId: thread?.id ?? null
    });
  } catch (error) {
    sendEvent(response, "error", {
      error:
        error instanceof Error
          ? error.message
          : "Unable to stream app source."
    });
  } finally {
    response.end();
  }
});

app.get("/ai/command-directory", (_request, response) => {
  response.status(200).json({
    generatedAt: new Date().toISOString(),
    categories: commandCategories,
    commands: commandDefinitions
  });
});

app.post("/ai/command-recommendations", async (request, response) => {
  const body = request.body;

  if (!isRecord(body) || typeof body.query !== "string" || !body.query.trim()) {
    response.status(400).json({ error: "query is required." });
    return;
  }

  try {
    const limit = parseLimit(body.limit, env.commandRecommendationLimit);
    const result = await recommendCommands(body.query, limit);
    response.status(200).json(result);
  } catch (error) {
    response.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to recommend commands."
    });
  }
});

void startServer().catch((error) => {
  console.error("Unable to start social-platform server.", error);
  process.exit(1);
});

function parseCommand(value: unknown): ChatCommand | null {
  if (!isRecord(value) || typeof value.command !== "string") {
    return null;
  }

  switch (value.command) {
    case "profile.upsert": {
      const profile = value.profile;
      if (!isRecord(profile)) {
        return null;
      }
      if (
        typeof profile.id !== "string" ||
        typeof profile.username !== "string" ||
        !isAgentKind(profile.kind)
      ) {
        return null;
      }

      return {
        command: "profile.upsert",
        profile: {
          id: profile.id,
          username: profile.username,
          kind: profile.kind
        }
      };
    }
    case "friend.add":
    case "friend.remove": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.friendId !== "string"
      ) {
        return null;
      }

      return {
        command: value.command,
        agentId: value.agentId,
        friendId: value.friendId
      };
    }
    case "thread.create": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.title !== "string" ||
        !Array.isArray(value.participantIds) ||
        value.participantIds.some((participantId) => typeof participantId !== "string")
      ) {
        return null;
      }

      return {
        command: "thread.create",
        agentId: value.agentId,
        title: value.title,
        participantIds: value.participantIds
      };
    }
    case "thread.delete": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string"
      ) {
        return null;
      }

      return {
        command: "thread.delete",
        agentId: value.agentId,
        threadId: value.threadId
      };
    }
    case "thread.participants.add":
    case "thread.participants.remove": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string" ||
        !Array.isArray(value.participantIds) ||
        value.participantIds.some((participantId) => typeof participantId !== "string")
      ) {
        return null;
      }

      return {
        command: value.command,
        agentId: value.agentId,
        threadId: value.threadId,
        participantIds: value.participantIds
      };
    }
    case "message.send": {
      if (
        typeof value.threadId !== "string" ||
        typeof value.type !== "string" ||
        typeof value.agentId !== "string" ||
        !isAgentKind(value.agentKind) ||
        !isRecord(value.message)
      ) {
        return null;
      }

      return {
        command: "message.send",
        threadId: value.threadId,
        type: value.type,
        agentId: value.agentId,
        agentKind: value.agentKind,
        message: value.message
      };
    }
    case "message.react.toggle": {
      if (
        typeof value.threadId !== "string" ||
        typeof value.messageId !== "string" ||
        typeof value.emoji !== "string" ||
        typeof value.agentId !== "string"
      ) {
        return null;
      }

      return {
        command: "message.react.toggle",
        threadId: value.threadId,
        messageId: value.messageId,
        emoji: value.emoji,
        agentId: value.agentId
      };
    }
    case "thread.app.create": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string" ||
        typeof value.name !== "string" ||
        typeof value.description !== "string" ||
        typeof value.source !== "string" ||
        !isAppJsonValue(value.value)
      ) {
        return null;
      }

      return {
        command: "thread.app.create",
        agentId: value.agentId,
        threadId: value.threadId,
        name: value.name,
        description: value.description,
        source: value.source,
        value: value.value
      };
    }
    case "thread.app.delete": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string" ||
        typeof value.appId !== "string"
      ) {
        return null;
      }

      return {
        command: "thread.app.delete",
        agentId: value.agentId,
        threadId: value.threadId,
        appId: value.appId
      };
    }
    case "thread.app.meta.update": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string" ||
        typeof value.appId !== "string" ||
        typeof value.name !== "string" ||
        typeof value.description !== "string"
      ) {
        return null;
      }

      return {
        command: "thread.app.meta.update",
        agentId: value.agentId,
        threadId: value.threadId,
        appId: value.appId,
        name: value.name,
        description: value.description
      };
    }
    case "thread.app.source.save": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string" ||
        typeof value.appId !== "string" ||
        typeof value.source !== "string" ||
        !isAppJsonValue(value.value)
      ) {
        return null;
      }

      return {
        command: "thread.app.source.save",
        agentId: value.agentId,
        threadId: value.threadId,
        appId: value.appId,
        source: value.source,
        value: value.value
      };
    }
    case "thread.app.form.update": {
      if (
        typeof value.agentId !== "string" ||
        typeof value.threadId !== "string" ||
        typeof value.appId !== "string" ||
        !Array.isArray(value.path) ||
        value.path.some(
          (segment) => typeof segment !== "string" && typeof segment !== "number"
        ) ||
        !isAppJsonValue(value.value)
      ) {
        return null;
      }

      return {
        command: "thread.app.form.update",
        agentId: value.agentId,
        threadId: value.threadId,
        appId: value.appId,
        path: value.path,
        value: value.value
      };
    }
    default:
      return null;
  }
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "user" || value === "ai";
}

function applyCommand(command: ChatCommand): CommandOutcome {
  switch (command.command) {
    case "profile.upsert": {
      const existingUser = state.users.get(command.profile.id);
      const now = new Date().toISOString();

      state.users.set(command.profile.id, {
        id: command.profile.id,
        username: command.profile.username.trim() || "Anonymous Agent",
        kind: command.profile.kind,
        avatar: existingUser?.avatar ?? createProceduralAvatar(command.profile.id),
        createdAt: existingUser?.createdAt ?? now,
        updatedAt: now,
        profileSummary: existingUser?.profileSummary ?? null
      });

      return {
        actorId: command.profile.id
      };
    }
    case "friend.add": {
      assertUser(command.agentId);
      assertUser(command.friendId);
      addFriendship(command.agentId, command.friendId);
      return {
        actorId: command.agentId
      };
    }
    case "friend.remove": {
      assertUser(command.agentId);
      assertUser(command.friendId);
      removeFriendship(command.agentId, command.friendId);
      return {
        actorId: command.agentId
      };
    }
    case "thread.create": {
      assertUser(command.agentId);
      const participantIds = uniqueIds([command.agentId, ...command.participantIds]);
      participantIds.forEach(assertUser);
      const now = new Date().toISOString();
      const threadId = randomUUID();

      state.threads.set(threadId, {
        id: threadId,
        title: command.title.trim(),
        participantIds,
        createdBy: command.agentId,
        createdAt: now,
        updatedAt: now,
        summary: null
      });
      state.appsByThread.set(
        threadId,
        defaultThreadAppTemplates.map((template) =>
          createThreadAppState(template, command.agentId, now)
        )
      );
      state.messagesByThread.set(threadId, []);

      return {
        actorId: command.agentId
      };
    }
    case "thread.delete": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      state.threads.delete(thread.id);
      const messages = state.messagesByThread.get(thread.id) ?? [];
      for (const message of messages) {
        state.messageEmbeddings.delete(message.id);
      }
      state.appsByThread.delete(thread.id);
      state.messagesByThread.delete(thread.id);
      return {
        actorId: command.agentId
      };
    }
    case "thread.participants.add": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      const nextParticipantIds = uniqueIds([
        ...thread.participantIds,
        ...command.participantIds
      ]);
      nextParticipantIds.forEach(assertUser);

      state.threads.set(thread.id, {
        ...thread,
        participantIds: nextParticipantIds,
        updatedAt: new Date().toISOString()
      });
      return {
        actorId: command.agentId
      };
    }
    case "thread.participants.remove": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      const removalIds = new Set(command.participantIds);
      const nextParticipantIds = thread.participantIds.filter(
        (participantId) => !removalIds.has(participantId)
      );

      if (nextParticipantIds.length === 0) {
        state.threads.delete(thread.id);
        const messages = state.messagesByThread.get(thread.id) ?? [];
        for (const message of messages) {
          state.messageEmbeddings.delete(message.id);
        }
        state.appsByThread.delete(thread.id);
        state.messagesByThread.delete(thread.id);
      } else {
        state.threads.set(thread.id, {
          ...thread,
          participantIds: nextParticipantIds,
          updatedAt: new Date().toISOString()
        });
      }

      return {
        actorId: command.agentId
      };
    }
    case "message.send": {
      assertUser(command.agentId);
      const thread = getThreadForAgent(command.threadId, command.agentId);
      const createdAt = new Date().toISOString();
      const threadMessages = state.messagesByThread.get(thread.id) ?? [];
      const messageId = randomUUID();

      threadMessages.push({
        id: messageId,
        threadId: thread.id,
        type: command.type.trim() || "chat.message",
        agentId: command.agentId,
        agentKind: command.agentKind,
        participantIds: [...thread.participantIds],
        message: command.message,
        createdAt,
        reactions: []
      });

      state.messagesByThread.set(thread.id, threadMessages);
      state.threads.set(thread.id, {
        ...thread,
        updatedAt: createdAt
      });

      return {
        actorId: command.agentId,
        threadId: thread.id,
        messageId,
        authorId: command.agentId
      };
    }
    case "message.react.toggle": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      const threadMessages = state.messagesByThread.get(thread.id) ?? [];
      const message = threadMessages.find(
        (candidate) => candidate.id === command.messageId
      );

      if (!message) {
        throw new Error("Message not found.");
      }

      const existingReactionIndex = message.reactions.findIndex(
        (reaction) =>
          reaction.agentId === command.agentId && reaction.emoji === command.emoji
      );

      if (existingReactionIndex >= 0) {
        message.reactions.splice(existingReactionIndex, 1);
      } else {
        message.reactions.push({
          id: randomUUID(),
          emoji: command.emoji,
          agentId: command.agentId,
          createdAt: new Date().toISOString()
        });
      }

      state.threads.set(thread.id, {
        ...thread,
        updatedAt: new Date().toISOString()
      });

      return {
        actorId: command.agentId
      };
    }
    case "thread.app.source.save": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      if (!command.source.trim()) {
        throw new Error("App source cannot be empty.");
      }

      const now = new Date().toISOString();
      const app = getThreadApp(thread.id, command.appId);
      updateThreadApp(thread.id, app.id, {
        ...app,
        savedSource: command.source,
        document: encodeThreadAppDocument(createThreadAppDocument(command.value)),
        updatedAt: now,
        updatedBy: command.agentId
      });
      state.threads.set(thread.id, {
        ...thread,
        updatedAt: now
      });

      return {
        actorId: command.agentId
      };
    }
    case "thread.app.create": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      if (!command.source.trim()) {
        throw new Error("App source cannot be empty.");
      }

      const now = new Date().toISOString();
      const appId = randomUUID();
      const currentApps = state.appsByThread.get(thread.id) ?? [];
      state.appsByThread.set(thread.id, [
        ...currentApps,
        {
          id: appId,
          name: command.name.trim() || "Untitled app",
          description: command.description.trim(),
          savedSource: command.source,
          document: encodeThreadAppDocument(createThreadAppDocument(command.value)),
          updatedAt: now,
          updatedBy: command.agentId
        }
      ]);
      state.threads.set(thread.id, {
        ...thread,
        updatedAt: now
      });

      return {
        actorId: command.agentId,
        appId
      };
    }
    case "thread.app.delete": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      getThreadApp(thread.id, command.appId);
      const now = new Date().toISOString();
      removeThreadApp(thread.id, command.appId);
      state.threads.set(thread.id, {
        ...thread,
        updatedAt: now
      });

      return {
        actorId: command.agentId
      };
    }
    case "thread.app.meta.update": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      const app = getThreadApp(thread.id, command.appId);
      const now = new Date().toISOString();
      updateThreadApp(thread.id, app.id, {
        ...app,
        name: command.name.trim() || "Untitled app",
        description: command.description.trim(),
        updatedAt: now,
        updatedBy: command.agentId
      });
      state.threads.set(thread.id, {
        ...thread,
        updatedAt: now
      });

      return {
        actorId: command.agentId
      };
    }
    case "thread.app.form.update": {
      const thread = getThreadForAgent(command.threadId, command.agentId);
      const app = getThreadApp(thread.id, command.appId);
      const now = new Date().toISOString();
      const nextDocument = updateThreadAppDocument(
        decodeThreadAppDocument(app.document),
        command.path,
        command.value
      );

      updateThreadApp(thread.id, app.id, {
        ...app,
        document: encodeThreadAppDocument(nextDocument),
        updatedAt: now,
        updatedBy: command.agentId
      });
      state.threads.set(thread.id, {
        ...thread,
        updatedAt: now
      });

      return {
        actorId: command.agentId
      };
    }
  }
}

function assertUser(agentId: string): void {
  if (!state.users.has(agentId)) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
}

function getThreadForAgent(threadId: string, agentId: string): ChatThread {
  const thread = state.threads.get(threadId);

  if (!thread) {
    throw new Error("Thread not found.");
  }
  if (!thread.participantIds.includes(agentId)) {
    throw new Error("Agent is not a participant in this thread.");
  }

  return thread;
}

function getThreadApp(threadId: string, appId: string): ThreadAppState {
  const apps = state.appsByThread.get(threadId) ?? [];
  const app = apps.find((candidate) => candidate.id === appId);

  if (!app) {
    throw new Error("App not found.");
  }

  return app;
}

function updateThreadApp(threadId: string, appId: string, nextApp: ThreadAppState): void {
  const apps = state.appsByThread.get(threadId) ?? [];
  state.appsByThread.set(
    threadId,
    apps.map((app) => (app.id === appId ? nextApp : app))
  );
}

function removeThreadApp(threadId: string, appId: string): void {
  const apps = state.appsByThread.get(threadId) ?? [];
  state.appsByThread.set(
    threadId,
    apps.filter((app) => app.id !== appId)
  );
}

function ensureAllThreadApps(): boolean {
  let changed = false;

  for (const thread of state.threads.values()) {
    const currentApps = state.appsByThread.get(thread.id) ?? [];
    const normalizedApps = currentApps.map(normalizeThreadAppState);
    const currentAppsById = new Map(normalizedApps.map((app) => [app.id, app]));
    const defaultTemplateIds = new Set(defaultThreadAppTemplates.map((template) => template.id));
    const nextApps = defaultThreadAppTemplates.map((template) => {
      const existing = currentAppsById.get(template.id);
      if (existing) {
        return existing;
      }

      changed = true;
      return createThreadAppState(template, thread.createdBy, thread.createdAt);
    });
    const customApps = normalizedApps.filter((app) => !defaultTemplateIds.has(app.id));
    const mergedApps = [...nextApps, ...customApps];

    if (
      normalizedApps.length !== mergedApps.length ||
      normalizedApps.some((app, index) => mergedApps[index] !== app)
    ) {
      changed = true;
    }

    state.appsByThread.set(thread.id, mergedApps);
  }

  for (const threadId of [...state.appsByThread.keys()]) {
    if (!state.threads.has(threadId)) {
      state.appsByThread.delete(threadId);
      changed = true;
    }
  }

  return changed;
}

function createThreadAppState(
  template: (typeof defaultThreadAppTemplates)[number],
  actorId: string,
  updatedAt = new Date().toISOString()
): ThreadAppState {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    savedSource: template.source,
    document: encodeThreadAppDocument(createThreadAppDocument(template.value)),
    updatedAt,
    updatedBy: actorId
  };
}

function normalizeThreadAppState(app: ThreadAppState): ThreadAppState {
  return {
    ...app,
    description: typeof app.description === "string" ? app.description : ""
  };
}

function createThreadAppDocument(
  value: AppJsonValue
): Automerge.Doc<ThreadAppDocument> {
  return Automerge.from<ThreadAppDocument>({
    value: cloneAppJsonValue(value)
  });
}

function encodeThreadAppDocument(document: Automerge.Doc<ThreadAppDocument>): string {
  return Buffer.from(Automerge.save(document)).toString("base64");
}

function decodeThreadAppDocument(encoded: string): Automerge.Doc<ThreadAppDocument> {
  return Automerge.load<ThreadAppDocument>(
    Uint8Array.from(Buffer.from(encoded, "base64"))
  );
}

function updateThreadAppDocument(
  document: Automerge.Doc<ThreadAppDocument>,
  path: AppPathSegment[],
  nextValue: AppJsonValue
): Automerge.Doc<ThreadAppDocument> {
  return Automerge.change(document, (draft) => {
    if (path.length === 0) {
      draft.value = cloneAppJsonValue(nextValue);
      return;
    }

    let target: unknown = draft.value;

    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index]!;
      const nextSegment = path[index + 1]!;

      if (typeof segment === "number") {
        if (!Array.isArray(target) || segment < 0) {
          throw new Error("Invalid app field path.");
        }

        if (
          target[segment] === undefined ||
          (!Array.isArray(target[segment]) && !isRecord(target[segment]))
        ) {
          target[segment] = typeof nextSegment === "number" ? [] : {};
        }

        target = target[segment];
        continue;
      }

      if (!isRecord(target)) {
        throw new Error("Invalid app field path.");
      }

      if (
        !(segment in target) ||
        (!Array.isArray(target[segment]) && !isRecord(target[segment]))
      ) {
        target[segment] = typeof nextSegment === "number" ? [] : {};
      }

      target = target[segment];
    }

    const lastSegment = path[path.length - 1]!;

    if (typeof lastSegment === "number") {
      if (!Array.isArray(target) || lastSegment < 0) {
        throw new Error("Invalid app field path.");
      }

      target[lastSegment] = cloneAppJsonValue(nextValue);
      return;
    }

    if (!isRecord(target)) {
      throw new Error("Invalid app field path.");
    }

    target[lastSegment] = cloneAppJsonValue(nextValue);
  });
}

function cloneAppJsonValue(value: AppJsonValue): AppJsonValue {
  return JSON.parse(JSON.stringify(value)) as AppJsonValue;
}

function addFriendship(leftId: string, rightId: string): void {
  if (leftId === rightId) {
    return;
  }

  if (!state.friendships.has(leftId)) {
    state.friendships.set(leftId, new Set());
  }
  if (!state.friendships.has(rightId)) {
    state.friendships.set(rightId, new Set());
  }

  state.friendships.get(leftId)?.add(rightId);
  state.friendships.get(rightId)?.add(leftId);
}

function removeFriendship(leftId: string, rightId: string): void {
  state.friendships.get(leftId)?.delete(rightId);
  state.friendships.get(rightId)?.delete(leftId);
}

function broadcastSnapshots(): void {
  for (const [clientId, client] of clients.entries()) {
    try {
      sendSnapshot(client.agentId, client.response);
    } catch {
      clearInterval(client.heartbeat);
      clients.delete(clientId);
      client.response.end();
    }
  }
}

function buildSnapshot(agentId: string): ClientSnapshot {
  const visibleThreads = sortByUpdatedAtDescending(
    [...state.threads.values()].filter((thread) =>
      thread.participantIds.includes(agentId)
    )
  );

  const appsByThread: Record<string, ThreadAppState[]> = {};
  const messages: Record<string, ChatMessage[]> = {};
  for (const thread of visibleThreads) {
    appsByThread[thread.id] = [...(state.appsByThread.get(thread.id) ?? [])];
    messages[thread.id] = [...(state.messagesByThread.get(thread.id) ?? [])].sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  }

  return {
    self: state.users.get(agentId) ?? null,
    users: [...state.users.values()].sort((left, right) =>
      left.username.localeCompare(right.username)
    ),
    friendIds: [...(state.friendships.get(agentId) ?? new Set())].sort(),
    threads: visibleThreads,
    appsByThread,
    messagesByThread: messages,
    serverTime: new Date().toISOString()
  };
}

function sendSnapshot(agentId: string, response: Response): void {
  sendEvent(response, "snapshot", buildSnapshot(agentId));
}

function sendEvent(response: Response, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function startServer(): Promise<void> {
  await loadPersistedState();

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(env.port, () => {
      resolve(nextServer);
    });
  });

  console.log(`social-platform server listening on http://localhost:${env.port}`);
  console.log(`Persisting state to ${env.stateFile}`);
  if (!aiConfigured) {
    console.log("OpenAI is not configured. AI search and summaries are disabled.");
  }

  registerShutdown(server);
}

async function loadPersistedState(): Promise<void> {
  const persistedState = await loadStateFromDisk(env.stateFile);
  replaceState(persistedState);
  if (ensureAllThreadApps()) {
    await saveStateToDisk(env.stateFile, state);
  }

  console.log(
    `Loaded persisted state: ${state.users.size} users, ${state.threads.size} threads, ${state.messageEmbeddings.size} message embeddings, ${state.commandEmbeddings.size} command embeddings`
  );
}

function replaceState(nextState: StoreState): void {
  state.users = nextState.users;
  state.friendships = nextState.friendships;
  state.threads = nextState.threads;
  state.appsByThread = nextState.appsByThread;
  state.messagesByThread = nextState.messagesByThread;
  state.messageEmbeddings = nextState.messageEmbeddings;
  state.commandEmbeddings = nextState.commandEmbeddings;
}

function schedulePersist(): void {
  persistQueued = true;

  if (persistWriting) {
    return;
  }

  persistPromise = flushPersistedState();
  void persistPromise.catch((error) => {
    console.error(`Unable to persist state to ${env.stateFile}.`, error);
  });
}

async function flushPersistedState(): Promise<void> {
  if (persistWriting) {
    await persistPromise;
    return;
  }

  persistWriting = true;

  try {
    while (persistQueued) {
      persistQueued = false;
      await saveStateToDisk(env.stateFile, state);
    }
  } catch (error) {
    persistQueued = true;
    throw error;
  } finally {
    persistWriting = false;
  }
}

async function flushPersistedStateNow(): Promise<void> {
  persistQueued = true;

  if (!persistWriting) {
    persistPromise = flushPersistedState();
  }

  await persistPromise;
}

function registerShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}. Flushing persisted state...`);

    void flushPersistedStateNow()
      .catch((error) => {
        console.error("Unable to flush persisted state during shutdown.", error);
      })
      .finally(() => {
        server.close(() => {
          process.exit(0);
        });
      });
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

async function scheduleThreadRefresh(
  threadId: string,
  messageId: string,
  authorId: string
): Promise<void> {
  await enqueueSerial(threadWorkQueues, threadId, async () => {
    await ensureMessageEmbedding(messageId);
    await maybeRefreshThreadSummary(threadId);
    await enqueueSerial(userWorkQueues, authorId, async () => {
      await maybeRefreshUserSummary(authorId);
    });
  });
}

async function maybeRefreshThreadSummary(threadId: string): Promise<void> {
  const thread = state.threads.get(threadId);
  const messages = state.messagesByThread.get(threadId) ?? [];

  if (!thread || !messages.length || !isAiAvailable()) {
    return;
  }

  const currentSummary = thread.summary;
  const lastMessageCount = currentSummary?.messageCount ?? 0;

  if (currentSummary && messages.length - lastMessageCount < env.threadSummaryInterval) {
    return;
  }

  await refreshThreadSummary(threadId, false);
}

async function maybeRefreshUserSummary(userId: string): Promise<void> {
  const user = state.users.get(userId);

  if (!user || !isAiAvailable()) {
    return;
  }

  const authoredMessages = getMessagesForUser(userId);
  if (!authoredMessages.length) {
    return;
  }

  const lastMessageCount = user.profileSummary?.messageCount ?? 0;
  if (
    user.profileSummary &&
    authoredMessages.length - lastMessageCount < env.profileSummaryInterval
  ) {
    return;
  }

  await refreshUserSummary(userId, false);
}

async function refreshThreadSummary(
  threadId: string,
  force: boolean,
  maxParagraphs = 2
): Promise<AiSummary | null> {
  const thread = state.threads.get(threadId);
  const messages = state.messagesByThread.get(threadId) ?? [];

  if (!thread || !messages.length) {
    return null;
  }
  if (!isAiAvailable()) {
    throw new Error("OpenAI is not configured on the server.");
  }
  if (
    !force &&
    thread.summary &&
    messages.length - thread.summary.messageCount < env.threadSummaryInterval
  ) {
    return thread.summary;
  }

  const currentSummary = thread.summary;
  const pendingSummary: AiSummary = {
    content: currentSummary?.content ?? "",
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
    status: "processing",
    model: currentSummary?.model,
    lastError: undefined
  };

  state.threads.set(thread.id, {
    ...thread,
    summary: pendingSummary
  });
  schedulePersist();
  broadcastSnapshots();

  try {
    const summaryMessages = buildThreadContextMessages(threadId).slice(
      -env.summaryRecentMessageLimit
    );
    const result = await generateThreadSummary({
      threadLabel: getThreadLabel(thread, thread.createdBy),
      existingSummary: currentSummary?.content ?? null,
      messages: summaryMessages,
      maxParagraphs
    });
    const nextSummary: AiSummary = {
      content: result.text,
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      status: "ready",
      model: result.model
    };

    state.threads.set(thread.id, {
      ...thread,
      summary: nextSummary
    });
    schedulePersist();
    broadcastSnapshots();
    return nextSummary;
  } catch (error) {
    const failedSummary: AiSummary = {
      content: currentSummary?.content ?? "",
      updatedAt: new Date().toISOString(),
      messageCount: currentSummary?.messageCount ?? 0,
      status: "error",
      model: currentSummary?.model,
      lastError: error instanceof Error ? error.message : "Unable to summarize"
    };

    state.threads.set(thread.id, {
      ...thread,
      summary: failedSummary
    });
    schedulePersist();
    broadcastSnapshots();
    throw error;
  }
}

async function refreshUserSummary(
  userId: string,
  force: boolean,
  maxParagraphs = 2
): Promise<AiSummary | null> {
  const user = state.users.get(userId);

  if (!user) {
    return null;
  }
  if (!isAiAvailable()) {
    throw new Error("OpenAI is not configured on the server.");
  }

  const authoredMessages = getMessagesForUser(userId);
  if (!authoredMessages.length) {
    return null;
  }
  if (
    !force &&
    user.profileSummary &&
    authoredMessages.length - user.profileSummary.messageCount <
      env.profileSummaryInterval
  ) {
    return user.profileSummary;
  }

  const currentSummary = user.profileSummary;
  const pendingSummary: AiSummary = {
    content: currentSummary?.content ?? "",
    updatedAt: new Date().toISOString(),
    messageCount: authoredMessages.length,
    status: "processing",
    model: currentSummary?.model,
    lastError: undefined
  };

  state.users.set(user.id, {
    ...user,
    profileSummary: pendingSummary
  });
  schedulePersist();
  broadcastSnapshots();

  try {
    const summaryMessages = authoredMessages.slice(-env.summaryRecentMessageLimit);
    const result = await generateProfileSummary({
      username: user.username,
      existingSummary: currentSummary?.content ?? null,
      messages: summaryMessages,
      maxParagraphs
    });
    const nextSummary: AiSummary = {
      content: result.text,
      updatedAt: new Date().toISOString(),
      messageCount: authoredMessages.length,
      status: "ready",
      model: result.model
    };

    state.users.set(user.id, {
      ...user,
      profileSummary: nextSummary
    });
    schedulePersist();
    broadcastSnapshots();
    return nextSummary;
  } catch (error) {
    const failedSummary: AiSummary = {
      content: currentSummary?.content ?? "",
      updatedAt: new Date().toISOString(),
      messageCount: currentSummary?.messageCount ?? 0,
      status: "error",
      model: currentSummary?.model,
      lastError:
        error instanceof Error ? error.message : "Unable to summarize profile"
    };

    state.users.set(user.id, {
      ...user,
      profileSummary: failedSummary
    });
    schedulePersist();
    broadcastSnapshots();
    throw error;
  }
}

async function searchThreadMessages(
  params: SearchParams
): Promise<ThreadSearchResponse> {
  const thread = getThreadForAgent(params.threadId, params.agentId);
  const messages = state.messagesByThread.get(thread.id) ?? [];
  const query = params.query.trim();

  if (!query) {
    return {
      query: params.query,
      limit: params.limit,
      generatedAt: new Date().toISOString(),
      results: []
    };
  }

  await ensureThreadEmbeddings(thread.id);
  const queryEmbedding = await getQueryEmbedding(query);
  const results = messages
    .map((message) => {
      const text = extractMessageText(message).trim();
      if (!text) {
        return null;
      }

      const direct = scoreDirectTextMatch(query, text);
      const messageEmbedding = state.messageEmbeddings.get(message.id)?.embedding ?? null;
      const cosine = cosineSimilarity(queryEmbedding, messageEmbedding);
      const semanticScore = cosine !== null ? Math.max(0, cosine) * 100 : null;
      const reasons = [...direct.reasons];

      if (semanticScore !== null && semanticScore >= 28) {
        reasons.push("semantic");
      }

      if (direct.directScore <= 0 && (semanticScore ?? 0) < 28) {
        return null;
      }

      const author = state.users.get(message.agentId);
      return {
        messageId: message.id,
        threadId: message.threadId,
        agentId: message.agentId,
        authorName: author?.username ?? message.agentId,
        createdAt: message.createdAt,
        text,
        snippet: buildSnippet(text, query),
        exactMatch: direct.exactMatch,
        partialMatchCount: direct.partialMatchCount,
        semanticScore,
        directScore: direct.directScore,
        score:
          direct.directScore * 10 +
          (semanticScore ?? 0) +
          new Date(message.createdAt).getTime() / 1_000_000_000_000,
        reasons
      };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((left, right) => {
      if (right.exactMatch !== left.exactMatch) {
        return Number(right.exactMatch) - Number(left.exactMatch);
      }
      if (right.directScore !== left.directScore) {
        return right.directScore - left.directScore;
      }
      if ((right.semanticScore ?? -1) !== (left.semanticScore ?? -1)) {
        return (right.semanticScore ?? -1) - (left.semanticScore ?? -1);
      }

      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })
    .slice(0, params.limit);

  return {
    query: params.query,
    limit: params.limit,
    generatedAt: new Date().toISOString(),
    results
  };
}

async function buildAiAnswerContext(
  thread: ChatThread,
  agentId: string,
  prompt: string
): Promise<AiContextMessage[]> {
  const searchResults = await searchThreadMessages({
    agentId,
    threadId: thread.id,
    query: prompt,
    limit: Math.max(6, Math.floor(env.aiContextMessageLimit / 2))
  });
  const recentMessages = buildThreadContextMessages(thread.id).slice(
    -env.aiContextMessageLimit
  );
  const mergedMessages = new Map<string, AiContextMessage>();

  for (const result of searchResults.results) {
    const message = (state.messagesByThread.get(thread.id) ?? []).find(
      (entry) => entry.id === result.messageId
    );
    if (!message) {
      continue;
    }

    mergedMessages.set(message.id, toContextMessage(message));
  }

  for (const message of recentMessages) {
    mergedMessages.set(message.messageId, message);
  }

  return [...mergedMessages.values()]
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
    .slice(-env.aiContextMessageLimit);
}

function buildParticipantContext(thread: ChatThread): AiParticipantContext[] {
  return thread.participantIds.map((participantId) => {
    const user = state.users.get(participantId);

    return {
      userId: participantId,
      username: user?.username ?? participantId,
      summary: user?.profileSummary ?? null
    };
  });
}

function buildThreadContextMessages(threadId: string): AiContextMessage[] {
  return (state.messagesByThread.get(threadId) ?? []).map((message) =>
    toContextMessage(message)
  );
}

function getMessagesForUser(userId: string): AiContextMessage[] {
  const messages: AiContextMessage[] = [];

  for (const threadMessages of state.messagesByThread.values()) {
    for (const message of threadMessages) {
      if (message.agentId === userId) {
        messages.push(toContextMessage(message));
      }
    }
  }

  return messages.sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
}

function toContextMessage(message: ChatMessage): AiContextMessage {
  return {
    messageId: message.id,
    threadId: message.threadId,
    agentId: message.agentId,
    authorName: state.users.get(message.agentId)?.username ?? message.agentId,
    createdAt: message.createdAt,
    text: extractMessageText(message)
  };
}

async function ensureThreadEmbeddings(threadId: string): Promise<void> {
  if (!isAiAvailable()) {
    return;
  }

  const threadMessages = state.messagesByThread.get(threadId) ?? [];
  const missingMessages = threadMessages.filter(
    (message) =>
      !state.messageEmbeddings.has(message.id) &&
      extractMessageText(message).trim().length > 0
  );

  if (!missingMessages.length) {
    return;
  }

  for (let index = 0; index < missingMessages.length; index += 24) {
    const batch = missingMessages.slice(index, index + 24);
    const inputs = batch.map((message) => extractMessageText(message));
    const embedded = await embedTexts(inputs);

    if (!embedded) {
      return;
    }

    const timestamp = new Date().toISOString();
    batch.forEach((message, batchIndex) => {
      const vector = embedded.embeddings[batchIndex];

      if (!vector) {
        return;
      }

      state.messageEmbeddings.set(message.id, {
        input: inputs[batchIndex] ?? "",
        embedding: vector,
        model: embedded.model,
        createdAt: timestamp
      });
    });

    schedulePersist();
  }
}

async function ensureMessageEmbedding(messageId: string): Promise<void> {
  if (!isAiAvailable() || state.messageEmbeddings.has(messageId)) {
    return;
  }

  const message = findMessageById(messageId);
  if (!message) {
    return;
  }

  const text = extractMessageText(message).trim();
  if (!text) {
    return;
  }

  const embedded = await embedText(text);
  if (!embedded) {
    return;
  }

  state.messageEmbeddings.set(message.id, {
    input: text,
    embedding: embedded.embedding,
    model: embedded.model,
    createdAt: new Date().toISOString()
  });
  schedulePersist();
}

function findMessageById(messageId: string): ChatMessage | null {
  for (const threadMessages of state.messagesByThread.values()) {
    const message = threadMessages.find((entry) => entry.id === messageId);
    if (message) {
      return message;
    }
  }

  return null;
}

async function getQueryEmbedding(query: string): Promise<number[] | null> {
  if (!isAiAvailable()) {
    return null;
  }

  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return null;
  }

  const cached = queryEmbeddingCache.get(normalized);
  if (cached) {
    return cached;
  }

  const embedded = await embedText(normalized);
  if (!embedded) {
    return null;
  }

  queryEmbeddingCache.set(normalized, embedded.embedding);
  return embedded.embedding;
}

async function recommendCommands(
  query: string,
  limit: number
): Promise<CommandRecommendationResponse> {
  await ensureCommandEmbeddings();
  const queryEmbedding = await getQueryEmbedding(query);

  const results = commandDefinitions
    .map((command) => {
      const direct = scoreDirectTextMatch(query, buildCommandDocument(command));
      const semantic = cosineSimilarity(
        queryEmbedding,
        state.commandEmbeddings.get(command.id)?.embedding ?? null
      );
      const semanticScore = semantic !== null ? Math.max(0, semantic) * 100 : null;
      const reasons = [...direct.reasons];

      if (semanticScore !== null && semanticScore >= 20) {
        reasons.push("semantic");
      }

      if (direct.directScore <= 0 && (semanticScore ?? 0) < 20) {
        return null;
      }

      return {
        command,
        score: direct.directScore * 10 + (semanticScore ?? 0),
        directScore: direct.directScore,
        semanticScore,
        reasons
      } satisfies CommandRecommendation;
    })
    .filter((result): result is CommandRecommendation => result !== null)
    .sort((left, right) => {
      if (right.directScore !== left.directScore) {
        return right.directScore - left.directScore;
      }

      return (right.semanticScore ?? -1) - (left.semanticScore ?? -1);
    })
    .slice(0, limit);

  return {
    query,
    limit,
    generatedAt: new Date().toISOString(),
    results
  };
}

async function ensureCommandEmbeddings(): Promise<void> {
  if (!isAiAvailable()) {
    return;
  }
  if (commandEmbeddingPromise) {
    await commandEmbeddingPromise;
    return;
  }

  const missingCommands = commandDefinitions.filter(
    (command) => !state.commandEmbeddings.has(command.id)
  );

  if (!missingCommands.length) {
    return;
  }

  commandEmbeddingPromise = (async () => {
    const inputs = missingCommands.map((command) => buildCommandDocument(command));
    const embedded = await embedTexts(inputs);

    if (!embedded) {
      return;
    }

    const timestamp = new Date().toISOString();
    missingCommands.forEach((command, index) => {
      const embedding = embedded.embeddings[index];
      if (!embedding) {
        return;
      }

      const document = inputs[index];
      if (!document) {
        return;
      }

      state.commandEmbeddings.set(command.id, {
        input: document,
        embedding,
        model: embedded.model,
        createdAt: timestamp
      });
    });

    schedulePersist();
  })()
    .catch((error) => {
      console.error("Unable to embed command directory.", error);
    })
    .finally(() => {
      commandEmbeddingPromise = null;
    });

  await commandEmbeddingPromise;
}

function getThreadLabel(thread: ChatThread, selfId: string): string {
  const trimmedTitle = thread.title.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  const otherParticipants = thread.participantIds.filter(
    (participantId) => participantId !== selfId
  );
  const labelParticipants = otherParticipants.length
    ? otherParticipants
    : thread.participantIds;

  return labelParticipants
    .map((participantId) => state.users.get(participantId)?.username ?? participantId)
    .join(", ");
}

function extractSummaryContext(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.text === "string" && value.text.trim()) {
    return value.text.trim();
  }

  if (typeof value.context === "string" && value.context.trim()) {
    return value.context.trim();
  }

  if (
    Array.isArray(value.context) &&
    value.context.every((entry) => typeof entry === "string")
  ) {
    return value.context.join("\n").trim() || null;
  }

  return null;
}

function asRequiredString(value: unknown, _message: string): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

async function enqueueSerial(
  queue: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<void>
): Promise<void> {
  const previousTask = queue.get(key) ?? Promise.resolve();
  const nextTask = previousTask
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      console.error(`Background task failed for ${key}.`, error);
    })
    .finally(() => {
      if (queue.get(key) === nextTask) {
        queue.delete(key);
      }
    });

  queue.set(key, nextTask);
  await nextTask;
}
