"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useState } from "react";
import JSON5 from "json5";

import {
  type AppJsonPrimitive,
  type AppJsonValue,
  type AppPathSegment,
  isAppJsonValue
} from "@social/shared";

import styles from "./json5-form-editor.module.css";

type JsonArray = AppJsonValue[];
type JsonObject = { [key: string]: AppJsonValue };
type ScalarInputValue = string | boolean | null;
type ScalarState = Record<string, ScalarInputValue>;
type Json5EditorViewMode = "split" | "editor" | "form";

export const DEFAULT_JSON5_SOURCE = `{}`;

const INITIAL_SCHEMA = parseJson5(DEFAULT_JSON5_SOURCE);

type Json5WorkbenchProps = {
  actions?: ReactNode;
  compact?: boolean;
  onScalarChange?: (path: AppPathSegment[], value: AppJsonPrimitive) => void;
  onSourceChange: (source: string) => void;
  parseError?: string | null;
  source: string;
  sourceHint?: string;
  value: AppJsonValue;
  viewMode?: Json5EditorViewMode;
};

type Json5FormEditorProps = {
  compact?: boolean;
  source: string;
  onSourceChange: (source: string) => void;
  viewMode?: Json5EditorViewMode;
};

export function Json5FormEditor({
  compact = false,
  source,
  onSourceChange,
  viewMode = "split"
}: Json5FormEditorProps) {
  const [schema, setSchema] = useState<AppJsonValue>(INITIAL_SCHEMA);
  const [scalarState, setScalarState] = useState<ScalarState>(() =>
    collectScalarDefaults(INITIAL_SCHEMA)
  );
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const nextSchema = parseJson5(source);
      setSchema(nextSchema);
      setScalarState(collectScalarDefaults(nextSchema));
      setParseError(null);
    } catch (error) {
      setParseError(getErrorMessage(error));
    }
  }, [source]);

  const formValue = materializeValue(schema, [], scalarState);

  return (
    <Json5Workbench
      compact={compact}
      onScalarChange={(path, value) => {
        setScalarState((current) => ({
          ...current,
          [toPathKey(path)]: typeof value === "number" ? String(value) : value
        }));
      }}
      onSourceChange={onSourceChange}
      parseError={parseError}
      source={source}
      value={formValue}
      viewMode={viewMode}
    />
  );
}

export function Json5Workbench({
  actions,
  compact = false,
  onScalarChange,
  onSourceChange,
  parseError = null,
  source,
  sourceHint,
  value,
  viewMode = "split"
}: Json5WorkbenchProps) {
  const showEditor = viewMode !== "form";
  const showWorkbench = viewMode !== "editor";

  return (
    <div
      className={`${styles.workbench} ${compact ? styles.workbenchCompact : ""} ${
        viewMode === "split" ? "" : styles.workbenchSingle
      }`}
    >
      {showEditor ? (
        <Json5SourceEditorPanel
          actions={actions}
          onSourceChange={onSourceChange}
          parseError={parseError}
          source={source}
          sourceHint={sourceHint}
        />
      ) : null}
      {showWorkbench ? (
        <JsonValueWorkbench onScalarChange={onScalarChange} value={value} />
      ) : null}
    </div>
  );
}

export function Json5SourceEditorPanel({
  actions,
  onSourceChange,
  parseError = null,
  source,
  sourceHint
}: {
  actions?: ReactNode;
  onSourceChange: (source: string) => void;
  parseError?: string | null;
  source: string;
  sourceHint?: string;
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.panelEyebrow}>Source</p>
          <h2 className={styles.panelTitle}>JSON5 editor</h2>
        </div>
        <span
          className={parseError ? styles.statusError : styles.statusOk}
          role="status"
        >
          {parseError ? "Parse error" : "Live"}
        </span>
      </div>

      <p className={styles.panelCopy}>
        Comments, single quotes, unquoted keys, and trailing commas all work here.
      </p>

      <textarea
        aria-label="JSON5 source"
        className={styles.editor}
        onChange={(event) => onSourceChange(event.currentTarget.value)}
        spellCheck={false}
        value={source}
      />

      <div className={styles.statusBlock}>
        {parseError ? (
          <>
            <p className={styles.errorText}>{parseError}</p>
            <p className={styles.statusHint}>
              Fix the source before saving it into the collaborative app state.
            </p>
          </>
        ) : (
          <p className={styles.statusHint}>
            {sourceHint ?? "Edit the generated form on the right without changing the source."}
          </p>
        )}
      </div>

      {actions ? <div className={styles.editorActions}>{actions}</div> : null}
    </section>
  );
}

