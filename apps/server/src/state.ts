import type { ChatMessage, ChatThread, UserProfile } from "@social/shared";

export interface StoredEmbedding {
  input: string;
  embedding: number[];
  model: string;
  createdAt: string;
}

export interface StoreState {
  users: Map<string, UserProfile>;
  friendships: Map<string, Set<string>>;
  threads: Map<string, ChatThread>;
  messagesByThread: Map<string, ChatMessage[]>;
  messageEmbeddings: Map<string, StoredEmbedding>;
  commandEmbeddings: Map<string, StoredEmbedding>;
}

export function createEmptyState(): StoreState {
  return {
    users: new Map(),
    friendships: new Map(),
    threads: new Map(),
    messagesByThread: new Map(),
    messageEmbeddings: new Map(),
    commandEmbeddings: new Map()
  };
}
