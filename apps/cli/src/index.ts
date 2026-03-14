#!/usr/bin/env node

import * as Automerge from "@automerge/automerge";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

import {
  type AppJsonValue,
  type AppPathSegment,
  type ThreadAppState,
  extractMessageText,
  createRandomUsername,
  type AgentKind,
  type AiTextResponse,
  type ChatCommand,
  type ChatMessage,
  type ChatThread,
  type ClientSnapshot,
  type CommandDirectoryResponse,
  type CommandRecommendationResponse,
  type MessageReaction,
  type ThreadSearchResponse,
  type UserProfile,
  isAppJsonValue,
  looksLikeJsonRenderSpec,
  validateJsonRenderSpecShape
} from "@social/shared";

interface Identity {
  id: string;
  username: string;
  kind: AgentKind;
}

interface Session {
  identity: Identity;
  snapshot: ClientSnapshot;
}

interface EnrichedUser extends UserProfile {
  isSelf: boolean;
  isFriend: boolean;
}

interface WatchOptions {
  focusThreadId?: string;
  json: boolean;
}

interface CliThreadAppDocument {
  value: AppJsonValue;
}

type ParsedFlags = Record<string, string | boolean>;

const DEFAULT_APP_SOURCE = "{}";

const args = process.argv.slice(2);
const { positionals, flags } = parseArgs(args);
const command = positionals[0] ?? "help";
const serverUrl = String(
  flags.server ?? process.env.SOCIAL_SERVER_URL ?? "http://localhost:4000"
);
const configPath = join(homedir(), ".social-platform-cli.json");
const jsonOutput = hasFlag(flags, "json");

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function run() {
  switch (command) {
    case "help": {
      printHelp();
      return;
    }
    case "whoami": {
      const session = await getSession(flags);
      if (jsonOutput) {
        printJson({
          identity: session.identity,
          snapshot: session.snapshot
        });
        return;
      }

      printIdentity(session.identity, session.snapshot);
      return;
    }
    case "snapshot": {
      const session = await getSession(flags);
      printJson(session.snapshot);
      return;
    }
    case "users": {
      await handleUsersCommand(positionals[1], flags);
      return;
    }
    case "friends": {
      await handleFriendsCommand(positionals[1], flags);
      return;
    }
    case "threads": {
      await handleThreadsCommand(positionals[1], flags);
      return;
    }
    case "message": {
      await handleMessageCommand(positionals[1], flags);
      return;
    }
    case "apps": {
      await handleAppsCommand(positionals[1], flags);
      return;
    }
    case "react": {
      const session = await getSession(flags);
      const threadId = requireString(flags.thread, "--thread is required.");
      const messageId = requireString(flags.message, "--message is required.");
      const emoji = requireString(flags.emoji, "--emoji is required.");

      const response = await sendCommand(serverUrl, {
        command: "message.react.toggle",
        threadId,
        messageId,
        emoji,
        agentId: session.identity.id
      });

      if (jsonOutput) {
        printJson(response.snapshot);
        return;
      }

      console.log(`Reaction updated on ${messageId}.`);
      return;
    }
    case "watch": {
      const session = await getSession(flags);
      const focusThreadId = asOptionalString(flags.thread);
      await watchSnapshots(session.identity, serverUrl, {
        focusThreadId,
        json: jsonOutput
      });
      return;
    }
    case "search": {
      await handleSearchCommand(positionals[1], flags);
      return;
    }
    case "ai": {
      await handleAiCommand(positionals[1], flags);
      return;
    }
    default: {
      printHelp();
      process.exitCode = 1;
    }
  }
}

