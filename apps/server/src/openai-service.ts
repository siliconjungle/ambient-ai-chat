import JSON5 from "json5";
import OpenAI from "openai";

import {
  collectStreamingJsonCandidates,
  type AppJsonObject,
  type AppJsonValue,
  type AiContextMessage,
  isAppJsonValue,
  isRecord,
  looksLikeJsonRenderSpec,
  validateJsonRenderSpecShape
} from "@social/shared";

import { env } from "./env.js";

const client = env.openAiApiKey
  ? new OpenAI({
      apiKey: env.openAiApiKey
    })
  : null;
const EMPTY_RESPONSE_ATTEMPTS = 3;
const STREAM_RESPONSE_TIMEOUT_MS = 30_000;
const STREAM_FINALIZE_TIMEOUT_MS = 10_000;

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

export async function generateAppSource(params: {
  prompt: string;
  appName?: string | null;
  appDescription?: string | null;
  currentSource?: string | null;
  threadLabel?: string | null;
  messages?: AiContextMessage[];
}): Promise<{ source: string; model: string }> {
  const response = await generateText({
    model: env.chatModel,
    instructions: APP_SOURCE_INSTRUCTIONS,
    input: buildAppSourceInput(params),
    maxOutputTokens: 2_000
  });

  return {
    source: await finalizeGeneratedAppSource({
      currentSource: params.currentSource,
      messages: params.messages,
      prompt: params.prompt,
      text: response.text
    }),
    model: response.model
  };
}

