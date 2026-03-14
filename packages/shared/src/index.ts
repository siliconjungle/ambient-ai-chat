export type AgentKind = "user" | "ai";
export type AvatarPattern = "bands" | "bloom" | "grid" | "orbit" | "slice";
export type AiSummaryStatus = "idle" | "processing" | "ready" | "error";

export interface ProceduralAvatar {
  pattern: AvatarPattern;
  base: string;
  accent: string;
  highlight: string;
  text: string;
}

export interface AiSummary {
  content: string;
  updatedAt: string;
  messageCount: number;
  status: AiSummaryStatus;
  model?: string;
  lastError?: string;
}

export interface UserProfile {
  id: string;
  username: string;
  kind: AgentKind;
  avatar: ProceduralAvatar;
  createdAt: string;
  updatedAt: string;
  profileSummary: AiSummary | null;
}

export interface MessageReaction {
  id: string;
  emoji: string;
  agentId: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  type: string;
  agentId: string;
  agentKind: AgentKind;
  participantIds: string[];
  message: Record<string, unknown>;
  createdAt: string;
  reactions: MessageReaction[];
}

export interface EmbeddedAppMessage {
  appId: string;
  appName: string;
}

export interface ChatThread {
  id: string;
  title: string;
  participantIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  summary: AiSummary | null;
}

export type AppJsonPrimitive = string | number | boolean | null;
export type AppJsonArray = AppJsonValue[];
export type AppJsonObject = { [key: string]: AppJsonValue };
export type AppJsonValue = AppJsonPrimitive | AppJsonArray | AppJsonObject;
export type AppPathSegment = string | number;
export interface JsonRenderSpecValidationResult {
  issues: string[];
  valid: boolean;
}

export interface ThreadAppTemplate {
  id: string;
  name: string;
  description: string;
  source: string;
  value: AppJsonValue;
}

