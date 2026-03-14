export interface DirectMatchScore {
  exactMatch: boolean;
  partialMatchCount: number;
  directScore: number;
  reasons: string[];
}

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function scoreDirectTextMatch(
  query: string,
  document: string
): DirectMatchScore {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedDocument = normalizeSearchText(document);
  const queryTokens = tokenizeSearchText(query);
  const documentTokens = tokenizeSearchText(document);
  const documentTokenSet = new Set(documentTokens);
  const exactMatch =
    Boolean(normalizedQuery) && normalizedDocument.includes(normalizedQuery);
  let exactTokenMatches = 0;
  let partialMatches = 0;

  for (const token of queryTokens) {
    if (documentTokenSet.has(token)) {
      exactTokenMatches += 1;
      continue;
    }

    if (
      documentTokens.some(
        (documentToken) =>
          documentToken.includes(token) || token.includes(documentToken)
      )
    ) {
      partialMatches += 1;
    }
  }

  const reasons: string[] = [];
  if (exactMatch) {
    reasons.push("exact");
  }
  if (exactTokenMatches > 0 || partialMatches > 0) {
    reasons.push("partial");
  }

  return {
    exactMatch,
    partialMatchCount: exactTokenMatches + partialMatches,
    directScore:
      (exactMatch ? 1_500 : 0) + exactTokenMatches * 260 + partialMatches * 110,
    reasons
  };
}

export function cosineSimilarity(
  left: number[] | null,
  right: number[] | null
): number | null {
  if (!left || !right || left.length === 0 || right.length === 0) {
    return null;
  }
  if (left.length !== right.length) {
    return null;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return null;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function buildSnippet(text: string, query: string): string {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (compactText.length <= 180) {
    return compactText;
  }

  const queryIndex = compactText
    .toLowerCase()
    .indexOf(query.trim().toLowerCase());

  if (queryIndex < 0) {
    return `${compactText.slice(0, 177)}...`;
  }

  const start = Math.max(0, queryIndex - 60);
  const end = Math.min(compactText.length, queryIndex + query.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compactText.length ? "..." : "";

  return `${prefix}${compactText.slice(start, end)}${suffix}`;
}