export async function streamAppSource(
  params: {
    prompt: string;
    appName?: string | null;
    appDescription?: string | null;
    currentSource?: string | null;
    threadLabel?: string | null;
    messages?: AiContextMessage[];
  },
  onDelta: (delta: string) => void
): Promise<{ source: string; model: string }> {
  if (!client) {
    throw new Error("OpenAI is not configured on the server.");
  }

  const input = buildAppSourceInput(params);
  let streamedText = "";
  let recoverableSource: string | null = null;

  const stream = client.responses.stream({
    model: env.chatModel,
    instructions: APP_SOURCE_INSTRUCTIONS,
    input,
    max_output_tokens: 2_000
  });

  stream.on("response.output_text.delta", (event) => {
    streamedText += event.delta;
    recoverableSource = tryNormalizeGeneratedAppSource(streamedText) ?? recoverableSource;
    onDelta(event.delta);
  });

  let finalResponse: { model: string; output?: unknown; output_text?: string } | null = null;

  try {
    finalResponse = await withTimeout(stream.finalResponse(), STREAM_RESPONSE_TIMEOUT_MS, () => {
      stream.abort();
    });
  } catch (error) {
    if (recoverableSource) {
      return {
        source: recoverableSource,
        model: env.chatModel
      };
    }

    const fallback = await generateText({
      model: env.chatModel,
      instructions: APP_SOURCE_INSTRUCTIONS,
      input,
      maxOutputTokens: 2_000,
      retryReason:
        error instanceof Error
          ? error.message
          : "Previous streaming attempt did not finish."
    });

    return {
      source: await finalizeGeneratedAppSource({
        currentSource: params.currentSource,
        messages: params.messages,
        prompt: params.prompt,
        text: fallback.text
      }),
      model: fallback.model
    };
  }

  const finalText = streamedText.trim() || extractResponseText(finalResponse).trim();

  if (!finalText) {
    const fallback = await generateText({
      model: env.chatModel,
      instructions: APP_SOURCE_INSTRUCTIONS,
      input,
      maxOutputTokens: 2_000,
      retryReason: "Previous streaming attempt returned an empty response."
    });
    onDelta(fallback.text);

    return {
      source: await finalizeGeneratedAppSource({
        currentSource: params.currentSource,
        messages: params.messages,
        prompt: params.prompt,
        text: fallback.text
      }),
      model: fallback.model
    };
  }

  try {
    return {
      source: await withTimeout(
        finalizeGeneratedAppSource(
          {
            currentSource: params.currentSource,
            messages: params.messages,
            prompt: params.prompt,
            text: finalText
          },
          { repairAttempts: 1 }
        ),
        STREAM_FINALIZE_TIMEOUT_MS
      ),
      model: finalResponse.model
    };
  } catch (error) {
    if (recoverableSource) {
      return {
        source: recoverableSource,
        model: finalResponse.model
      };
    }

    throw error;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Generation timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function generateText(params: {
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens?: number;
  retryReason?: string;
}): Promise<{ text: string; model: string }> {
  if (!client) {
    throw new Error("OpenAI is not configured on the server.");
  }

  let lastModel = params.model;

  for (let attempt = 1; attempt <= EMPTY_RESPONSE_ATTEMPTS; attempt += 1) {
    const response = await client.responses.create({
      model: params.model,
      instructions:
        attempt === 1
          ? params.instructions
          : [
              params.instructions,
              "Previous attempt returned no content.",
              "You must return a non-empty response this time."
            ].join("\n"),
      input: buildRetryInput(params.input, params.retryReason, attempt),
      max_output_tokens: params.maxOutputTokens ?? 500
    });
    const text = extractResponseText(response).trim();
    lastModel = response.model;

    if (text) {
      return {
        text,
        model: response.model
      };
    }
  }

  const retryContext = params.retryReason ? ` ${params.retryReason}` : "";
  throw new Error(
    `The model returned an empty response after ${EMPTY_RESPONSE_ATTEMPTS} attempts.${retryContext}`
  );
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

function extractResponseText(response: {
  output?: unknown;
  output_text?: string;
}): string {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  return response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      if (!("content" in item) || !Array.isArray(item.content)) {
        return [];
      }

      return item.content.flatMap((part: unknown) => {
        if (!part || typeof part !== "object") {
          return [];
        }

        if ("type" in part && part.type === "output_text" && "text" in part) {
          return [typeof part.text === "string" ? part.text : ""];
        }

        if ("type" in part && part.type === "refusal" && "refusal" in part) {
          return [typeof part.refusal === "string" ? part.refusal : ""];
        }

        return [];
      });
    })
    .join("");
}

function buildRetryInput(
  input: string,
  retryReason: string | undefined,
  attempt: number
): string {
  if (attempt === 1) {
    return input;
  }

  return [
    input,
    "",
    `Retry attempt ${attempt}.`,
    retryReason ?? "Previous attempt returned an empty response.",
    "Return a non-empty response."
  ].join("\n");
}

function buildAppSourceInput(params: {
  prompt: string;
  appName?: string | null;
  appDescription?: string | null;
  currentSource?: string | null;
  threadLabel?: string | null;
  messages?: AiContextMessage[];
}): string {
  const seededSource = getSeedSource(params.currentSource);

  return [
    params.threadLabel ? `Thread: ${params.threadLabel}` : null,
    params.appName?.trim() ? `App name: ${params.appName.trim()}` : null,
    params.appDescription?.trim()
      ? `App description: ${params.appDescription.trim()}`
      : null,
    seededSource
      ? ["Current JSON source:", seededSource].join("\n")
      : "There is no existing JSON source yet.",
    params.messages?.length
      ? [
          "",
          "Reference context for meaning only. Do not serialize any of this into output keys or values unless the user explicitly asked for it:",
          formatMessages(params.messages)
        ].join("\n")
      : null,
    "",
    `Request: ${params.prompt.trim()}`
  ]
    .filter((entry): entry is string => entry !== null)
    .join("\n");
}

async function finalizeGeneratedAppSource(params: {
  currentSource?: string | null;
  messages?: AiContextMessage[];
  prompt: string;
  text: string;
}, options?: {
  repairAttempts?: number;
}): Promise<string> {
  const direct = tryNormalizeGeneratedAppSource(params.text);
  if (direct) {
    return direct;
  }

  let repairInput = params.text;
  const repairAttempts = Math.max(0, options?.repairAttempts ?? 3);

  for (let attempt = 1; attempt <= repairAttempts; attempt += 1) {
    repairInput = await repairGeneratedAppSource({
      ...params,
      attempt,
      text: repairInput
    });

    const normalized = tryNormalizeGeneratedAppSource(repairInput);
    if (normalized) {
      return normalized;
    }
  }

  throw new Error("The model returned invalid JSON for the app shape after multiple repair attempts.");
}

async function repairGeneratedAppSource(params: {
  attempt: number;
  currentSource?: string | null;
  messages?: AiContextMessage[];
  prompt: string;
  text: string;
}): Promise<string> {
  const seededSource = getSeedSource(params.currentSource);

  const repairResponse = await generateText({
    model: env.chatModel,
    instructions: [
      "You repair model output into one complete valid JSON value.",
      "The input may be truncated, malformed, wrapped in metadata, or expressed in the wrong JSON shape.",
      "Return only raw JSON.",
      "Output one valid json-render spec object with top-level root, elements, and optional state.",
      "Each element must use top-level type, props, optional children, and optional on/visible/repeat/watch fields.",
      "Available components include the standard json-render shadcn set plus IconButton for compact icon-only actions.",
      "Do not leave state orphaned. Important state should be surfaced by elements, bindings, repeat blocks, or actions.",
      "If the state describes a todo/task list, include completion checkboxes or toggles, a bound input for a new item, an Add button using pushState, and delete affordances using removeState.",
      "Do not output plain sample data, form field schemas, or wrapper metadata.",
      "The state field must be an object when present.",
      "If the draft is cut off, finish it coherently."
    ].join("\n"),
    input: [
      seededSource
        ? ["Current JSON source:", seededSource].join("\n")
        : "There is no existing JSON source yet.",
      params.messages?.length
        ? ["", "Reference context:", formatMessages(params.messages)].join("\n")
        : null,
      "",
      `Repair attempt: ${params.attempt}`,
      "",
      `User request: ${params.prompt.trim()}`,
      "",
      "Broken draft to repair:",
      params.text.trim()
    ]
      .filter((entry): entry is string => entry !== null)
      .join("\n"),
    maxOutputTokens: 2_000
  });

  return repairResponse.text;
}

function normalizeGeneratedAppSource(text: string): string {
  const normalized = tryNormalizeGeneratedAppSource(text);

  if (normalized) {
    return normalized;
  }

  throw new Error("The model returned invalid JSON for the app shape.");
}

function tryNormalizeGeneratedAppSource(text: string): string | null {
  for (const candidate of collectStreamingJsonCandidates(text)) {
    try {
      const parsedValue = JSON5.parse(candidate) as unknown;

      if (!isAppJsonValue(parsedValue)) {
        continue;
      }

      if (!looksLikeJsonRenderSpec(parsedValue)) {
        continue;
      }

      const healedValue = healJsonRenderSpecForDisplay(parsedValue);
      const validation = validateJsonRenderSpecShape(healedValue);
      if (!validation.valid) {
        continue;
      }

      return JSON.stringify(healedValue, null, 2);
    } catch {
      continue;
    }
  }

  return null;
}

function healJsonRenderSpecForDisplay(value: AppJsonValue): AppJsonValue {
  if (!isRecord(value) || !isRecord(value.elements) || !isRecord(value.state)) {
    return value;
  }

  const rootId = value.root;
  if (typeof rootId !== "string" || !rootId.trim()) {
    return value;
  }

  const rootElement = value.elements[rootId];
  if (!isRecord(rootElement)) {
    return value;
  }

  const spec = cloneAppJsonValue(value);
  if (!isRecord(spec) || !isRecord(spec.elements) || !isRecord(spec.state)) {
    return value;
  }

  const todoPattern = detectTodoPattern(spec.state);
  if (todoPattern && needsTodoEnhancement(spec, todoPattern)) {
    applyTodoEnhancement(spec, todoPattern);
    return spec;
  }

  if (needsGenericStateSurface(spec)) {
    applyGenericStateSurface(spec);
    return spec;
  }

  return spec;
}

function detectTodoPattern(
  state: AppJsonObject
): {
  arrayKey: string;
  completedField: string;
  inputKey: string;
  textField: string;
} | null {
  for (const [key, candidate] of Object.entries(state)) {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      continue;
    }

    const firstItem = candidate[0];
    if (!isRecord(firstItem)) {
      continue;
    }

    const textField = ["text", "title", "name", "label"].find(
      (field) => typeof firstItem[field] === "string"
    );
    const completedField = ["completed", "done", "checked"].find(
      (field) => typeof firstItem[field] === "boolean"
    );

    if (!textField || !completedField) {
      continue;
    }

    const preferredInputKey =
      ["newTodo", "newTask", "newItem", "draft", "input"].find(
        (inputKey) => typeof state[inputKey] === "string"
      ) ?? "newTodo";

    return {
      arrayKey: key,
      completedField,
      inputKey: preferredInputKey,
      textField
    };
  }

  return null;
}