export interface ThreadAppState {
  id: string;
  name: string;
  description: string;
  savedSource: string;
  document: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ClientSnapshot {
  self: UserProfile | null;
  users: UserProfile[];
  friendIds: string[];
  threads: ChatThread[];
  appsByThread: Record<string, ThreadAppState[]>;
  messagesByThread: Record<string, ChatMessage[]>;
  serverTime: string;
}

export interface ThreadSearchResult {
  messageId: string;
  threadId: string;
  agentId: string;
  authorName: string;
  createdAt: string;
  text: string;
  snippet: string;
  exactMatch: boolean;
  partialMatchCount: number;
  semanticScore: number | null;
  directScore: number;
  score: number;
  reasons: string[];
}

export interface ThreadSearchResponse {
  query: string;
  limit: number;
  generatedAt: string;
  results: ThreadSearchResult[];
}

export interface AiContextMessage {
  messageId: string;
  threadId: string;
  agentId: string;
  authorName: string;
  createdAt: string;
  text: string;
}

export interface AiParticipantContext {
  userId: string;
  username: string;
  summary: AiSummary | null;
}

export interface AiTextResponse {
  prompt: string;
  output: string;
  model: string;
  generatedAt: string;
  threadId: string | null;
  threadSummary: AiSummary | null;
  contextMessages: AiContextMessage[];
  participantSummaries: AiParticipantContext[];
}

export interface CliCommandCategory {
  id: string;
  label: string;
  description: string;
}

export interface CliCommandDefinition {
  id: string;
  categoryId: string;
  title: string;
  usage: string;
  summary: string;
  examples: string[];
  intents: string[];
}

export interface CommandRecommendation {
  command: CliCommandDefinition;
  score: number;
  directScore: number;
  semanticScore: number | null;
  reasons: string[];
}

export interface CommandDirectoryResponse {
  generatedAt: string;
  categories: CliCommandCategory[];
  commands: CliCommandDefinition[];
}

export interface CommandRecommendationResponse {
  query: string;
  limit: number;
  generatedAt: string;
  results: CommandRecommendation[];
}

export type ChatCommand =
  | {
      command: "profile.upsert";
      profile: {
        id: string;
        username: string;
        kind: AgentKind;
      };
    }
  | {
      command: "friend.add";
      agentId: string;
      friendId: string;
    }
  | {
      command: "friend.remove";
      agentId: string;
      friendId: string;
    }
  | {
      command: "thread.create";
      agentId: string;
      title: string;
      participantIds: string[];
    }
  | {
      command: "thread.delete";
      agentId: string;
      threadId: string;
    }
  | {
      command: "thread.participants.add";
      agentId: string;
      threadId: string;
      participantIds: string[];
    }
  | {
      command: "thread.participants.remove";
      agentId: string;
      threadId: string;
      participantIds: string[];
    }
  | {
      command: "message.send";
      threadId: string;
      type: string;
      agentId: string;
      agentKind: AgentKind;
      message: Record<string, unknown>;
    }
  | {
      command: "message.react.toggle";
      threadId: string;
      messageId: string;
      emoji: string;
      agentId: string;
    }
  | {
      command: "message.delete";
      threadId: string;
      messageId: string;
      agentId: string;
    }
  | {
      command: "thread.app.create";
      agentId: string;
      threadId: string;
      name: string;
      description: string;
      source: string;
      value: AppJsonValue;
    }
  | {
      command: "thread.app.delete";
      agentId: string;
      threadId: string;
      appId: string;
    }
  | {
      command: "thread.app.meta.update";
      agentId: string;
      threadId: string;
      appId: string;
      name: string;
      description: string;
    }
  | {
      command: "thread.app.source.save";
      agentId: string;
      threadId: string;
      appId: string;
      source: string;
      value: AppJsonValue;
    }
  | {
      command: "thread.app.form.update";
      agentId: string;
      threadId: string;
      appId: string;
      path: AppPathSegment[];
      value: AppJsonValue;
    };

export const defaultThreadAppTemplates: ThreadAppTemplate[] = [];

export const descriptorOptions = [
  "Amber",
  "Arc",
  "Ash",
  "Aster",
  "Bold",
  "Brisk",
  "Bright",
  "Cloud",
  "Cobalt",
  "Comet",
  "Copper",
  "Crisp",
  "Dapper",
  "Dawn",
  "Drift",
  "Echo",
  "Ember",
  "Fable",
  "Frost",
  "Gleam",
  "Glint",
  "Golden",
  "Harbor",
  "Hazel",
  "Indigo",
  "Ivory",
  "Jade",
  "Juniper",
  "Lively",
  "Lucky",
  "Lunar",
  "Maple",
  "Mellow",
  "Misty",
  "Nova",
  "Orbit",
  "Pebble",
  "Plucky",
  "Quiet",
  "Radiant",
  "River",
  "Rustic",
  "Saffron",
  "Silver",
  "Solar",
  "Spry",
  "Storm",
  "Sunny",
  "Velvet",
  "Willow"
] as const;

export const animalOptions = [
  "Aardvark",
  "Albatross",
  "Badger",
  "Beaver",
  "Bison",
  "Bobcat",
  "Caracal",
  "Cougar",
  "Crane",
  "Crow",
  "Dolphin",
  "Falcon",
  "Ferret",
  "Finch",
  "Fox",
  "Gecko",
  "Heron",
  "Jaguar",
  "Koala",
  "Lark",
  "Lemur",
  "Leopard",
  "Lynx",
  "Manatee",
  "Marten",
  "Moose",
  "Narwhal",
  "Newt",
  "Ocelot",
  "Otter",
  "Owl",
  "Panda",
  "Panther",
  "Parrot",
  "Pika",
  "Puffin",
  "Quokka",
  "Raven",
  "Seal",
  "Serval",
  "Sparrow",
  "Stoat",
  "Swift",
  "Tiger",
  "Toucan",
  "Turtle",
  "Viper",
  "Walrus",
  "Wolf",
  "Wren"
] as const;

export function createRandomUsername(random = Math.random): string {
  const descriptor =
    descriptorOptions[Math.floor(random() * descriptorOptions.length)];
  const animal = animalOptions[Math.floor(random() * animalOptions.length)];

  return `${descriptor} ${animal}`;
}

export function createProceduralAvatar(seed: string): ProceduralAvatar {
  const hash = hashString(seed);
  const hue = hash % 360;
  const patterns: AvatarPattern[] = ["bands", "bloom", "grid", "orbit", "slice"];
  const pattern = patterns[hash % patterns.length] ?? "bands";
  const colorSchemes = [
    {
      accentOffset: 116,
      highlightOffset: 236,
      baseSaturation: 76,
      accentSaturation: 90,
      highlightSaturation: 84,
      baseLightness: 56,
      accentLightness: 63,
      highlightLightness: 72,
      textOffset: 116
    },
    {
      accentOffset: 178,
      highlightOffset: 24,
      baseSaturation: 78,
      accentSaturation: 92,
      highlightSaturation: 82,
      baseLightness: 55,
      accentLightness: 64,
      highlightLightness: 74,
      textOffset: 178
    },
    {
      accentOffset: 28,
      highlightOffset: 56,
      baseSaturation: 74,
      accentSaturation: 86,
      highlightSaturation: 80,
      baseLightness: 58,
      accentLightness: 68,
      highlightLightness: 76,
      textOffset: 28
    },
    {
      accentOffset: 152,
      highlightOffset: 208,
      baseSaturation: 72,
      accentSaturation: 88,
      highlightSaturation: 82,
      baseLightness: 57,
      accentLightness: 66,
      highlightLightness: 73,
      textOffset: 152
    },
    {
      accentOffset: 82,
      highlightOffset: 198,
      baseSaturation: 75,
      accentSaturation: 89,
      highlightSaturation: 81,
      baseLightness: 56,
      accentLightness: 65,
      highlightLightness: 74,
      textOffset: 82
    }
  ] as const;
  const scheme = colorSchemes[(hash >> 4) % colorSchemes.length] ?? colorSchemes[0];
  const accentHue = (hue + scheme.accentOffset + ((hash >> 9) % 10) - 5 + 360) % 360;
  const highlightHue =
    (hue + scheme.highlightOffset + ((hash >> 13) % 12) - 6 + 360) % 360;
  const baseSaturation = scheme.baseSaturation + ((hash >> 8) % 8);
  const accentSaturation = scheme.accentSaturation + ((hash >> 12) % 6);
  const highlightSaturation = scheme.highlightSaturation + ((hash >> 16) % 7);
  const baseLightness = scheme.baseLightness + ((hash >> 20) % 5);
  const accentLightness = scheme.accentLightness + ((hash >> 24) % 5);
  const highlightLightness = scheme.highlightLightness + ((hash >> 28) % 4);
  const textHue = (hue + scheme.textOffset) % 360;

  return {
    pattern,
    base: toHsl(hue, baseSaturation, baseLightness),
    accent: toHsl(accentHue, accentSaturation, accentLightness),
    highlight: toHsl(highlightHue, highlightSaturation, highlightLightness),
    text: toHsl(textHue, 92, 78)
  };
}

export function sortByUpdatedAtDescending<T extends { updatedAt: string }>(
  items: T[]
): T[] {
  return [...items].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

export function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAppJsonValue(value: unknown): value is AppJsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every((item) => isAppJsonValue(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((item) => isAppJsonValue(item));
}

export function looksLikeJsonRenderSpec(value: AppJsonValue): boolean {
  return (
    isRecord(value) &&
    ("root" in value || "elements" in value || "state" in value)
  );
}

export function validateJsonRenderSpecShape(
  value: AppJsonValue
): JsonRenderSpecValidationResult {
  if (!isRecord(value)) {
    return {
      issues: ["Spec must be a JSON object."],
      valid: false
    };
  }

  const issues: string[] = [];
  const root = value.root;
  const elements = value.elements;

  if (typeof root !== "string" || !root.trim()) {
    issues.push('Spec field "root" must be a non-empty string.');
  }

  if (!isRecord(elements)) {
    issues.push('Spec field "elements" must be an object.');
  }

  if ("state" in value && value.state !== undefined && !isRecord(value.state)) {
    issues.push('Spec field "state" must be an object when present.');
  }

  if (!isRecord(elements)) {
    return {
      issues,
      valid: false
    };
  }

  if (typeof root === "string" && root && !(root in elements)) {
    issues.push(`Root element "${root}" is missing from elements.`);
  }

  const elementKeys = new Set(Object.keys(elements));

  for (const [elementId, candidate] of Object.entries(elements)) {
    if (!isRecord(candidate)) {
      issues.push(`Element "${elementId}" must be an object.`);
      continue;
    }

    if (typeof candidate.type !== "string" || !candidate.type.trim()) {
      issues.push(`Element "${elementId}" must have a non-empty string "type".`);
    }

    if (!isRecord(candidate.props)) {
      issues.push(`Element "${elementId}" must have an object "props".`);
    }

    if (
      "children" in candidate &&
      (!Array.isArray(candidate.children) ||
        candidate.children.some((child) => typeof child !== "string"))
    ) {
      issues.push(
        `Element "${elementId}" must use a "children" array of element ids when present.`
      );
    }

    if (isRecord(candidate.props)) {
      for (const field of ["visible", "on", "repeat", "watch"]) {
        if (field in candidate.props) {
          issues.push(
            `Element "${elementId}" must put "${field}" on the element, not inside props.`
          );
        }
      }
    }

    if (Array.isArray(candidate.children)) {
      for (const childId of candidate.children) {
        if (typeof childId !== "string") {
          continue;
        }

        if (!elementKeys.has(childId)) {
          issues.push(
            `Element "${elementId}" references missing child "${childId}".`
          );
        }
      }
    }
  }

  return {
    issues,
    valid: issues.length === 0
  };
}

export function collectStreamingJsonCandidates(
  source: string,
  maxTrimSteps = 480
): string[] {
  const candidates = new Set<string>();

  for (const seed of collectBaseJsonFragments(source)) {
    let working = seed.trim();
    let trims = 0;

    while (working && trims <= Math.min(maxTrimSteps, working.length)) {
      addJsonCandidate(candidates, working);
      addJsonCandidate(candidates, autoCloseJsonCandidate(working));

      const next = trimJsonCandidateTail(working);
      working =
        next && next !== working
          ? next
          : working.slice(0, Math.max(0, working.length - 1)).trimEnd();
      trims += 1;
    }
  }

  return [...candidates];
}

function collectBaseJsonFragments(source: string): string[] {
  const trimmed = source.trim();
  const fragments = new Set<string>();

  if (trimmed) {
    fragments.add(trimmed);
  }

  const fencedMatch = trimmed.match(/```(?:json|json5)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]?.trim()) {
    fragments.add(fencedMatch[1].trim());
  }

  const firstObjectIndex = trimmed.indexOf("{");
  if (firstObjectIndex >= 0) {
    fragments.add(trimmed.slice(firstObjectIndex).trim());
  }

  const firstArrayIndex = trimmed.indexOf("[");
  if (firstArrayIndex >= 0) {
    fragments.add(trimmed.slice(firstArrayIndex).trim());
  }

  return [...fragments];
}

function addJsonCandidate(target: Set<string>, candidate: string): void {
  const normalized = candidate.trim();
  if (normalized) {
    target.add(normalized);
  }
}

function trimJsonCandidateTail(source: string): string {
  let next = source.trimEnd();

  if (!next) {
    return "";
  }

  if (next.endsWith("/*")) {
    return next.slice(0, -2).trimEnd();
  }

  const lineCommentIndex = next.lastIndexOf("//");
  if (
    lineCommentIndex >= 0 &&
    next.slice(lineCommentIndex).indexOf("\n") === -1
  ) {
    return next.slice(0, lineCommentIndex).trimEnd();
  }

  while (/[,:]$/.test(next)) {
    next = next.slice(0, -1).trimEnd();
  }

  return next;
}

function autoCloseJsonCandidate(source: string): string {
  let next = source.trimEnd();
  const stack: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < next.length; index += 1) {
    const char = next[index]!;
    const following = next[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && following === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && following === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && following === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if ((char === "}" || char === "]") && stack.at(-1) === char) {
      stack.pop();
    }
  }

  if (lineComment) {
    next += "\n";
  }

  if (blockComment) {
    next += "*/";
  }

  if (quote) {
    next += quote;
  }

  next = trimJsonCandidateTail(next);

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    next += stack[index];
  }

  return next.trim();
}

export function readEmbeddedAppMessage(
  message: Pick<ChatMessage, "message" | "type">
): EmbeddedAppMessage | null {
  if (message.type !== "chat.app.embed") {
    return null;
  }

  const appId = message.message.appId;
  const appName = message.message.appName;

  if (typeof appId !== "string" || typeof appName !== "string") {
    return null;
  }

  return {
    appId,
    appName
  };
}

export function extractMessageText(
  message: Pick<ChatMessage, "message" | "type">
): string {
  if (typeof message.message.text === "string") {
    return message.message.text;
  }

  const embeddedApp = readEmbeddedAppMessage(message);
  if (embeddedApp) {
    return `Shared app: ${embeddedApp.appName}`;
  }

  return JSON.stringify(message.message);
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function toHsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${Math.round(hue)} ${saturation}% ${lightness}%)`;
}
