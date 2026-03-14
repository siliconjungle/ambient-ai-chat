import type { AiContextMessage } from "@social/shared";
import OpenAI from "openai";

import { env } from "./env.js";

const client = env.openAiApiKey
  ? new OpenAI({
      apiKey: env.openAiApiKey
    })
  : null;

export function isAiAvailable(): boolean {
  return client !== null;
}

export async function embedTexts(
  inputs: string[]
): Promise<{ embeddings: number[][]; model: string } | null> {
  const cleanedInputs = inputs.map((input) => input.trim()).filter(Boolean);

  if (!client || cleanedInputs.length === 0) {
    return null;
  }

  const response = await client.embeddings.create({
    model: env.embeddingModel,
    input: cleanedInputs
  });

  return {
    embeddings: response.data.map((item) => item.embedding),
    model: response.model
  };
}

export async function embedText(
  input: string
): Promise<{ embedding: number[]; model: string } | null> {
  const response = await embedTexts([input]);

  if (!response) {
    return null;
  }

  return {
    embedding: response.embeddings[0] ?? [],
    model: response.model
  };
}

export async function generateThreadSummary(params: {
  threadLabel: string;
  existingSummary?: string | null;
  messages: AiContextMessage[];
  maxParagraphs: number;
}): Promise<{ text: string; model: string }> {
  return generateText({
    model: env.summaryModel,
    instructions: [
      "You maintain concise running chat summaries for retrieval.",
      `Write ${params.maxParagraphs} short paragraph(s) at most.`,
      "Capture concrete decisions, commitments, preferences, tensions, and unresolved questions.",
      "Do not invent facts. If something is uncertain, keep the wording cautious.",
      "Avoid bullet lists."
    ].join("\n"),
    input: [
      `Thread: ${params.threadLabel}`,
      "",
      "Existing summary:",
      params.existingSummary?.trim() || "(none yet)",
      "",
      "Messages:",
      formatMessages(params.messages)
    ].join("\n")
  });
}

export async function generateProfileSummary(params: {
  username: string;
  existingSummary?: string | null;
  messages: AiContextMessage[];
  maxParagraphs: number;
}): Promise<{ text: string; model: string }> {
  return generateText({
    model: env.summaryModel,
    instructions: [
      "You maintain a concise person-level memory based only on that person's own chat messages.",
      `Write ${params.maxParagraphs} short paragraph(s) at most.`,
      "Focus on stated preferences, goals, opinions, concerns, constraints, and recurring themes.",
      "Do not speculate beyond the evidence in the messages.",
      "Avoid bullet lists."
    ].join("\n"),
    input: [
      `Person: ${params.username}`,
      "",
      "Existing profile memory:",
      params.existingSummary?.trim() || "(none yet)",
      "",
      "Messages from this person:",
      formatMessages(params.messages)
    ].join("\n")
  });
}

export async function summarizeContext(params: {
  context: string;
  maxParagraphs: number;
}): Promise<{ text: string; model: string }> {
  return generateText({
    model: env.summaryModel,
    instructions: [
      "Summarize the provided context into a compact set of paragraphs.",
      `Write ${params.maxParagraphs} short paragraph(s) at most.`,
      "Retain concrete facts, decisions, and unresolved questions.",
      "Avoid bullet lists."
    ].join("\n"),
    input: params.context
  });
}

export async function answerWithContext(params: {
  prompt: string;
  threadLabel?: string;
  threadSummary?: string | null;
  participantSummaries?: Array<{ username: string; summary: string | null }>;
  messages: AiContextMessage[];
}): Promise<{ text: string; model: string }> {
  const participantContext = (params.participantSummaries ?? [])
    .map(
      (participant) =>
        `${participant.username}: ${participant.summary?.trim() || "(no profile memory yet)"}`
    )
    .join("\n");

  return generateText({
    model: env.chatModel,
    instructions: [
      "Answer questions about the supplied chat context.",
      "Use only the provided context. If the answer is not supported, say that clearly.",
      "Prefer a direct answer followed by a short explanation."
    ].join("\n"),
    input: [
      params.threadLabel ? `Thread: ${params.threadLabel}` : null,
      "",
      "Thread summary:",
      params.threadSummary?.trim() || "(no thread summary yet)",
      "",
      "Participant memories:",
      participantContext || "(none yet)",
      "",
      "Relevant messages:",
      formatMessages(params.messages),
      "",
      `Question: ${params.prompt}`
    ]
      .filter((entry): entry is string => entry !== null)
      .join("\n")
  });
}

async function generateText(params: {
  model: string;
  instructions: string;
  input: string;
}): Promise<{ text: string; model: string }> {
  if (!client) {
    throw new Error("OpenAI is not configured on the server.");
  }

  const response = await client.responses.create({
    model: params.model,
    instructions: params.instructions,
    input: params.input,
    max_output_tokens: 500
  });
  const text = response.output_text.trim();

  if (!text) {
    throw new Error("The model returned an empty response.");
  }

  return {
    text,
    model: response.model
  };
}

function formatMessages(messages: AiContextMessage[]): string {
  if (!messages.length) {
    return "(no messages)";
  }

  return messages
    .map(
      (message) =>
        `[${message.createdAt}] ${message.authorName} (${message.agentId}): ${message.text}`
    )
    .join("\n");
}