function needsTodoEnhancement(
  spec: AppJsonObject,
  todoPattern: {
    arrayKey: string;
    completedField: string;
    inputKey: string;
    textField: string;
  }
): boolean {
  const serialized = JSON.stringify(spec);

  return !(
    serialized.includes(`"/${todoPattern.arrayKey}"`) &&
    serialized.includes(`"$bindState":"/${todoPattern.inputKey}"`) &&
    serialized.includes('"action":"pushState"') &&
    (serialized.includes(`"$bindItem":"${todoPattern.completedField}"`) ||
      serialized.includes(`"$bindState":"/${todoPattern.arrayKey}`))
  );
}

function applyTodoEnhancement(
  spec: AppJsonObject,
  todoPattern: {
    arrayKey: string;
    completedField: string;
    inputKey: string;
    textField: string;
  }
): void {
  if (!isRecord(spec.state) || !isRecord(spec.elements)) {
    return;
  }

  if (typeof spec.state[todoPattern.inputKey] !== "string") {
    spec.state[todoPattern.inputKey] = "";
  }

  const elements = spec.elements;
  const layoutId = createUniqueElementId(elements, "auto-todo-layout");
  const composerId = createUniqueElementId(elements, "auto-todo-composer");
  const inputId = createUniqueElementId(elements, "auto-todo-input");
  const addId = createUniqueElementId(elements, "auto-todo-add");
  const listId = createUniqueElementId(elements, "auto-todo-list");
  const rowId = createUniqueElementId(elements, "auto-todo-row");
  const checkboxId = createUniqueElementId(elements, "auto-todo-checkbox");
  const deleteId = createUniqueElementId(elements, "auto-todo-delete");

  elements[layoutId] = {
    type: "Stack",
    props: {
      direction: "vertical",
      gap: "md",
      align: "stretch",
      justify: "start"
    },
    children: [composerId, listId]
  };
  elements[composerId] = {
    type: "Stack",
    props: {
      direction: "horizontal",
      gap: "sm",
      align: "end",
      justify: "start"
    },
    children: [inputId, addId]
  };
  elements[inputId] = {
    type: "Input",
    props: {
      label: "New task",
      name: todoPattern.inputKey,
      type: "text",
      placeholder: "Add a task",
      value: {
        $bindState: `/${todoPattern.inputKey}`
      },
      disabled: false
    }
  };
  elements[addId] = {
    type: "Button",
    props: {
      label: "Add",
      variant: "primary",
      disabled: false
    },
    on: {
      press: {
        action: "pushState",
        params: {
          statePath: `/${todoPattern.arrayKey}`,
          value: {
            id: "$id",
            [todoPattern.textField]: {
              $state: `/${todoPattern.inputKey}`
            },
            [todoPattern.completedField]: false
          },
          clearStatePath: `/${todoPattern.inputKey}`
        }
      }
    }
  };
  elements[listId] = {
    type: "Stack",
    props: {
      direction: "vertical",
      gap: "md",
      align: "stretch",
      justify: "start"
    },
    repeat: {
      statePath: `/${todoPattern.arrayKey}`
    },
    children: [rowId]
  };
  elements[rowId] = {
    type: "Stack",
    props: {
      direction: "horizontal",
      gap: "md",
      align: "center",
      justify: "between"
    },
    children: [checkboxId, deleteId]
  };
  elements[checkboxId] = {
    type: "Checkbox",
    props: {
      label: {
        $item: todoPattern.textField
      },
      name: `${sanitizeFieldName(todoPattern.arrayKey)}-completed`,
      checked: {
        $bindItem: todoPattern.completedField
      },
      disabled: false
    }
  };
  elements[deleteId] = createRemoveStateButton(`/${todoPattern.arrayKey}`, "Delete task");

  mountGeneratedChild(spec, layoutId, "auto-generated-root");
}

