import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const currentDir = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(currentDir, "../.env") });
dotenv.config();

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export const env = {
  port: readNumber(process.env.PORT, 4000),
  stateFile: resolve(
    currentDir,
    process.env.STATE_FILE?.trim() || "../.data/server-state.json"
  ),
  openAiApiKey:
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPEN_AI_KEY?.trim() ||
    "",
  chatModel: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-5-mini",
  summaryModel: process.env.OPENAI_SUMMARY_MODEL?.trim() || "gpt-5-mini",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL?.trim() ||
    "text-embedding-3-small",
  threadSummaryInterval: readNumber(process.env.THREAD_SUMMARY_INTERVAL, 5),
  profileSummaryInterval: readNumber(process.env.PROFILE_SUMMARY_INTERVAL, 8),
  summaryRecentMessageLimit: readNumber(
    process.env.SUMMARY_RECENT_MESSAGE_LIMIT,
    40
  ),
  aiContextMessageLimit: readNumber(process.env.AI_CONTEXT_MESSAGE_LIMIT, 18),
  searchResultLimit: readNumber(process.env.SEARCH_RESULT_LIMIT, 30),
  commandRecommendationLimit: readNumber(
    process.env.COMMAND_RECOMMENDATION_LIMIT,
    5
  )
};

export const aiConfigured = Boolean(env.openAiApiKey);
