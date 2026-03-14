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
        <h1 className={styles.title}>JSON5 in, form out.</h1>
        <p className={styles.subtitle}>
          Type arbitrary JSON5 on the left. The right-hand side renders a naive
          form from it: strings become inputs, booleans become switches, arrays
          become containers, and nested structures recurse all the way down.
        </p>
      </div>

      <Json5FormEditor onSourceChange={setSource} source={source} />
    </main>
  );
}