function needsGenericStateSurface(spec: AppJsonObject): boolean {
  if (!isRecord(spec.state) || !Object.keys(spec.state).length) {
    return false;
  }

  if (!specUsesState(spec)) {
    return true;
  }

  if (!isRecord(spec.elements) || typeof spec.root !== "string") {
    return false;
  }

  const rootElement = spec.elements[spec.root];
  return !isRecord(rootElement) || !Array.isArray(rootElement.children) || rootElement.children.length === 0;
}

function applyGenericStateSurface(spec: AppJsonObject): void {
  if (!isRecord(spec.state) || !isRecord(spec.elements)) {
    return;
  }

  const elements = spec.elements;
  const surfaceId = createUniqueElementId(elements, "auto-state-surface");
  const childIds: string[] = [];

  for (const [key, value] of Object.entries(spec.state)) {
    childIds.push(buildStateSurfaceField(spec, key, `/${key}`, value));
  }

  elements[surfaceId] = {
    type: "Stack",
    props: {
      direction: "vertical",
      gap: "md",
      align: "stretch",
      justify: "start"
    },
    children: childIds
  };

  mountGeneratedChild(spec, surfaceId, "auto-generated-root");
}

function buildStateSurfaceField(
  spec: AppJsonObject,
  label: string,
  statePath: string,
  value: AppJsonValue
): string {
  if (!isRecord(spec.elements)) {
    return "";
  }

  const elements = spec.elements;

  if (Array.isArray(value)) {
    const cardId = createUniqueElementId(elements, "auto-state-array-card");
    const listId = createUniqueElementId(elements, "auto-state-array-list");

    elements[cardId] = {
      type: "Card",
      props: {
        title: label,
        description: value.length ? "Collection" : "Empty list",
        maxWidth: "full",
        centered: false
      },
      children: [listId]
    };

    if (!value.length) {
      const emptyId = createUniqueElementId(elements, "auto-state-empty");
      elements[listId] = {
        type: "Stack",
        props: {
          direction: "vertical",
          gap: "sm",
          align: "stretch",
          justify: "start"
        },
        children: [emptyId]
      };
      elements[emptyId] = {
        type: "Text",
        props: {
          text: "Empty list",
          variant: "muted"
        }
      };
      return cardId;
    }

    const firstItem = value[0];
    if (isRecord(firstItem)) {
      const rowId = createUniqueElementId(elements, "auto-state-row");
      const contentId = createUniqueElementId(elements, "auto-state-row-content");
      const deleteId = createUniqueElementId(elements, "auto-state-row-delete");
      const rowChildIds: string[] = [];

      for (const [fieldKey, fieldValue] of Object.entries(firstItem).slice(0, 3)) {
        if (typeof fieldValue === "boolean") {
          const toggleId = createUniqueElementId(elements, "auto-state-row-toggle");
          elements[toggleId] = {
            type: "Checkbox",
            props: {
              label: fieldKey,
              checked: {
                $bindItem: fieldKey
              },
              disabled: false
            }
          };
          rowChildIds.push(toggleId);
          continue;
        }

        const textId = createUniqueElementId(elements, "auto-state-row-text");
        elements[textId] = {
          type: "Text",
          props: {
            text: {
              $item: fieldKey
            },
            variant: "body"
          }
        };
        rowChildIds.push(textId);
      }

      elements[listId] = {
        type: "Stack",
        props: {
          direction: "vertical",
          gap: "sm",
          align: "stretch",
          justify: "start"
        },
        repeat: {
          statePath
        },
        children: [rowId]
      };
      elements[contentId] = {
        type: "Stack",
        props: {
          direction: "vertical",
          gap: "sm",
          align: "start",
          justify: "start"
        },
        children: rowChildIds
      };
      elements[deleteId] = createRemoveStateButton(statePath, `Delete ${label}`);
      elements[rowId] = {
        type: "Stack",
        props: {
          direction: "horizontal",
          gap: "md",
          align: "center",
          justify: "between"
        },
        children: [contentId, deleteId]
      };

      return cardId;
    }

    const textId = createUniqueElementId(elements, "auto-state-list-text");
    const rowId = createUniqueElementId(elements, "auto-state-list-row");
    const deleteId = createUniqueElementId(elements, "auto-state-list-delete");
    elements[listId] = {
      type: "Stack",
      props: {
        direction: "vertical",
        gap: "sm",
        align: "stretch",
        justify: "start"
      },
      repeat: {
        statePath
      },
      children: [rowId]
    };
    elements[rowId] = {
      type: "Stack",
      props: {
        direction: "horizontal",
        gap: "md",
        align: "center",
        justify: "between"
      },
      children: [textId, deleteId]
    };
    elements[textId] = {
      type: "Text",
      props: {
        text: {
          $item: ""
        },
        variant: "body"
      }
    };
    elements[deleteId] = createRemoveStateButton(statePath, `Delete ${label}`);

    return cardId;
  }

  if (isRecord(value)) {
    const cardId = createUniqueElementId(spec.elements, "auto-state-object-card");
    const stackId = createUniqueElementId(spec.elements, "auto-state-object-stack");
    const childIds = Object.entries(value)
      .slice(0, 6)
      .map(([key, childValue]) =>
        buildStateSurfaceField(spec, key, `${statePath}/${encodeURIComponent(key)}`, childValue)
      );

    spec.elements[cardId] = {
      type: "Card",
      props: {
        title: label,
        description: "",
        maxWidth: "full",
        centered: false
      },
      children: [stackId]
    };
    spec.elements[stackId] = {
      type: "Stack",
      props: {
        direction: "vertical",
        gap: "md",
        align: "stretch",
        justify: "start"
      },
      children: childIds
    };

    return cardId;
  }

  const fieldName = sanitizeFieldName(label);

  if (typeof value === "boolean") {
    const switchId = createUniqueElementId(spec.elements, "auto-state-switch");
    spec.elements[switchId] = {
      type: "Switch",
      props: {
        label,
        name: fieldName,
        checked: {
          $bindState: statePath
        },
        disabled: false
      }
    };
    return switchId;
  }

  if (typeof value === "number") {
    const inputId = createUniqueElementId(spec.elements, "auto-state-number");
    spec.elements[inputId] = {
      type: "Input",
      props: {
        label,
        name: fieldName,
        type: "number",
        value: {
          $bindState: statePath
        },
        disabled: false
      }
    };
    return inputId;
  }

  if (typeof value === "string") {
    const inputId = createUniqueElementId(spec.elements, "auto-state-input");
    spec.elements[inputId] = {
      type: "Input",
      props: {
        label,
        name: fieldName,
        type: "text",
        value: {
          $bindState: statePath
        },
        disabled: false
      }
    };
    return inputId;
  }

  const textId = createUniqueElementId(spec.elements, "auto-state-null");
  spec.elements[textId] = {
    type: "Text",
    props: {
      text: `${label}: null`,
      variant: "muted"
    }
  };
  return textId;
}