async function handleUsersCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  const session = await getSession(commandFlags);

  if (subcommand === "list") {
    const users = buildUsersView(session.snapshot, session.identity.id);
    if (jsonOutput) {
      printJson(users);
      return;
    }

    printUsers(users);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function handleFriendsCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  const session = await getSession(commandFlags);

  if (subcommand === "list") {
    const friends = buildUsersView(session.snapshot, session.identity.id).filter(
      (user) => user.isFriend
    );

    if (jsonOutput) {
      printJson(friends);
      return;
    }

    printFriends(friends);
    return;
  }

  if (subcommand === "add") {
    const friendId = requireString(commandFlags.friend, "--friend is required.");
    const response = await sendCommand(serverUrl, {
      command: "friend.add",
      agentId: session.identity.id,
      friendId
    });

    if (jsonOutput) {
      printJson(response.snapshot);
      return;
    }

    console.log(`Added friend ${friendId}.`);
    return;
  }

  if (subcommand === "remove") {
    const friendId = requireString(commandFlags.friend, "--friend is required.");
    const response = await sendCommand(serverUrl, {
      command: "friend.remove",
      agentId: session.identity.id,
      friendId
    });

    if (jsonOutput) {
      printJson(response.snapshot);
      return;
    }

    console.log(`Removed friend ${friendId}.`);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function handleThreadsCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  const session = await getSession(commandFlags);

  if (subcommand === "list") {
    if (jsonOutput) {
      printJson(
        session.snapshot.threads.map((thread) =>
          buildThreadView(session.snapshot, thread, session.identity.id)
        )
      );
      return;
    }

    printThreads(session.snapshot, session.identity.id);
    return;
  }

  if (subcommand === "show") {
    const threadId = requireString(commandFlags.thread, "--thread is required.");
    const thread = getThreadOrThrow(session.snapshot, threadId);
    const threadView = buildThreadView(
      session.snapshot,
      thread,
      session.identity.id
    );

    if (jsonOutput) {
      printJson(threadView);
      return;
    }

    printThreadDetail(threadView);
    return;
  }

  if (subcommand === "create") {
    const previousThreadIds = new Set(
      session.snapshot.threads.map((thread) => thread.id)
    );
    const response = await sendCommand(serverUrl, {
      command: "thread.create",
      agentId: session.identity.id,
      title: asOptionalString(commandFlags.title) ?? "",
      participantIds: parseCsv(commandFlags.participants)
    });
    const snapshot = requireSnapshot(response);
    const createdThread =
      snapshot.threads.find((thread) => !previousThreadIds.has(thread.id)) ??
      snapshot.threads[0];

    if (jsonOutput) {
      printJson(
        createdThread
          ? buildThreadView(snapshot, createdThread, session.identity.id)
          : snapshot
      );
      return;
    }

    if (createdThread) {
      console.log(
        `Thread created: ${getThreadLabel(
          createdThread,
          snapshot,
          session.identity.id
        )} (${createdThread.id})`
      );
      return;
    }

    console.log("Thread created.");
    return;
  }

  if (subcommand === "delete") {
    const threadId = requireString(commandFlags.thread, "--thread is required.");
    const response = await sendCommand(serverUrl, {
      command: "thread.delete",
      agentId: session.identity.id,
      threadId
    });

    if (jsonOutput) {
      printJson(response.snapshot);
      return;
    }

    console.log(`Deleted thread ${threadId}.`);
    return;
  }

  if (subcommand === "participants") {
    const action = positionals[2];
    const threadId = requireString(commandFlags.thread, "--thread is required.");
    const participantIds = parseCsv(commandFlags.participants);

    if (participantIds.length === 0) {
      throw new Error("--participants must contain at least one agent id.");
    }

    if (action === "add") {
      const response = await sendCommand(serverUrl, {
        command: "thread.participants.add",
        agentId: session.identity.id,
        threadId,
        participantIds
      });

      if (jsonOutput) {
        printJson(response.snapshot);
        return;
      }

      console.log(`Added participants to ${threadId}: ${participantIds.join(", ")}`);
      return;
    }

    if (action === "remove") {
      const response = await sendCommand(serverUrl, {
        command: "thread.participants.remove",
        agentId: session.identity.id,
        threadId,
        participantIds
      });

      if (jsonOutput) {
        printJson(response.snapshot);
        return;
      }

      console.log(
        `Removed participants from ${threadId}: ${participantIds.join(", ")}`
      );
      return;
    }
  }

  printHelp();
  process.exitCode = 1;
}

async function handleMessageCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  const session = await getSession(commandFlags);

  if (subcommand === "list") {
    const threadId = requireString(commandFlags.thread, "--thread is required.");
    const thread = getThreadOrThrow(session.snapshot, threadId);
    const threadView = buildThreadView(
      session.snapshot,
      thread,
      session.identity.id
    );

    if (jsonOutput) {
      printJson(threadView.messages);
      return;
    }

    printMessages(threadView.messages);
    return;
  }

  const threadId = requireString(commandFlags.thread, "--thread is required.");

  if (subcommand === "text") {
    const text = requireString(commandFlags.text, "--text is required.");
    const response = await sendCommand(serverUrl, {
      command: "message.send",
      threadId,
      agentId: session.identity.id,
      agentKind: session.identity.kind,
      type: "chat.text",
      message: { text }
    });

    if (jsonOutput) {
      printJson(response.snapshot);
      return;
    }

    console.log("Message sent.");
    return;
  }

  if (subcommand === "send") {
    const type = requireString(commandFlags.type, "--type is required.");
    const rawJson = requireString(
      typeof commandFlags.jsonPayload === "string"
        ? commandFlags.jsonPayload
        : typeof commandFlags.json === "string"
          ? commandFlags.json
          : undefined,
      "--json-payload is required."
    );
    const payload = JSON.parse(rawJson) as unknown;

    if (!isObject(payload)) {
      throw new Error("--json-payload must describe a JSON object.");
    }

    const response = await sendCommand(serverUrl, {
      command: "message.send",
      threadId,
      agentId: session.identity.id,
      agentKind: session.identity.kind,
      type,
      message: payload
    });

    if (jsonOutput) {
      printJson(response.snapshot);
      return;
    }

    console.log("Message sent.");
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function handleAppsCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  const session = await getSession(commandFlags);
  const threadId =
    subcommand === "list" ||
    subcommand === "show" ||
    subcommand === "create" ||
    subcommand === "delete" ||
    subcommand === "meta" ||
    subcommand === "save" ||
    subcommand === "set" ||
    subcommand === "share" ||
    subcommand === "generate"
      ? requireString(commandFlags.thread, "--thread is required.")
      : null;

  if (subcommand === "list" && threadId) {
    const apps = buildAppsView(session.snapshot, threadId);

    if (jsonOutput) {
      printJson(apps);
      return;
    }

    printApps(apps);
    return;
  }

  if (subcommand === "show" && threadId) {
    const appId = requireString(commandFlags.app, "--app is required.");
    const appView = buildAppViewOrThrow(session.snapshot, threadId, appId);

    if (jsonOutput) {
      printJson(appView);
      return;
    }

    printAppDetail(appView);
    return;
  }

  if (subcommand === "create" && threadId) {
    const source = await resolveAppSource(commandFlags);
    const validatedSource = validateAppSource(source);
    const response = await sendCommand(serverUrl, {
      command: "thread.app.create",
      agentId: session.identity.id,
      threadId,
      name: asOptionalString(commandFlags.name) ?? "Untitled app",
      description: asOptionalString(commandFlags.description) ?? "",
      source: validatedSource.source,
      value: validatedSource.value
    });
    const snapshot = requireSnapshot(response);
    const previousAppIds = new Set(
      (session.snapshot.appsByThread[threadId] ?? []).map((app) => app.id)
    );
    const createdApp =
      (snapshot.appsByThread[threadId] ?? []).find((app) => !previousAppIds.has(app.id)) ??
      null;

    if (jsonOutput) {
      printJson(
        createdApp ? buildAppView(snapshot, threadId, createdApp) : snapshot.appsByThread[threadId] ?? []
      );
      return;
    }

    console.log(
      createdApp
        ? `App created: ${createdApp.name} (${createdApp.id})`
        : `App created in thread ${threadId}.`
    );
    return;
  }

  if (subcommand === "delete" && threadId) {
    const appId = requireString(commandFlags.app, "--app is required.");
    await sendCommand(serverUrl, {
      command: "thread.app.delete",
      agentId: session.identity.id,
      threadId,
      appId
    });

    if (jsonOutput) {
      const refreshedSession = await getSession(commandFlags);
      printJson(refreshedSession.snapshot.appsByThread[threadId] ?? []);
      return;
    }

    console.log(`Deleted app ${appId}.`);
    return;
  }

  if (subcommand === "meta" && threadId) {
    const appId = requireString(commandFlags.app, "--app is required.");
    const currentApp = getThreadAppOrThrow(session.snapshot, threadId, appId);
    const nextName = asOptionalString(commandFlags.name) ?? currentApp.name;
    const nextDescription =
      asOptionalString(commandFlags.description) ?? currentApp.description;

    await sendCommand(serverUrl, {
      command: "thread.app.meta.update",
      agentId: session.identity.id,
      threadId,
      appId,
      name: nextName,
      description: nextDescription
    });

    if (jsonOutput) {
      const refreshedSession = await getSession(commandFlags);
      printJson(buildAppViewOrThrow(refreshedSession.snapshot, threadId, appId));
      return;
    }

    console.log(`Updated app metadata for ${appId}.`);
    return;
  }

  if (subcommand === "save" && threadId) {
    const appId = requireString(commandFlags.app, "--app is required.");
    const source = await resolveAppSource(commandFlags);
    const validatedSource = validateAppSource(source);

    await sendCommand(serverUrl, {
      command: "thread.app.source.save",
      agentId: session.identity.id,
      threadId,
      appId,
      source: validatedSource.source,
      value: validatedSource.value
    });

    if (jsonOutput) {
      const refreshedSession = await getSession(commandFlags);
      printJson(buildAppViewOrThrow(refreshedSession.snapshot, threadId, appId));
      return;
    }

    console.log(`Saved source for app ${appId}.`);
    return;
  }

  if (subcommand === "set" && threadId) {
    const appId = requireString(commandFlags.app, "--app is required.");
    const path = parseAppPath(
      requireString(commandFlags.path, "--path is required.")
    );
    const value = parseAppValueFromFlags(commandFlags);

    await sendCommand(serverUrl, {
      command: "thread.app.form.update",
      agentId: session.identity.id,
      threadId,
      appId,
      path,
      value
    });

    if (jsonOutput) {
      const refreshedSession = await getSession(commandFlags);
      printJson(buildAppViewOrThrow(refreshedSession.snapshot, threadId, appId));
      return;
    }

    console.log(`Updated app value at ${formatAppPath(path)}.`);
    return;
  }

  if (subcommand === "share" && threadId) {
    const appId = requireString(commandFlags.app, "--app is required.");
    const app = getThreadAppOrThrow(session.snapshot, threadId, appId);

    await sendCommand(serverUrl, {
      command: "message.send",
      threadId,
      agentId: session.identity.id,
      agentKind: session.identity.kind,
      type: "chat.app.embed",
      message: {
        appId: app.id,
        appName: app.name
      }
    });

    if (jsonOutput) {
      const refreshedSession = await getSession(commandFlags);
      printJson(buildThreadView(refreshedSession.snapshot, getThreadOrThrow(refreshedSession.snapshot, threadId), refreshedSession.identity.id));
      return;
    }

    console.log(`Shared app ${app.name} (${app.id}) to ${threadId}.`);
    return;
  }

  if (subcommand === "generate" && threadId) {
    const appId = asOptionalString(commandFlags.app);
    const prompt = requireString(commandFlags.prompt, "--prompt is required.");
    const apply = hasFlag(commandFlags, "apply");
    const currentApp = appId ? getThreadAppOrThrow(session.snapshot, threadId, appId) : null;
    const generation = await streamGeneratedAppSource(serverUrl, {
      agentId: session.identity.id,
      threadId,
      name: asOptionalString(commandFlags.name) ?? currentApp?.name,
      description:
        asOptionalString(commandFlags.description) ?? currentApp?.description,
      currentSource: currentApp?.savedSource,
      prompt
    }, {
      streamToStdout: !jsonOutput
    });

    if (apply) {
      const validatedSource = validateAppSource(generation.source);

      if (currentApp) {
        const nextName =
          asOptionalString(commandFlags.name) ?? currentApp.name;
        const nextDescription =
          asOptionalString(commandFlags.description) ?? currentApp.description;

        if (
          nextName !== currentApp.name ||
          nextDescription !== currentApp.description
        ) {
          await sendCommand(serverUrl, {
            command: "thread.app.meta.update",
            agentId: session.identity.id,
            threadId,
            appId: currentApp.id,
            name: nextName,
            description: nextDescription
          });
        }

        await sendCommand(serverUrl, {
          command: "thread.app.source.save",
          agentId: session.identity.id,
          threadId,
          appId: currentApp.id,
          source: validatedSource.source,
          value: validatedSource.value
        });

        if (jsonOutput) {
          const refreshedSession = await getSession(commandFlags);
          printJson({
            app: buildAppViewOrThrow(refreshedSession.snapshot, threadId, currentApp.id),
            generation
          });
          return;
        }

        console.log(`Applied generated source to ${currentApp.name} (${currentApp.id}).`);
        return;
      }

      const createdResponse = await sendCommand(serverUrl, {
        command: "thread.app.create",
        agentId: session.identity.id,
        threadId,
        name: asOptionalString(commandFlags.name) ?? "Untitled app",
        description: asOptionalString(commandFlags.description) ?? "",
        source: validatedSource.source,
        value: validatedSource.value
      });
      const snapshot = requireSnapshot(createdResponse);
      const previousAppIds = new Set(
        (session.snapshot.appsByThread[threadId] ?? []).map((app) => app.id)
      );
      const createdApp =
        (snapshot.appsByThread[threadId] ?? []).find((app) => !previousAppIds.has(app.id)) ??
        null;

      if (jsonOutput) {
        printJson({
          app: createdApp ? buildAppView(snapshot, threadId, createdApp) : null,
          generation
        });
        return;
      }

      console.log(
        createdApp
          ? `Generated and created app ${createdApp.name} (${createdApp.id}).`
          : "Generated source and created a new app."
      );
      return;
    }

    if (jsonOutput) {
      printJson(generation);
      return;
    }

    if (!generation.streamed) {
      console.log(generation.source);
    }
    console.log(`\nGenerated app source with ${generation.model}.`);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function handleSearchCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  if (subcommand !== "chat") {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const session = await getSession(commandFlags);
  const threadId = requireString(commandFlags.thread, "--thread is required.");
  const query = requireString(commandFlags.query, "--query is required.");
  const limit = parsePositiveInteger(commandFlags.limit, 10);
  const result = await searchChat(serverUrl, {
    agentId: session.identity.id,
    threadId,
    query,
    limit
  });

  if (jsonOutput) {
    printJson(result);
    return;
  }

  printSearchResults(result);
}

async function handleAiCommand(
  subcommand: string | undefined,
  commandFlags: ParsedFlags
) {
  if (subcommand === "directory") {
    const directory = await fetchJson<CommandDirectoryResponse>(
      `${serverUrl}/ai/command-directory`
    );

    if (jsonOutput) {
      printJson(directory);
      return;
    }

    printCommandDirectory(directory);
    return;
  }

  if (subcommand === "commands") {
    const query = requireString(commandFlags.query, "--query is required.");
    const limit = parsePositiveInteger(commandFlags.limit, 5);
    const result = await fetchJson<CommandRecommendationResponse>(
      `${serverUrl}/ai/command-recommendations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query,
          limit
        })
      }
    );

    if (jsonOutput) {
      printJson(result);
      return;
    }

    printCommandRecommendations(result);
    return;
  }

  if (subcommand === "summarize") {
    const threadId = asOptionalString(commandFlags.thread);
    const maxParagraphs = parsePositiveInteger(commandFlags.paragraphs, 2);

    if (threadId) {
      const session = await getSession(commandFlags);
      const result = await fetchJson<AiTextResponse>(`${serverUrl}/ai/summarize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          agentId: session.identity.id,
          threadId,
          maxParagraphs
        })
      });

      if (jsonOutput) {
        printJson(result);
        return;
      }

      printAiResponse(result);
      return;
    }

    const text = requireString(
      typeof commandFlags.text === "string"
        ? commandFlags.text
        : typeof commandFlags.context === "string"
          ? commandFlags.context
          : undefined,
      "--text is required when --thread is not provided."
    );
    const result = await fetchJson<AiTextResponse>(`${serverUrl}/ai/summarize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        maxParagraphs
      })
    });

    if (jsonOutput) {
      printJson(result);
      return;
    }

    printAiResponse(result);
    return;
  }

  if (subcommand === "ask") {
    const prompt = requireString(commandFlags.prompt, "--prompt is required.");
    const threadId = asOptionalString(commandFlags.thread);
    const session = threadId ? await getSession(commandFlags) : null;
    const result = await fetchJson<AiTextResponse>(`${serverUrl}/ai/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        threadId,
        agentId: session?.identity.id
      })
    });

    if (jsonOutput) {
      printJson(result);
      return;
    }

    printAiResponse(result);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

