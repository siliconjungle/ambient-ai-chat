"use client";

import { useState } from "react";

import {
  DEFAULT_JSON5_SOURCE,
  Json5FormEditor
} from "../../components/json5-form-editor";
import styles from "./page.module.css";

export function JsonTestClient() {
  const [source, setSource] = useState(DEFAULT_JSON5_SOURCE);

  return (
    <main className={styles.page}>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>/json-test</p>
        <h1 className={styles.title}>JSON5 spec in, `json-render` out.</h1>
        <p className={styles.subtitle}>
          Type a `json-render` spec on the left. The right-hand side uses the
          stock shadcn registry so the preview matches the real renderer. Plain
          JSON sources still load through a legacy compatibility path.
        </p>
      </div>

      <Json5FormEditor onSourceChange={setSource} source={source} />
    </main>
  );
}