function mountGeneratedChild(
  spec: AppJsonObject,
  childId: string,
  wrapperPrefix: string
): void {
  if (!isRecord(spec.elements) || typeof spec.root !== "string") {
    return;
  }

  const rootElement = spec.elements[spec.root];
  if (isRecord(rootElement) && canElementContainChildren(rootElement)) {
    const nextChildren = Array.isArray(rootElement.children)
      ? rootElement.children.filter((entry): entry is string => typeof entry === "string")
      : [];

    if (!nextChildren.includes(childId)) {
      rootElement.children = [...nextChildren, childId];
    }
    return;
  }

  const wrapperId = createUniqueElementId(spec.elements, wrapperPrefix);
  spec.elements[wrapperId] = {
    type: "Stack",
    props: {
      direction: "vertical",
      gap: "md",
      align: "stretch",
      justify: "start"
    },
    children: [spec.root, childId]
  };
  spec.root = wrapperId;
}

function createRemoveStateButton(statePath: string, label: string): AppJsonObject {
  return {
    type: "IconButton",
    props: {
      icon: "trash",
      label,
      variant: "danger",
      disabled: false
    },
    on: {
      press: {
        action: "removeState",
        params: {
          statePath,
          index: {
            $index: true
          }
        }
      }
    }
  };
}