async function getSession(commandFlags: ParsedFlags): Promise<Session> {
  const identity = await loadIdentity({
    username: asOptionalString(commandFlags.name),
    kind: asAgentKind(commandFlags.kind)
  });
  const snapshot = await syncProfile(identity, serverUrl);

  return {
    identity,
    snapshot
  };
}

async function loadIdentity(overrides: Partial<Identity>): Promise<Identity> {
  const existing = await readIdentity();
  if (existing) {
    const nextIdentity = {
      ...existing,
      ...cleanObject(overrides)
    };
    await writeIdentity(nextIdentity);
    return nextIdentity;
  }

  const nextIdentity: Identity = {
    id: randomUUID(),
    username: overrides.username ?? createRandomUsername(),
    kind: overrides.kind ?? "user"
  };
  await writeIdentity(nextIdentity);
  return nextIdentity;
}

async function readIdentity(): Promise<Identity | null> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<Identity>;
    if (
      parsed.id &&
      parsed.username &&
      (parsed.kind === "user" || parsed.kind === "ai")
    ) {
      return parsed as Identity;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeIdentity(identity: Identity) {
  await writeFile(configPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

async function syncProfile(identity: Identity, baseUrl: string): Promise<ClientSnapshot> {
  const response = await sendCommand(baseUrl, {
    command: "profile.upsert",
    profile: identity
  });

  return requireSnapshot(response);
}

async function sendCommand(
  baseUrl: string,
  commandPayload: ChatCommand
): Promise<{ ok: boolean; snapshot: ClientSnapshot | null }> {
  const response = await fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commandPayload)
  });

  const payload = (await response.json()) as
    | { ok: boolean; snapshot: ClientSnapshot | null; error?: string }
    | { error: string };

  if (!response.ok || ("error" in payload && payload.error)) {
    throw new Error("error" in payload ? payload.error : "Command failed.");
  }

  return {
    ok: Boolean("ok" in payload ? payload.ok : false),
    snapshot: "snapshot" in payload ? payload.snapshot : null
  };
}