export function JsonValueWorkbench({
  onScalarChange,
  value
}: {
  onScalarChange?: (path: AppPathSegment[], value: AppJsonPrimitive) => void;
  value: AppJsonValue;
}) {
  return (
    <div className={styles.rightRail}>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelEyebrow}>Render</p>
            <h2 className={styles.panelTitle}>Generated form</h2>
          </div>
        </div>

        <div className={styles.formSurface}>
          <RenderedJsonField
            depth={0}
            isRoot
            label="Root"
            onScalarChange={onScalarChange}
            path={[]}
            value={value}
          />
        </div>
      </section>
    </div>
  );
}

export function validateJson5Source(source: string): {
  error: string | null;
  value: AppJsonValue | null;
} {
  try {
    return {
      error: null,
      value: parseJson5(source)
    };
  } catch (error) {
    return {
      error: getErrorMessage(error),
      value: null
    };
  }
}

export function summarizeJson5Shape(source: string): string {
  try {
    return describeJsonValue(parseJson5(source));
  } catch {
    return "Invalid JSON5 shape";
  }
}

type JsonFieldProps = {
  depth: number;
  isRoot?: boolean;
  label: string;
  path: AppPathSegment[];
  scalarState: ScalarState;
  setScalarState: Dispatch<SetStateAction<ScalarState>>;
  value: AppJsonValue;
};

function JsonField({
  depth,
  isRoot = false,
  label,
  path,
  scalarState,
  setScalarState,
  value
}: JsonFieldProps) {
  if (Array.isArray(value)) {
    return (
      <ArrayField
        depth={depth}
        isRoot={isRoot}
        label={label}
        path={path}
        scalarState={scalarState}
        setScalarState={setScalarState}
        value={value}
      />
    );
  }

  if (isJsonObject(value)) {
    return (
      <ObjectField
        depth={depth}
        isRoot={isRoot}
        label={label}
        path={path}
        scalarState={scalarState}
        setScalarState={setScalarState}
        value={value}
      />
    );
  }

  return (
    <ScalarField
      label={label}
      path={path}
      scalarState={scalarState}
      setScalarState={setScalarState}
      value={value}
    />
  );
}

type ObjectFieldProps = Omit<JsonFieldProps, "value"> & {
  value: JsonObject;
};