function specUsesState(spec: AppJsonObject): boolean {
  if (!isRecord(spec.elements)) {
    return false;
  }

  return Object.values(spec.elements).some((element) =>
    containsStateReference(element)
  );
}

function containsStateReference(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsStateReference(entry));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (
    "$state" in value ||
    "$bindState" in value ||
    "$bindItem" in value ||
    "$item" in value ||
    "$index" in value ||
    "repeat" in value
  ) {
    return true;
  }

  return Object.values(value).some((entry) => containsStateReference(entry));
}

function canElementContainChildren(element: AppJsonObject): boolean {
  if (Array.isArray(element.children)) {
    return true;
  }

  return new Set([
    "Card",
    "Stack",
    "Grid",
    "Tabs",
    "Accordion",
    "Collapsible",
    "Dialog",
    "Drawer",
    "Popover"
  ]).has(typeof element.type === "string" ? element.type : "");
}

function createUniqueElementId(elements: AppJsonObject, prefix: string): string {
  let nextId = prefix;
  let index = 1;

  while (nextId in elements) {
    nextId = `${prefix}-${index}`;
    index += 1;
  }

  return nextId;
}

function sanitizeFieldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "field";
}

function cloneAppJsonValue<T extends AppJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getSeedSource(currentSource?: string | null): string | null {
  const trimmedSource = currentSource?.trim();

  if (!trimmedSource || trimmedSource === "{}") {
    return null;
  }

  return trimmedSource;
}