async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
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

async function streamGeneratedAppSource(
  baseUrl: string,
  params: {
    agentId: string;
    threadId: string;
    prompt: string;
    name?: string;
    description?: string;
    currentSource?: string;
  },
  options: {
    streamToStdout: boolean;
  }
): Promise<{
  generatedAt: string;
  model: string;
  prompt: string;
  source: string;
  streamed: boolean;
  threadId: string | null;
}> {
  type StreamedAppSourcePayload = {
    generatedAt: string;
    model: string;
    prompt: string;
    source: string;
    threadId: string | null;
  };

  const response = await fetch(`${baseUrl}/ai/app-source/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
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
  let streamed = false;
  let finalPayload: StreamedAppSourcePayload | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex < 0) {
        break;
      }

      const rawFrame = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const event = parseSseFrame(rawFrame);
      if (!event.event || !event.data) {
        continue;
      }

      if (event.event === "delta") {
        const payload = JSON.parse(event.data) as { delta?: string };
        if (payload.delta) {
          streamed = true;
          if (options.streamToStdout) {
            process.stdout.write(payload.delta);
          }
        }
        continue;
      }

      if (event.event === "done") {
        finalPayload = JSON.parse(event.data) as StreamedAppSourcePayload;
        continue;
      }

      if (event.event === "error") {
        const payload = JSON.parse(event.data) as { error?: string };
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

  return {
    ...finalPayload,
    streamed
  };
}

async function searchChat(
  baseUrl: string,
  params: {
    agentId: string;
    threadId: string;
    query: string;
    limit: number;
  }
): Promise<ThreadSearchResponse> {
  const searchParams = new URLSearchParams({
    agentId: params.agentId,
    query: params.query,
    limit: String(params.limit)
  });

  return fetchJson<ThreadSearchResponse>(
    `${baseUrl}/threads/${encodeURIComponent(params.threadId)}/search?${searchParams.toString()}`
  );
}

async function watchSnapshots(
  identity: Identity,
  baseUrl: string,
  options: WatchOptions
): Promise<void> {
  if (!options.json) {
    console.log(`Watching ${baseUrl}/events as ${identity.username} (${identity.id})`);
  }

  const response = await fetch(
    `${baseUrl}/events?agentId=${encodeURIComponent(identity.id)}`,
    {
      headers: {
        Accept: "text/event-stream"
      }
    }
  );

  if (!response.ok || !response.body) {
    throw new Error("Unable to connect to event stream.");
  }

  let previousSnapshot: ClientSnapshot | null = null;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (event.event !== "snapshot" || !event.data) {
        continue;
      }

      const snapshot = JSON.parse(event.data) as ClientSnapshot;
      if (options.json) {
        console.log(JSON.stringify(snapshot));
      } else {
        printSnapshotDiff(previousSnapshot, snapshot, identity.id, options.focusThreadId);
      }
      previousSnapshot = snapshot;
    }
  }
}

function parseSseFrame(frame: string): { event: string | null; data: string } {
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  return {
    event,
    data: dataLines.join("\n")
  };
}

function printSnapshotDiff(
  previousSnapshot: ClientSnapshot | null,
  nextSnapshot: ClientSnapshot,
  selfId: string,
  focusThreadId?: string
) {
  if (!previousSnapshot) {
    console.log(
      `[${nextSnapshot.serverTime}] connected; ${nextSnapshot.users.length} users, ${nextSnapshot.friendIds.length} friends, ${nextSnapshot.threads.length} visible threads`
    );
    printThreads(nextSnapshot, selfId, focusThreadId);
    return;
  }

  const previousUsers = new Map(
    previousSnapshot.users.map((user) => [user.id, user] as const)
  );
  const nextUsers = new Map(nextSnapshot.users.map((user) => [user.id, user] as const));

  for (const user of nextSnapshot.users) {
    const previousUser = previousUsers.get(user.id);
    if (!previousUser) {
      console.log(
        `[${nextSnapshot.serverTime}] user joined: ${formatUserName(user)} (${user.id})`
      );
      continue;
    }

    if (
      previousUser.username !== user.username ||
      previousUser.kind !== user.kind
    ) {
      console.log(
        `[${nextSnapshot.serverTime}] user updated: ${user.id} -> ${formatUserName(user)}`
      );
    }
  }

  const previousFriendIds = new Set(previousSnapshot.friendIds);
  const nextFriendIds = new Set(nextSnapshot.friendIds);

  for (const friendId of nextFriendIds) {
    if (!previousFriendIds.has(friendId)) {
      console.log(
        `[${nextSnapshot.serverTime}] friend added: ${getAuthorName(nextSnapshot, friendId)} (${friendId})`
      );
    }
  }
  for (const friendId of previousFriendIds) {
    if (!nextFriendIds.has(friendId)) {
      console.log(
        `[${nextSnapshot.serverTime}] friend removed: ${getAuthorName(previousSnapshot, friendId)} (${friendId})`
      );
    }
  }

  const previousThreads = new Map(
    previousSnapshot.threads.map((thread) => [thread.id, thread] as const)
  );
  const nextThreads = new Map(
    nextSnapshot.threads.map((thread) => [thread.id, thread] as const)
  );

  for (const thread of nextSnapshot.threads) {
    if (focusThreadId && thread.id !== focusThreadId) {
      continue;
    }

    const previousThread = previousThreads.get(thread.id);
    if (!previousThread) {
      console.log(
        `[${thread.createdAt}] thread visible: ${getThreadLabel(
          thread,
          nextSnapshot,
          selfId
        )} (${thread.id})`
      );
      continue;
    }

    if (!sameMembers(previousThread.participantIds, thread.participantIds)) {
      console.log(
        `[${thread.updatedAt}] participants updated in ${getThreadLabel(
          thread,
          nextSnapshot,
          selfId
        )}: ${thread.participantIds
          .map((participantId) => getAuthorName(nextSnapshot, participantId))
          .join(", ")}`
      );
    }
  }

  for (const thread of previousSnapshot.threads) {
    if (focusThreadId && thread.id !== focusThreadId) {
      continue;
    }

    if (!nextThreads.has(thread.id)) {
      console.log(
        `[${nextSnapshot.serverTime}] thread no longer visible: ${getThreadLabel(
          thread,
          previousSnapshot,
          selfId
        )} (${thread.id})`
      );
    }
  }

  for (const thread of nextSnapshot.threads) {
    if (focusThreadId && thread.id !== focusThreadId) {
      continue;
    }

    const threadLabel = getThreadLabel(thread, nextSnapshot, selfId);
    const previousApps = new Map(
      (previousSnapshot.appsByThread[thread.id] ?? []).map((app) => [app.id, app] as const)
    );
    const nextApps = new Map(
      (nextSnapshot.appsByThread[thread.id] ?? []).map((app) => [app.id, app] as const)
    );

    for (const app of nextApps.values()) {
      const previousApp = previousApps.get(app.id);

      if (!previousApp) {
        console.log(
          `[${app.updatedAt}] ${threadLabel} :: app created: ${app.name} (${app.id}) by ${getAuthorName(
            nextSnapshot,
            app.updatedBy
          )}`
        );
        continue;
      }

      const changeKinds: string[] = [];
      if (
        previousApp.name !== app.name ||
        previousApp.description !== app.description
      ) {
        changeKinds.push("meta");
      }
      if (previousApp.savedSource !== app.savedSource) {
        changeKinds.push("source");
      }
      if (previousApp.document !== app.document) {
        changeKinds.push(previousApp.savedSource !== app.savedSource ? "state" : "value");
      }

      if (changeKinds.length) {
        console.log(
          `[${app.updatedAt}] ${threadLabel} :: app updated (${changeKinds.join(
            ", "
          )}): ${app.name} (${app.id}) by ${getAuthorName(nextSnapshot, app.updatedBy)}`
        );
      }
    }

    for (const app of previousApps.values()) {
      if (!nextApps.has(app.id)) {
        console.log(
          `[${nextSnapshot.serverTime}] ${threadLabel} :: app deleted: ${app.name} (${app.id})`
        );
      }
    }
  }

  const previousMessages = new Map<string, ChatMessage>();
  for (const messages of Object.values(previousSnapshot.messagesByThread)) {
    for (const message of messages) {
      previousMessages.set(message.id, message);
    }
  }

  for (const thread of nextSnapshot.threads) {
    if (focusThreadId && thread.id !== focusThreadId) {
      continue;
    }

    const threadMessages = nextSnapshot.messagesByThread[thread.id] ?? [];
    const threadLabel = getThreadLabel(thread, nextSnapshot, selfId);

    for (const message of threadMessages) {
      const previousMessage = previousMessages.get(message.id);

      if (!previousMessage) {
        console.log(
          `[${message.createdAt}] ${threadLabel} :: ${getAuthorName(
            nextSnapshot,
            message.agentId
          )} (${message.agentKind}) [${message.type}] ${serializeMessage(message)} (${message.id})`
        );
        continue;
      }

      printReactionDiff(previousMessage, message, nextSnapshot, threadLabel);
    }

    const nextMessageIds = new Set(threadMessages.map((message) => message.id));
    const previousThreadMessages = previousSnapshot.messagesByThread[thread.id] ?? [];
    for (const message of previousThreadMessages) {
      if (!nextMessageIds.has(message.id)) {
        console.log(
          `[${nextSnapshot.serverTime}] ${threadLabel} :: message deleted: ${serializeMessage(
            message
          )} (${message.id})`
        );
      }
    }
  }
}

function printReactionDiff(
  previousMessage: ChatMessage,
  nextMessage: ChatMessage,
  snapshot: ClientSnapshot,
  threadLabel: string
) {
  const previousReactions = new Map(
    previousMessage.reactions.map((reaction) => [reaction.id, reaction] as const)
  );
  const nextReactions = new Map(
    nextMessage.reactions.map((reaction) => [reaction.id, reaction] as const)
  );

  for (const reaction of nextMessage.reactions) {
    if (!previousReactions.has(reaction.id)) {
      console.log(
        `[${reaction.createdAt}] ${threadLabel} :: reaction +${reaction.emoji} by ${getAuthorName(
          snapshot,
          reaction.agentId
        )} on ${nextMessage.id}`
      );
    }
  }

  for (const reaction of previousMessage.reactions) {
    if (!nextReactions.has(reaction.id)) {
      console.log(
        `[${snapshot.serverTime}] ${threadLabel} :: reaction -${reaction.emoji} by ${getAuthorName(
          snapshot,
          reaction.agentId
        )} on ${nextMessage.id}`
      );
    }
  }
}

function printIdentity(identity: Identity, snapshot: ClientSnapshot) {
  console.log(`username: ${identity.username}`);
  console.log(`id:       ${identity.id}`);
  console.log(`kind:     ${identity.kind}`);
  console.log(`users:    ${snapshot.users.length}`);
  console.log(`friends:  ${snapshot.friendIds.length}`);
  console.log(`threads:  ${snapshot.threads.length}`);
}

function printUsers(users: EnrichedUser[]) {
  if (!users.length) {
    console.log("No users.");
    return;
  }

  for (const user of users) {
    console.log(`- ${formatUserName(user)} (${user.id})`);
    console.log(
      `  self: ${user.isSelf ? "yes" : "no"} | friend: ${user.isFriend ? "yes" : "no"}`
    );
  }
}

function printFriends(friends: EnrichedUser[]) {
  if (!friends.length) {
    console.log("No friends.");
    return;
  }

  for (const friend of friends) {
    console.log(`- ${formatUserName(friend)} (${friend.id})`);
  }
}

function printThreads(
  snapshot: ClientSnapshot,
  selfId: string,
  focusThreadId?: string
) {
  const visibleThreads = focusThreadId
    ? snapshot.threads.filter((thread) => thread.id === focusThreadId)
    : snapshot.threads;

  if (!visibleThreads.length) {
    console.log("No threads.");
    return;
  }

  for (const thread of visibleThreads) {
    const threadMessages = snapshot.messagesByThread[thread.id] ?? [];
    const latest = threadMessages.at(-1);
    console.log(`- ${getThreadLabel(thread, snapshot, selfId)} (${thread.id})`);
    console.log(
      `  participants: ${thread.participantIds
        .map((participantId) => getAuthorName(snapshot, participantId))
        .join(", ")}`
    );
    console.log(`  messages: ${threadMessages.length}`);
    if (latest) {
      console.log(
        `  latest: ${getAuthorName(snapshot, latest.agentId)} -> ${serializeMessage(latest)} (${latest.id})`
      );
    }
  }
}

function printThreadDetail(
  threadView: ReturnType<typeof buildThreadView>
) {
  console.log(`thread: ${threadView.label}`);
  console.log(`id:     ${threadView.id}`);
  console.log(`title:  ${threadView.title || "(untitled)"}`);
  console.log(
    `created: ${threadView.createdAt} by ${threadView.createdBy.username} (${threadView.createdBy.id})`
  );
  console.log(`updated: ${threadView.updatedAt}`);
  console.log(
    `participants: ${threadView.participants
      .map(
        (participant) =>
          `${participant.username} [${participant.kind}] (${participant.id})`
      )
      .join(", ")}`
  );
  console.log(`apps: ${threadView.apps.length}`);
  console.log(`messages: ${threadView.messages.length}`);
  if (threadView.summary) {
    console.log(
      `summary:  [${threadView.summary.status}] ${threadView.summary.content || "(empty)"}`
    );
  } else {
    console.log("summary:  (not generated yet)");
  }

  if (threadView.apps.length) {
    console.log("");
    console.log("apps:");
    for (const app of threadView.apps) {
      console.log(`- ${app.name} (${app.id})`);
      console.log(`  updated: ${app.updatedAt} by ${app.updatedBy.username}`);
      console.log(`  kind: ${app.sourceMode} | value: ${app.valueSummary}`);
      if (app.description) {
        console.log(`  ${app.description}`);
      }
    }
  }

  if (!threadView.messages.length) {
    return;
  }

  console.log("");
  printMessages(threadView.messages);
}

function printMessages(
  messages: ReturnType<typeof buildMessageView>[]
) {
  if (!messages.length) {
    console.log("No messages.");
    return;
  }

  for (const message of messages) {
    console.log(
      `- ${message.createdAt} ${message.author.username} [${message.author.kind}] ${message.type} (${message.id})`
    );
    console.log(`  ${message.textPreview}`);

    if (!message.reactions.length) {
      console.log("  reactions: none");
      continue;
    }

    console.log("  reactions:");
    for (const reaction of message.reactions) {
      console.log(
        `    ${reaction.emoji} ${reaction.agent.username} [${reaction.agent.kind}] (${reaction.agent.id})`
      );
    }
  }
}

function printSearchResults(result: ThreadSearchResponse) {
  if (!result.results.length) {
    console.log(`No matches for "${result.query}".`);
    return;
  }

  console.log(`Matches for "${result.query}"`);
  for (const match of result.results) {
    const reasons = match.reasons.join(", ") || "match";
    const semantic =
      match.semanticScore !== null ? ` | semantic ${match.semanticScore.toFixed(1)}` : "";
    console.log(
      `- ${match.createdAt} ${match.authorName} (${match.messageId}) [${reasons}${semantic}]`
    );
    console.log(`  ${match.snippet}`);
  }
}

function printAiResponse(response: AiTextResponse) {
  console.log(`model: ${response.model}`);
  console.log(`time:  ${response.generatedAt}`);

  if (response.threadId) {
    console.log(`thread: ${response.threadId}`);
  }

  if (response.threadSummary?.content) {
    console.log("");
    console.log("summary:");
    console.log(response.threadSummary.content);
  }

  if (response.contextMessages.length) {
    console.log("");
    console.log("context:");
    for (const message of response.contextMessages) {
      console.log(
        `- ${message.createdAt} ${message.authorName}: ${message.text}`
      );
    }
  }

  console.log("");
  console.log(response.output);
}

function printCommandDirectory(directory: CommandDirectoryResponse) {
  for (const category of directory.categories) {
    console.log(`${category.label}: ${category.description}`);
    for (const command of directory.commands.filter(
      (entry) => entry.categoryId === category.id
    )) {
      console.log(`- ${command.title}`);
      console.log(`  ${command.usage}`);
      console.log(`  ${command.summary}`);
    }
    console.log("");
  }
}

function printCommandRecommendations(
  recommendations: CommandRecommendationResponse
) {
  if (!recommendations.results.length) {
    console.log(`No commands matched "${recommendations.query}".`);
    return;
  }

  console.log(`Recommended commands for "${recommendations.query}"`);
  for (const recommendation of recommendations.results) {
    const reasons = recommendation.reasons.join(", ") || "match";
    const semantic =
      recommendation.semanticScore !== null
        ? ` | semantic ${recommendation.semanticScore.toFixed(1)}`
        : "";
    console.log(
      `- ${recommendation.command.title} [${reasons}${semantic}]`
    );
    console.log(`  ${recommendation.command.usage}`);
    console.log(`  ${recommendation.command.summary}`);
  }
}

function buildUsersView(
  snapshot: ClientSnapshot,
  selfId: string
): EnrichedUser[] {
  const friendIds = new Set(snapshot.friendIds);

  return snapshot.users.map((user) => ({
    ...user,
    isSelf: user.id === selfId,
    isFriend: friendIds.has(user.id)
  }));
}

function buildThreadView(
  snapshot: ClientSnapshot,
  thread: ChatThread,
  selfId: string
) {
  const messages = snapshot.messagesByThread[thread.id] ?? [];
  const apps = snapshot.appsByThread[thread.id] ?? [];

  return {
    id: thread.id,
    title: thread.title,
    label: getThreadLabel(thread, snapshot, selfId),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    summary: thread.summary,
    createdBy: buildUserRef(snapshot, thread.createdBy),
    participantIds: [...thread.participantIds],
    participants: thread.participantIds.map((participantId) =>
      buildUserRef(snapshot, participantId)
    ),
    apps: apps.map((app) => buildAppView(snapshot, thread.id, app)),
    messages: messages.map((message) => buildMessageView(snapshot, message))
  };
}

function buildAppsView(snapshot: ClientSnapshot, threadId: string) {
  getThreadOrThrow(snapshot, threadId);
  return (snapshot.appsByThread[threadId] ?? []).map((app) =>
    buildAppView(snapshot, threadId, app)
  );
}

function buildAppViewOrThrow(
  snapshot: ClientSnapshot,
  threadId: string,
  appId: string
) {
  const app = getThreadAppOrThrow(snapshot, threadId, appId);
  return buildAppView(snapshot, threadId, app);
}

function buildAppView(
  snapshot: ClientSnapshot,
  threadId: string,
  app: ThreadAppState
) {
  const valueResult = decodeThreadAppValue(app.document);
  const sourceResult = tryValidateAppSource(app.savedSource);

  return {
    id: app.id,
    threadId,
    name: app.name,
    description: app.description,
    updatedAt: app.updatedAt,
    updatedBy: buildUserRef(snapshot, app.updatedBy),
    savedSource: app.savedSource,
    sourceMode: sourceResult?.mode ?? "unknown",
    sourceValid: Boolean(sourceResult),
    value: valueResult.value,
    valueError: valueResult.error,
    valueSummary: valueResult.value
      ? summarizeAppValue(valueResult.value)
      : "unavailable"
  };
}

function buildMessageView(snapshot: ClientSnapshot, message: ChatMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    createdAt: message.createdAt,
    type: message.type,
    agentKind: message.agentKind,
    author: buildUserRef(snapshot, message.agentId),
    message: message.message,
    textPreview: serializeMessage(message),
    reactions: message.reactions.map((reaction) =>
      buildReactionView(snapshot, reaction)
    )
  };
}

function buildReactionView(snapshot: ClientSnapshot, reaction: MessageReaction) {
  return {
    id: reaction.id,
    emoji: reaction.emoji,
    createdAt: reaction.createdAt,
    agent: buildUserRef(snapshot, reaction.agentId)
  };
}

function buildUserRef(snapshot: ClientSnapshot, agentId: string) {
  const user = snapshot.users.find((entry) => entry.id === agentId);

  return {
    id: agentId,
    username: user?.username ?? agentId,
    kind: user?.kind ?? "user"
  };
}

function getThreadAppOrThrow(
  snapshot: ClientSnapshot,
  threadId: string,
  appId: string
): ThreadAppState {
  getThreadOrThrow(snapshot, threadId);
  const app = (snapshot.appsByThread[threadId] ?? []).find((entry) => entry.id === appId);
  if (!app) {
    throw new Error(`App not found: ${appId}`);
  }

  return app;
}

function getThreadOrThrow(
  snapshot: ClientSnapshot,
  threadId: string
): ChatThread {
  const thread = snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  return thread;
}

function getThreadLabel(
  thread: ChatThread,
  snapshot: ClientSnapshot,
  selfId: string
): string {
  if (thread.title.trim()) {
    return thread.title.trim();
  }

  const otherParticipants = thread.participantIds.filter(
    (participantId) => participantId !== selfId
  );

  if (!otherParticipants.length) {
    return "Solo thread";
  }

  return otherParticipants
    .map((participantId) => getAuthorName(snapshot, participantId))
    .join(", ");
}

function getAuthorName(snapshot: ClientSnapshot, agentId: string): string {
  return snapshot.users.find((user) => user.id === agentId)?.username ?? agentId;
}

function formatUserName(user: Pick<UserProfile, "username" | "kind">): string {
  return `${user.username} [${user.kind}]`;
}

function serializeMessage(message: ChatMessage): string {
  return extractMessageText(message);
}

function printApps(apps: ReturnType<typeof buildAppsView>) {
  if (!apps.length) {
    console.log("No apps.");
    return;
  }

  for (const app of apps) {
    console.log(`- ${app.name} (${app.id})`);
    console.log(`  updated: ${app.updatedAt} by ${app.updatedBy.username}`);
    console.log(`  kind: ${app.sourceMode} | value: ${app.valueSummary}`);
    if (app.description) {
      console.log(`  ${app.description}`);
    }
  }
}

function printAppDetail(app: ReturnType<typeof buildAppView>) {
  console.log(`app:         ${app.name}`);
  console.log(`id:          ${app.id}`);
  console.log(`thread:      ${app.threadId}`);
  console.log(`updated:     ${app.updatedAt}`);
  console.log(
    `updated by:  ${app.updatedBy.username} [${app.updatedBy.kind}] (${app.updatedBy.id})`
  );
  console.log(`source mode: ${app.sourceMode}`);
  console.log(`value:       ${app.valueSummary}`);
  if (app.description) {
    console.log(`description: ${app.description}`);
  }

  if (app.valueError) {
    console.log(`value error: ${app.valueError}`);
  } else if (app.value !== null) {
    console.log("");
    console.log("current value:");
    console.log(JSON.stringify(app.value, null, 2));
  }

  console.log("");
  console.log("saved source:");
  console.log(app.savedSource);
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightMembers = new Set(right);
  return left.every((member) => rightMembers.has(member));
}

function requireSnapshot(response: {
  ok: boolean;
  snapshot: ClientSnapshot | null;
}): ClientSnapshot {
  if (!response.snapshot) {
    throw new Error("Server did not return a snapshot.");
  }

  return response.snapshot;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(input: string[]) {
  const parsedFlags: ParsedFlags = {};
  const parsedPositionals: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith("--")) {
      parsedPositionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = input[index + 1];

    if (!nextToken || nextToken.startsWith("--")) {
      parsedFlags[key] = true;
      continue;
    }

    parsedFlags[key] = nextToken;
    index += 1;
  }

  return {
    positionals: parsedPositionals,
    flags: parsedFlags
  };
}

function parseCsv(value: string | boolean | undefined): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAppPath(source: string): AppPathSegment[] {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    throw new Error("--path must not be empty.");
  }

  if (trimmedSource.startsWith("/")) {
    return trimmedSource
      .split("/")
      .slice(1)
      .filter(Boolean)
      .map((segment) => decodePointerSegment(segment))
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  }

  const segments: AppPathSegment[] = [];
  const matcher = /([^[.\]]+)|\[(\d+)\]/g;

  for (const match of trimmedSource.matchAll(matcher)) {
    if (match[1]) {
      segments.push(match[1]);
      continue;
    }

    if (match[2]) {
      segments.push(Number(match[2]));
    }
  }

  if (!segments.length) {
    throw new Error(`Unable to parse app path: ${source}`);
  }

  return segments;
}

function formatAppPath(path: AppPathSegment[]): string {
  if (!path.length) {
    return "/";
  }

  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : index === 0
          ? segment
          : `.${segment}`
    )
    .join("");
}

function parseAppValueFromFlags(commandFlags: ParsedFlags): AppJsonValue {
  if (typeof commandFlags.value === "string") {
    return commandFlags.value;
  }

  const rawJsonValue =
    typeof commandFlags.valueJson === "string"
      ? commandFlags.valueJson
      : typeof commandFlags.jsonValue === "string"
        ? commandFlags.jsonValue
        : undefined;

  if (rawJsonValue) {
    const parsedValue = JSON5.parse(rawJsonValue) as unknown;
    if (!isAppJsonValue(parsedValue)) {
      throw new Error("--value-json must be a valid JSON value.");
    }

    return parsedValue;
  }

  throw new Error("Provide either --value for strings or --value-json for JSON/JSON5 values.");
}

async function resolveAppSource(commandFlags: ParsedFlags): Promise<string> {
  const inlineSource = asOptionalString(commandFlags.source);
  if (inlineSource) {
    return inlineSource;
  }

  const sourceFile = asOptionalString(commandFlags.sourceFile);
  if (sourceFile) {
    return readFile(sourceFile, "utf8");
  }

  return DEFAULT_APP_SOURCE;
}

function validateAppSource(source: string): {
  mode: "legacy" | "spec";
  source: string;
  value: AppJsonValue;
} {
  const parsedValue = JSON5.parse(source) as unknown;

  if (!isAppJsonValue(parsedValue)) {
    throw new Error(
      "Only JSON-compatible values are supported in app source: strings, finite numbers, booleans, null, arrays, and objects."
    );
  }

  if (!looksLikeJsonRenderSpec(parsedValue)) {
    return {
      mode: "legacy",
      source,
      value: parsedValue
    };
  }

  const validation = validateJsonRenderSpecShape(parsedValue);
  if (!validation.valid) {
    throw new Error(validation.issues.join(" "));
  }

  const stateValue =
    typeof parsedValue === "object" && parsedValue !== null && "state" in parsedValue
      ? parsedValue.state
      : undefined;

  if (
    stateValue !== undefined &&
    (typeof stateValue !== "object" || stateValue === null || Array.isArray(stateValue))
  ) {
    throw new Error('Spec field "state" must be an object when present.');
  }

  return {
    mode: "spec",
    source,
    value: (stateValue as AppJsonValue | undefined) ?? {}
  };
}

function tryValidateAppSource(source: string): {
  mode: "legacy" | "spec";
  source: string;
  value: AppJsonValue;
} | null {
  try {
    return validateAppSource(source);
  } catch {
    return null;
  }
}

function decodeThreadAppValue(encodedDocument: string): {
  error: string | null;
  value: AppJsonValue | null;
} {
  try {
    const document = Automerge.load<CliThreadAppDocument>(
      Uint8Array.from(Buffer.from(encodedDocument, "base64"))
    );
    return {
      error: null,
      value: document.value
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to decode app state.",
      value: null
    };
  }
}

function summarizeAppValue(value: AppJsonValue): string {
  if (Array.isArray(value)) {
    return `list (${value.length})`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length ? `object (${keys.length} keys)` : "object (empty)";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function decodePointerSegment(segment: string): string {
  return decodeURIComponent(segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parsePositiveInteger(
  value: string | boolean | undefined,
  fallback: number
): number {
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function asOptionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asAgentKind(value: string | boolean | undefined): AgentKind | undefined {
  return value === "user" || value === "ai" ? value : undefined;
}

function requireString(
  value: string | boolean | undefined,
  message: string
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  const nextValue: Partial<T> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      nextValue[key as keyof T] = entry as T[keyof T];
    }
  }

  return nextValue;
}

function hasFlag(commandFlags: ParsedFlags, key: string): boolean {
  const value = commandFlags[key];
  return value === true || value === "true";
}

function printHelp() {
  console.log(`social-cli

Read:
  social-cli whoami [--name "<username>"] [--kind user|ai] [--json]
  social-cli snapshot
  social-cli users list [--json]
  social-cli friends list [--json]
  social-cli threads list [--json]
  social-cli threads show --thread <thread-id> [--json]
  social-cli apps list --thread <thread-id> [--json]
  social-cli apps show --thread <thread-id> --app <app-id> [--json]
  social-cli message list --thread <thread-id> [--json]
  social-cli search chat --thread <thread-id> --query "<search text>" [--limit 10] [--json]
  social-cli watch [--thread <thread-id>] [--json]
  social-cli ai directory [--json]
  social-cli ai commands --query "<goal>" [--limit 5] [--json]
  social-cli ai summarize --thread <thread-id> | --text "<context>" [--paragraphs 2] [--json]
  social-cli ai ask --prompt "<question>" [--thread <thread-id>] [--json]

Write:
  social-cli friends add --friend <agent-id> [--json]
  social-cli friends remove --friend <agent-id> [--json]
  social-cli threads create --participants id1,id2 [--title "Thread title"] [--json]
  social-cli threads delete --thread <thread-id> [--json]
  social-cli threads participants add --thread <thread-id> --participants id1,id2 [--json]
  social-cli threads participants remove --thread <thread-id> --participants id1,id2 [--json]
  social-cli apps create --thread <thread-id> [--name "App"] [--description "Desc"] [--source '{"root":"..."}' | --source-file ./app.json5] [--json]
  social-cli apps delete --thread <thread-id> --app <app-id> [--json]
  social-cli apps meta --thread <thread-id> --app <app-id> [--name "App"] [--description "Desc"] [--json]
  social-cli apps save --thread <thread-id> --app <app-id> [--source '{"root":"..."}' | --source-file ./app.json5] [--json]
  social-cli apps set --thread <thread-id> --app <app-id> --path form.todos[0].done --value-json true [--json]
  social-cli apps share --thread <thread-id> --app <app-id> [--json]
  social-cli apps generate --thread <thread-id> --prompt "build me a todo app" [--app <app-id>] [--apply] [--name "App"] [--description "Desc"] [--json]
  social-cli message text --thread <thread-id> --text "hello world" [--json]
  social-cli message send --thread <thread-id> --type custom.event --json-payload '{"foo":"bar"}' [--json]
  social-cli react --thread <thread-id> --message <message-id> --emoji 👍 [--json]

Notes:
  snapshot prints the same visible snapshot shape the frontend receives.
  message send also accepts the legacy payload form: --json '{"foo":"bar"}'
  apps set accepts JSON Pointer paths like /form/todos/0/done and dot paths like form.todos[0].done.
  search chat ranks exact phrase matches first, then partial/token hits, then semantic matches.
  ai commands embeds the CLI command catalog and suggests the best-fit commands for a goal.
  watch --json emits one raw snapshot JSON object per line.
`);
}
