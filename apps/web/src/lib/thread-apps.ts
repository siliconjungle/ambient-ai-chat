import * as Automerge from "@automerge/automerge";

import type { AppJsonValue } from "@social/shared";

type ThreadAppDocument = {
  value: AppJsonValue;
};

export function readThreadAppValue(encodedDocument: string): AppJsonValue {
  const document = Automerge.load<ThreadAppDocument>(decodeBase64(encodedDocument));
  return document.value;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return bytes;
}