function ObjectField({
  depth,
  isRoot = false,
  label,
  path,
  scalarState,
  setScalarState,
  value
}: ObjectFieldProps) {
  const entries = Object.entries(value);

  return (
    <section
      className={isRoot ? styles.objectRoot : styles.objectCard}
      data-depth={depth}
    >
      {!isRoot ? (
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>object</span>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className={styles.emptyState}>Empty object</div>
      ) : (
        <div className={styles.objectGrid}>
          {entries.map(([key, childValue]) => (
            <JsonField
              depth={depth + 1}
              key={toPathKey([...path, key])}
              label={key}
              path={[...path, key]}
              scalarState={scalarState}
              setScalarState={setScalarState}
              value={childValue}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type ArrayFieldProps = Omit<JsonFieldProps, "value"> & {
  value: JsonArray;
};

function ArrayField({
  depth,
  isRoot = false,
  label,
  path,
  scalarState,
  setScalarState,
  value
}: ArrayFieldProps) {
  return (
    <section
      className={isRoot ? styles.objectRoot : styles.objectCard}
      data-depth={depth}
    >
      <div className={styles.fieldMeta}>
        <span className={styles.fieldLabel}>{isRoot ? "Root" : label}</span>
        <span className={styles.fieldType}>list</span>
      </div>

      {value.length === 0 ? (
        <div className={styles.emptyState}>Empty list</div>
      ) : (
        <div className={styles.objectGrid}>
          {value.map((childValue, index) => (
            <JsonField
              depth={depth + 1}
              key={toPathKey([...path, index])}
              label={`[${index}]`}
              path={[...path, index]}
              scalarState={scalarState}
              setScalarState={setScalarState}
              value={childValue}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type ScalarFieldProps = {
  label: string;
  path: AppPathSegment[];
  scalarState: ScalarState;
  setScalarState: Dispatch<SetStateAction<ScalarState>>;
  value: AppJsonPrimitive;
};

function ScalarField({
  label,
  path,
  scalarState,
  setScalarState,
  value
}: ScalarFieldProps) {
  const fieldKey = toPathKey(path);

  if (typeof value === "boolean") {
    const currentValue =
      typeof scalarState[fieldKey] === "boolean" ? Boolean(scalarState[fieldKey]) : value;

    return (
      <section className={styles.fieldCard}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>boolean</span>
        </div>

        <button
          aria-checked={currentValue}
          className={`${styles.switch} ${currentValue ? styles.switchActive : ""}`}
          onClick={() => {
            setScalarState((current) => ({
              ...current,
              [fieldKey]: !currentValue
            }));
          }}
          role="switch"
          type="button"
        >
          <span className={styles.switchTrack}>
            <span className={styles.switchThumb} />
          </span>
          <span className={styles.switchLabel}>
            {currentValue ? "Enabled" : "Disabled"}
          </span>
        </button>
      </section>
    );
  }

  if (typeof value === "number") {
    const currentValue =
      typeof scalarState[fieldKey] === "string" ? scalarState[fieldKey] : String(value);

    return (
      <section className={styles.fieldCard}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>number</span>
        </div>

        <label className={styles.controlStack}>
          <span className={styles.helperText}>Numeric input</span>
          <input
            className={styles.input}
            inputMode="decimal"
            onChange={(event) => {
              setScalarState((current) => ({
                ...current,
                [fieldKey]: event.currentTarget.value
              }));
            }}
            type="text"
            value={currentValue}
          />
        </label>
      </section>
    );
  }

  if (typeof value === "string") {
    const currentValue =
      typeof scalarState[fieldKey] === "string" ? scalarState[fieldKey] : value;

    return (
      <section className={styles.fieldCard}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>string</span>
        </div>

        <label className={styles.controlStack}>
          <span className={styles.helperText}>Text input</span>
          <input
            className={styles.input}
            onChange={(event) => {
              setScalarState((current) => ({
                ...current,
                [fieldKey]: event.currentTarget.value
              }));
            }}
            type="text"
            value={currentValue}
          />
        </label>
      </section>
    );
  }

  return (
    <section className={styles.fieldCard}>
      <div className={styles.fieldMeta}>
        <span className={styles.fieldLabel}>{label}</span>
        <span className={styles.fieldType}>null</span>
      </div>

      <div className={styles.nullBadge}>Null values render as read-only markers.</div>
    </section>
  );
}

type RenderedJsonFieldProps = {
  depth: number;
  isRoot?: boolean;
  label: string;
  onScalarChange?: (path: AppPathSegment[], value: AppJsonPrimitive) => void;
  path: AppPathSegment[];
  value: AppJsonValue;
};

function RenderedJsonField({
  depth,
  isRoot = false,
  label,
  onScalarChange,
  path,
  value
}: RenderedJsonFieldProps) {
  if (Array.isArray(value)) {
    return (
      <section
        className={isRoot ? styles.objectRoot : styles.objectCard}
        data-depth={depth}
      >
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{isRoot ? "Root" : label}</span>
          <span className={styles.fieldType}>list</span>
        </div>

        {value.length === 0 ? (
          <div className={styles.emptyState}>Empty list</div>
        ) : (
          <div className={styles.objectGrid}>
            {value.map((childValue, index) => (
              <RenderedJsonField
                depth={depth + 1}
                isRoot={false}
                key={toPathKey([...path, index])}
                label={`[${index}]`}
                onScalarChange={onScalarChange}
                path={[...path, index]}
                value={childValue}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  if (isJsonObject(value)) {
    const entries = Object.entries(value);

    return (
      <section
        className={isRoot ? styles.objectRoot : styles.objectCard}
        data-depth={depth}
      >
        {!isRoot ? (
          <div className={styles.fieldMeta}>
            <span className={styles.fieldLabel}>{label}</span>
            <span className={styles.fieldType}>object</span>
          </div>
        ) : null}

        {entries.length === 0 ? (
          <div className={styles.emptyState}>Empty object</div>
        ) : (
          <div className={styles.objectGrid}>
            {entries.map(([key, childValue]) => (
              <RenderedJsonField
                depth={depth + 1}
                key={toPathKey([...path, key])}
                label={key}
                onScalarChange={onScalarChange}
                path={[...path, key]}
                value={childValue}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <RenderedScalarField
      label={label}
      onScalarChange={onScalarChange}
      path={path}
      value={value}
    />
  );
}

function RenderedScalarField({
  label,
  onScalarChange,
  path,
  value
}: {
  label: string;
  onScalarChange?: (path: AppPathSegment[], value: AppJsonPrimitive) => void;
  path: AppPathSegment[];
  value: AppJsonPrimitive;
}) {
  if (typeof value === "boolean") {
    return (
      <section className={styles.fieldCard}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>boolean</span>
        </div>

        <button
          aria-checked={value}
          className={`${styles.switch} ${value ? styles.switchActive : ""}`}
          onClick={() => onScalarChange?.(path, !value)}
          role="switch"
          type="button"
        >
          <span className={styles.switchTrack}>
            <span className={styles.switchThumb} />
          </span>
          <span className={styles.switchLabel}>{value ? "Enabled" : "Disabled"}</span>
        </button>
      </section>
    );
  }

  if (typeof value === "number") {
    return (
      <section className={styles.fieldCard}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>number</span>
        </div>

        <label className={styles.controlStack}>
          <span className={styles.helperText}>Numeric input</span>
          <input
            className={styles.input}
            inputMode="decimal"
            onChange={(event) => {
              const parsed = Number(event.currentTarget.value);
              if (Number.isFinite(parsed)) {
                onScalarChange?.(path, parsed);
              }
            }}
            type="text"
            value={String(value)}
          />
        </label>
      </section>
    );
  }

  if (typeof value === "string") {
    return (
      <section className={styles.fieldCard}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel}>{label}</span>
          <span className={styles.fieldType}>string</span>
        </div>

        <label className={styles.controlStack}>
          <span className={styles.helperText}>Text input</span>
          <input
            className={styles.input}
            onChange={(event) => onScalarChange?.(path, event.currentTarget.value)}
            type="text"
            value={value}
          />
        </label>
      </section>
    );
  }

  return (
    <section className={styles.fieldCard}>
      <div className={styles.fieldMeta}>
        <span className={styles.fieldLabel}>{label}</span>
        <span className={styles.fieldType}>null</span>
      </div>

      <div className={styles.nullBadge}>Null values render as read-only markers.</div>
    </section>
  );
}

function collectScalarDefaults(value: AppJsonValue, path: AppPathSegment[] = []): ScalarState {
  if (Array.isArray(value)) {
    return value.reduce<ScalarState>((state, childValue, index) => {
      Object.assign(state, collectScalarDefaults(childValue, [...path, index]));
      return state;
    }, {});
  }

  if (isJsonObject(value)) {
    return Object.entries(value).reduce<ScalarState>((state, [key, childValue]) => {
      Object.assign(state, collectScalarDefaults(childValue, [...path, key]));
      return state;
    }, {});
  }

  if (typeof value === "number") {
    return { [toPathKey(path)]: String(value) };
  }

  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return { [toPathKey(path)]: value };
  }

  return {};
}

function materializeValue(
  schema: AppJsonValue,
  path: AppPathSegment[],
  scalarState: ScalarState
): AppJsonValue {
  if (Array.isArray(schema)) {
    return schema.map((childValue, index) =>
      materializeValue(childValue, [...path, index], scalarState)
    );
  }

  if (isJsonObject(schema)) {
    return Object.entries(schema).reduce<JsonObject>((state, [key, childValue]) => {
      state[key] = materializeValue(childValue, [...path, key], scalarState);
      return state;
    }, {});
  }

  const fieldKey = toPathKey(path);

  if (typeof schema === "number") {
    const rawValue = scalarState[fieldKey];
    const parsedValue = typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
    return Number.isFinite(parsedValue) ? parsedValue : schema;
  }

  if (typeof schema === "string") {
    return typeof scalarState[fieldKey] === "string" ? scalarState[fieldKey] : schema;
  }

  if (typeof schema === "boolean") {
    return typeof scalarState[fieldKey] === "boolean" ? scalarState[fieldKey] : schema;
  }

  return null;
}

function describeJsonValue(value: AppJsonValue): string {
  if (Array.isArray(value)) {
    return `list · ${value.length} item${value.length === 1 ? "" : "s"}`;
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value);

    if (!keys.length) {
      return "object · empty";
    }

    const preview = keys.slice(0, 4).join(", ");
    return keys.length > 4 ? `object · ${preview} +${keys.length - 4} more` : `object · ${preview}`;
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function parseJson5(source: string): AppJsonValue {
  const parsedValue = JSON5.parse(source) as unknown;

  if (!isAppJsonValue(parsedValue)) {
    throw new Error(
      "Only JSON-compatible values are supported: strings, finite numbers, booleans, null, arrays, and objects."
    );
  }

  return parsedValue;
}

function isJsonObject(value: AppJsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPathKey(path: AppPathSegment[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path
    .map((segment) =>
      typeof segment === "number" ? `[${segment}]` : encodeURIComponent(segment)
    )
    .join(".");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to parse JSON5 input.";
}
