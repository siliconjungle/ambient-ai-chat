import type { Metadata } from "next";

import { JsonTestClient } from "./json-test-client";

export const metadata: Metadata = {
  title: "JSON Test",
  description: "Live JSON5 playground that turns arbitrary JSON into a form."
};

export default function JsonTestPage() {
  return <JsonTestClient />;
}
