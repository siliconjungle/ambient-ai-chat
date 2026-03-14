import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ChatMessage,
  ChatThread,
  ThreadAppState,
  UserProfile
} from "@social/shared";

import {
  createEmptyState,
  type StoreState,
  type StoredEmbedding
} from "./state.js";

interface PersistedStateFile {
  version: 1 | 2;
  savedAt: string;
  users: UserProfile[];
  friendships: Array<{
    agentId: string;
    friendIds: string[];
  }>;
  threads: ChatThread[];
  appsByThread?: Array<{
    threadId: string;
    apps: ThreadAppState[];
  }>;
  messagesByThread: Array<{
    threadId: string;
    messages: ChatMessage[];
  }>;
  messageEmbeddings: Array<{
    messageId: string;
    embedding: StoredEmbedding;
  }>;
  commandEmbeddings: Array<{
    commandId: string;
    embedding: StoredEmbedding;
  }>;
}

export async function loadStateFromDisk(stateFile: string): Promise<StoreState> {
  try {
    const raw = await readFile(stateFile, "utf8");
    if (!raw.trim()) {
      return createEmptyState();
    }

    const parsed = JSON.parse(raw) as Partial<PersistedStateFile>;
    if (parsed.version !== 1 && parsed.version !== 2) {
      throw new Error(
        `Unsupported state file version: ${String(parsed.version ?? "unknown")}`
      );
    }

    const state = createEmptyState();

    for (const user of asArray<UserProfile>(parsed.users)) {
      state.users.set(user.id, user);
    }

    for (const friendship of asArray<PersistedStateFile["friendships"][number]>(
      parsed.friendships
    )) {
      state.friendships.set(friendship.agentId, new Set(friendship.friendIds));
    }

    for (const thread of asArray<ChatThread>(parsed.threads)) {
      state.threads.set(thread.id, thread);
    }

    for (const entry of asArray<NonNullable<PersistedStateFile["appsByThread"]>[number]>(
      parsed.appsByThread
    )) {
      state.appsByThread.set(
        entry.threadId,
        entry.apps.map((app) => ({
          ...app,
          description: typeof app.description === "string" ? app.description : ""
        }))
      );
    }

    for (const entry of asArray<PersistedStateFile["messagesByThread"][number]>(
      parsed.messagesByThread
    )) {
      state.messagesByThread.set(entry.threadId, entry.messages);
    }

    for (const entry of asArray<PersistedStateFile["messageEmbeddings"][number]>(
      parsed.messageEmbeddings
    )) {
      state.messageEmbeddings.set(entry.messageId, entry.embedding);
    }

    for (const entry of asArray<PersistedStateFile["commandEmbeddings"][number]>(
      parsed.commandEmbeddings
    )) {
      state.commandEmbeddings.set(entry.commandId, entry.embedding);
    }

    return state;
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyState();
    }

    throw new Error(
      `Unable to load persisted state from ${stateFile}: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}

export async function saveStateToDisk(
  stateFile: string,
  state: StoreState
): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });

  const payload: PersistedStateFile = {
    version: 2,
    savedAt: new Date().toISOString(),
    users: [...state.users.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    friendships: [...state.friendships.entries()]
      .map(([agentId, friendIds]) => ({
        agentId,
        friendIds: [...friendIds].sort()
      }))
      .sort((left, right) => left.agentId.localeCompare(right.agentId)),
    threads: [...state.threads.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    appsByThread: [...state.appsByThread.entries()]
      .map(([threadId, apps]) => ({
        threadId,
        apps: [...apps].sort((left, right) => left.id.localeCompare(right.id))
      }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId)),
    messagesByThread: [...state.messagesByThread.entries()]
      .map(([threadId, messages]) => ({
        threadId,
        messages: [...messages].sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        )
      }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId)),
    messageEmbeddings: [...state.messageEmbeddings.entries()]
      .map(([messageId, embedding]) => ({
        messageId,
        embedding
      }))
      .sort((left, right) => left.messageId.localeCompare(right.messageId)),
    commandEmbeddings: [...state.commandEmbeddings.entries()]
      .map(([commandId, embedding]) => ({
        commandId,
        embedding
      }))
      .sort((left, right) => left.commandId.localeCompare(right.commandId))
  };

  const tempFile = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFile, stateFile);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