const APP_SOURCE_INSTRUCTIONS = [
  "Generate a valid json-render spec object for the React renderer.",
  "Always return one JSON object with top-level root, elements, and optional state.",
  "Use standard json-render component types such as Card, Stack, Grid, Heading, Text, Button, Input, Textarea, Select, Checkbox, Radio, Switch, Badge, Alert, Avatar, Separator, Tabs, Accordion, Progress, and Link. IconButton with icon: \"trash\" is also available for compact delete actions.",
  "Put interaction handlers on the element itself using on.press, on.change, on.submit, etc.",
  'Use top-level state as the backing data model. For two-way bindings use value: { "$bindState": "/path" } or checked: { "$bindState": "/path" }.',
  "Use realistic defaults in state so the rendered UI is immediately useful.",
  "Do not create orphaned state. Important state keys must be surfaced by visible elements, repeat blocks, bindings, or actions.",
  "If you generate an editable list, checklist, or todo/task list, include completion controls when relevant, a bound input for new item text when items can be added, an Add button using pushState, and delete affordances using removeState.",
  "If the root is a Card or other container, give it children when the UI has content to show.",
  "For repeated collections, use repeat on a container and $item / $index in child props.",
  "For editable repeated rows, keep controls aligned in a single row and prefer a trailing IconButton delete action.",
  "Leaf elements may omit children. Container elements should reference child ids that exist in elements.",
  'Do not place on, visible, repeat, or watch inside props.',
  "Do not output plain JSON data, form field schemas, or explanatory text.",
  "Return only raw JSON or JSON5.",
  "Do not include markdown fences, labels, or explanations.",
  "Keep the spec concise but complete enough to demonstrate the requested UI."
].join("\n");
