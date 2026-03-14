"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { defineCatalog, type Spec } from "@json-render/core";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { shadcnComponents } from "@json-render/shadcn";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import JSON5 from "json5";
import { RiDeleteBinLine } from "react-icons/ri";
import { z } from "zod";

import {
  type AppJsonObject,
  type AppJsonValue,
  type AppPathSegment,
  collectStreamingJsonCandidates,
  isAppJsonValue,
  looksLikeJsonRenderSpec,
  validateJsonRenderSpecShape
} from "@social/shared";

import styles from "./json5-form-editor.module.css";

type Json5EditorViewMode = "split" | "editor" | "form";
type Json5SourceValidation = {
  error: string | null;
  mode: "legacy" | "spec";
  recovered: boolean;
  spec: Spec | null;
  value: AppJsonValue | null;
};

const ROOT_STATE_SEGMENT = "root";
const ROOT_STATE_PATH = `/${ROOT_STATE_SEGMENT}`;

const customComponentDefinitions = {
  IconButton: {
    props: z.object({
      icon: z.enum(["trash"]),
      label: z.string(),
      variant: z.enum(["ghost", "danger"]).nullable(),
      disabled: z.boolean().nullable()
    }),
    events: ["press"],
    description: "Compact icon-only button for row actions such as delete.",
    example: {
      icon: "trash",
      label: "Delete item",
      variant: "danger"
    }
  }
} as const;

const jsonRenderCatalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
    ...customComponentDefinitions
  },
  actions: {}
});

const { registry } = defineRegistry(jsonRenderCatalog, {
  components: {
    ...shadcnComponents,
    IconButton: ({ props, emit }) => {
      const variantClassName =
        props.variant === "danger"
          ? "border-red-500/25 bg-red-500/10 text-red-100 hover:bg-red-500/18 hover:text-white"
          : "border-white/10 bg-white/5 text-[rgba(239,236,230,0.76)] hover:bg-white/10 hover:text-white";

      return (
        <button
          aria-label={props.label}
          className={[
            "inline-flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors outline-none",
            "focus-visible:ring-2 focus-visible:ring-white/20 disabled:pointer-events-none disabled:opacity-50",
            variantClassName
          ].join(" ")}
          disabled={props.disabled ?? false}
          onClick={() => emit("press")}
          title={props.label}
          type="button"
        >
          <RiDeleteBinLine aria-hidden="true" className="text-base" />
        </button>
      );
    }
  }
});

const DEFAULT_JSON_RENDER_SPEC: Spec = {
  root: "card",
  state: {
    form: {
      name: "",
      email: "",
      message: ""
    }
  },
  elements: {
    card: {
      type: "Card",
      props: {
        title: "Contact Us",
        description: "Send us a message.",
        maxWidth: "md",
        centered: false
      },
      children: ["stack"]
    },
    stack: {
      type: "Stack",
      props: {
        direction: "vertical",
        gap: "md",
        align: "stretch",
        justify: "start"
      },
      children: ["name", "email", "message", "submit"]
    },
    name: {
      type: "Input",
      props: {
        label: "Name",
        name: "name",
        type: "text",
        placeholder: "Jane Doe",
        value: {
          $bindState: "/form/name"
        },
        validateOn: "blur",
        checks: [
          {
            type: "required",
            message: "Name is required"
          }
        ],
        disabled: false
      }
    },
    email: {
      type: "Input",
      props: {
        label: "Email",
        name: "email",
        type: "email",
        placeholder: "jane@example.com",
        value: {
          $bindState: "/form/email"
        },
        validateOn: "blur",
        checks: [
          {
            type: "required",
            message: "Email is required"
          },
          {
            type: "email",
            message: "Please enter a valid email"
          }
        ],
        disabled: false
      }
    },
    message: {
      type: "Textarea",
      props: {
        label: "Message",
        name: "message",
        placeholder: "Tell us what you need.",
        rows: 5,
        value: {
          $bindState: "/form/message"
        },
        validateOn: "blur",
        checks: [
          {
            type: "required",
            message: "Message is required"
          }
        ],
        disabled: false
      }
    },
    submit: {
      type: "Button",
      props: {
        label: "Send Message",
        variant: "primary",
        disabled: false
      },
      on: {
        press: {
          action: "validateForm",
          params: {
            statePath: "/formValidation"
          }
        }
      }
    }
  }
};

export const DEFAULT_JSON5_SOURCE = JSON.stringify(DEFAULT_JSON_RENDER_SPEC, null, 2);

type Json5WorkbenchProps = {
  actions?: ReactNode;
  compact?: boolean;
  onSourceChange: (source: string) => void;
  onValueChange?: (path: AppPathSegment[], value: AppJsonValue) => void;
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
  const validation = useMemo(() => validateJson5Source(source), [source]);
  const [previewValue, setPreviewValue] = useState<AppJsonValue>(
    validation.value ?? {}
  );

  useEffect(() => {
    setPreviewValue(validation.value !== null ? cloneAppJsonValue(validation.value) : {});
  }, [source, validation.value]);

  return (
    <Json5Workbench
      compact={compact}
      onSourceChange={onSourceChange}
      onValueChange={(path, value) => {
        setPreviewValue((current) => applyAppValueAtPath(current, path, value));
      }}
      parseError={validation.error}
      source={source}
      value={previewValue}
      viewMode={viewMode}
    />
  );
}

export function Json5Workbench({
  actions,
  compact = false,
  onSourceChange,
  onValueChange,
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
        <JsonValueWorkbench
          onValueChange={onValueChange}
          source={source}
          value={value}
        />
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
          {parseError ? "Invalid" : "Live"}
        </span>
      </div>

      <p className={styles.panelCopy}>
        Write a `json-render` spec here. JSON5 features like comments, single
        quotes, and trailing commas are supported.
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
              Fix the source before saving it into the shared app.
            </p>
          </>
        ) : (
          <p className={styles.statusHint}>
            {sourceHint ??
              "Edit the spec here or use the live render to exercise its state on the right."}
          </p>
        )}
      </div>

      {actions ? <div className={styles.editorActions}>{actions}</div> : null}
    </section>
  );
}

export function JsonValueWorkbench({
  onValueChange,
  source,
  value
}: {
  onValueChange?: (path: AppPathSegment[], value: AppJsonValue) => void;
  source: string;
  value: AppJsonValue;
}) {
  const surface = useResolvedJsonRenderSurface(source, value);

  return (
    <div className={styles.rightRail}>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelEyebrow}>Render</p>
            <h2 className={styles.panelTitle}>Live UI</h2>
          </div>
          <span className={styles.modeBadge}>
            {surface.validation.mode === "spec" ? "json-render" : "legacy"}
          </span>
        </div>

        {surface.validation.mode === "legacy" && !surface.validation.error ? (
          <p className={styles.panelCopy}>
            Legacy JSON source detected. Rendering it in compatibility mode.
          </p>
        ) : null}

        <div className={styles.formSurface}>
          <JsonRenderSurfaceBody
            initialState={surface.initialState}
            onValueChange={onValueChange}
            providerKey={surface.providerKey}
            renderSpec={surface.renderSpec}
            validation={surface.validation}
          />
        </div>
      </section>
    </div>
  );
}

export function JsonRenderSurface({
  onValueChange,
  source,
  value,
  variant = "panel"
}: {
  onValueChange?: (path: AppPathSegment[], value: AppJsonValue) => void;
  source: string;
  value: AppJsonValue;
  variant?: "panel" | "embed";
}) {
  const surface = useResolvedJsonRenderSurface(source, value);

  return (
    <JsonRenderSurfaceBody
      initialState={surface.initialState}
      onValueChange={onValueChange}
      providerKey={surface.providerKey}
      renderSpec={surface.renderSpec}
      validation={surface.validation}
      variant={variant}
    />
  );
}

function useResolvedJsonRenderSurface(
  source: string,
  value: AppJsonValue
): {
  initialState: AppJsonObject;
  providerKey: string;
  renderSpec: Spec | null;
  validation: Json5SourceValidation;
} {
  const validation = useMemo(() => validateJson5Source(source), [source]);

  const renderSpec = useMemo(() => {
    if (validation.error) {
      return null;
    }

    if (validation.mode === "legacy") {
      return buildLegacyRenderSpec(value);
    }

    return validation.spec;
  }, [validation, value]);

  const initialState = useMemo<AppJsonObject>(() => {
    if (validation.mode === "legacy") {
      return {
        [ROOT_STATE_SEGMENT]: cloneAppJsonValue(value)
      };
    }

    return isJsonObject(value) ? (cloneAppJsonValue(value) as AppJsonObject) : {};
  }, [validation.mode, value]);

  const providerKey = useMemo(
    () => `${validation.mode}:${source}`,
    [validation.mode, source]
  );

  return {
    initialState,
    providerKey,
    renderSpec,
    validation
  };
}

function JsonRenderSurfaceBody({
  initialState,
  onValueChange,
  providerKey,
  renderSpec,
  validation,
  variant = "panel"
}: {
  initialState: AppJsonObject;
  onValueChange?: (path: AppPathSegment[], value: AppJsonValue) => void;
  providerKey: string;
  renderSpec: Spec | null;
  validation: Json5SourceValidation;
  variant?: "panel" | "embed";
}) {
  if (!renderSpec) {
    return (
      <div
        className={`${styles.renderSurfaceFallback} ${
          variant === "embed" ? styles.renderSurfaceFallbackEmbed : ""
        }`}
      >
        <p className={styles.errorText}>
          {validation.error ?? "Unable to render this source."}
        </p>
      </div>
    );
  }

  return (
    <>
      {variant === "panel" && validation.recovered && validation.error ? (
        <p className={styles.statusHint}>
          Streaming preview repaired unfinished JSON in memory. The raw source is
          still incomplete.
        </p>
      ) : null}
      <div
        className={`${styles.renderCanvas} ${
          variant === "embed" ? styles.renderCanvasEmbed : ""
        } json-render-theme`}
      >
        <JSONUIProvider
          initialState={initialState}
          key={providerKey}
          onStateChange={(changes) => {
            for (const change of changes) {
              const nextPath =
                validation.mode === "legacy"
                  ? fromLegacyStatePath(change.path)
                  : fromJsonPointer(change.path);

              if (!nextPath || change.value === undefined || !isAppJsonValue(change.value)) {
                continue;
              }

              onValueChange?.(nextPath, change.value);
            }
          }}
          registry={registry}
        >
          <Renderer registry={registry} spec={renderSpec} />
        </JSONUIProvider>
      </div>
    </>
  );
}

export function validateJson5Source(source: string): Json5SourceValidation {
  try {
    return {
      ...validateParsedSource(parseJson5(source)),
      recovered: false
    };
  } catch (error) {
    const rawError = getErrorMessage(error);
    const sourceLooksLikeSpec = /(^|[\s{,])["']?(root|elements|state)["']?\s*:/.test(
      source
    );

    for (const candidate of collectStreamingJsonCandidates(source)) {
      try {
        const recovered = validateParsedSource(parseJson5(candidate));

        if (sourceLooksLikeSpec && recovered.mode !== "spec") {
          continue;
        }

        return {
          ...recovered,
          error: rawError,
          recovered: true
        };
      } catch {
        continue;
      }
    }

    return {
      error: rawError,
      mode: "legacy",
      recovered: false,
      spec: null,
      value: null
    };
  }
}

export function summarizeJson5Shape(source: string): string {
  try {
    const validation = validateParsedSource(parseJson5(source));

    if (validation.mode === "spec") {
      return "json-render spec";
    }

    return describeJsonValue(validation.value ?? {});
  } catch {
    return "Invalid JSON5 source";
  }
}

function validateParsedSource(value: AppJsonValue): Json5SourceValidation {
  if (!looksLikeJsonRenderSpec(value)) {
    return {
      error: null,
      mode: "legacy",
      recovered: false,
      spec: buildLegacyRenderSpec(value),
      value
    };
  }

  const validation = validateJsonRenderSpecShape(value);
  if (!validation.valid) {
    return {
      error: validation.issues.join(" "),
      mode: "spec",
      recovered: false,
      spec: null,
      value: null
    };
  }

  if (!isJsonObject(value)) {
    return {
      error: "Spec must be a JSON object.",
      mode: "spec",
      recovered: false,
      spec: null,
      value: null
    };
  }

  const stateValue = value.state;
  if (stateValue !== undefined && !isJsonObject(stateValue)) {
    return {
      error: 'Spec field "state" must be an object when present.',
      mode: "spec",
      recovered: false,
      spec: null,
      value: null
    };
  }

  return {
    error: null,
    mode: "spec",
    recovered: false,
    spec: value as unknown as Spec,
    value: isJsonObject(stateValue) ? stateValue : {}
  };
}

function buildLegacyRenderSpec(value: AppJsonValue): Spec {
  const elements: Spec["elements"] = {};
  let nextElementId = 0;

  function addElement(
    type: string,
    props: Record<string, unknown>,
    children?: string[]
  ): string {
    const elementId = `legacy-${nextElementId++}`;
    elements[elementId] = children ? { type, props, children } : { type, props };
    return elementId;
  }

  function addText(text: string, variant: "body" | "muted" = "body"): string {
    return addElement("Text", {
      text,
      variant
    });
  }

  function buildField(
    currentValue: AppJsonValue,
    label: string,
    path: AppPathSegment[]
  ): string {
    if (Array.isArray(currentValue)) {
      const children = currentValue.map((childValue, index) =>
        buildField(childValue, `[${index}]`, [...path, index])
      );

      return addElement(
        "Card",
        {
          title: label,
          description: currentValue.length ? "List" : "Empty list",
          maxWidth: "full",
          centered: false
        },
        [
          addElement(
            "Stack",
            {
              direction: "vertical",
              gap: "md",
              align: "stretch",
              justify: "start"
            },
            children.length ? children : [addText("Empty list", "muted")]
          )
        ]
      );
    }

    if (isJsonObject(currentValue)) {
      const entries = Object.entries(currentValue);
      const children = entries.map(([key, childValue]) =>
        buildField(childValue, key, [...path, key])
      );

      return addElement(
        "Card",
        {
          title: label,
          description: entries.length ? "Object" : "Empty object",
          maxWidth: "full",
          centered: false
        },
        [
          addElement(
            "Stack",
            {
              direction: "vertical",
              gap: "md",
              align: "stretch",
              justify: "start"
            },
            children.length ? children : [addText("Empty object", "muted")]
          )
        ]
      );
    }

    const statePath = toLegacyStatePath(path);
    const fieldName = path.length ? toPathKey(path) : "root";

    if (typeof currentValue === "string") {
      return addElement("Input", {
        label,
        name: fieldName,
        type: "text",
        value: { $bindState: statePath },
        disabled: false
      });
    }

    if (typeof currentValue === "number") {
      return addElement("Input", {
        label,
        name: fieldName,
        type: "number",
        value: { $bindState: statePath },
        disabled: false
      });
    }

    if (typeof currentValue === "boolean") {
      return addElement("Switch", {
        label,
        name: fieldName,
        checked: { $bindState: statePath },
        disabled: false
      });
    }

    return addText(`${label}: null`, "muted");
  }

  const rootChildren =
    Array.isArray(value)
      ? value.length
        ? value.map((childValue, index) => buildField(childValue, `[${index}]`, [index]))
        : [addText("Empty list", "muted")]
      : isJsonObject(value)
        ? Object.entries(value).length
          ? Object.entries(value).map(([key, childValue]) =>
              buildField(childValue, key, [key])
            )
          : [addText("Empty object", "muted")]
        : [buildField(value, "Root", [])];

  const root = addElement("Stack", {
    direction: "vertical",
    gap: "md",
    align: "stretch",
    justify: "start"
  }, rootChildren);

  return {
    root,
    elements
  };
}

function applyAppValueAtPath(
  value: AppJsonValue,
  path: AppPathSegment[],
  nextValue: AppJsonValue
): AppJsonValue {
  const clonedValue = cloneAppJsonValue(value);

  if (path.length === 0) {
    return cloneAppJsonValue(nextValue);
  }

  const rootContainer = isJsonObject(clonedValue) || Array.isArray(clonedValue)
    ? clonedValue
    : {};
  let target: AppJsonValue = rootContainer;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;

    if (typeof segment === "number") {
      if (!Array.isArray(target)) {
        return clonedValue;
      }

      if (!isContainerValue(target[segment])) {
        target[segment] = typeof nextSegment === "number" ? [] : {};
      }

      target = target[segment] as AppJsonValue;
      continue;
    }

    if (!isJsonObject(target)) {
      return clonedValue;
    }

    if (!isContainerValue(target[segment])) {
      target[segment] = typeof nextSegment === "number" ? [] : {};
    }

    target = target[segment];
  }

  const lastSegment = path[path.length - 1]!;

  if (typeof lastSegment === "number") {
    if (!Array.isArray(target)) {
      return clonedValue;
    }

    target[lastSegment] = cloneAppJsonValue(nextValue);
    return rootContainer;
  }

  if (!isJsonObject(target)) {
    return clonedValue;
  }

  target[lastSegment] = cloneAppJsonValue(nextValue);
  return rootContainer;
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

function cloneAppJsonValue(value: AppJsonValue): AppJsonValue {
  return JSON.parse(JSON.stringify(value)) as AppJsonValue;
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

function fromJsonPointer(path: string): AppPathSegment[] | null {
  if (path === "" || path === "/") {
    return [];
  }

  if (!path.startsWith("/")) {
    return null;
  }

  return path
    .slice(1)
    .split("/")
    .map((segment) => decodePathSegment(segment))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

function fromLegacyStatePath(path: string): AppPathSegment[] | null {
  const nextPath = fromJsonPointer(path);

  if (!nextPath || nextPath[0] !== ROOT_STATE_SEGMENT) {
    return null;
  }

  return nextPath.slice(1);
}

function toLegacyStatePath(path: AppPathSegment[]): string {
  if (!path.length) {
    return ROOT_STATE_PATH;
  }

  return `${ROOT_STATE_PATH}/${path
    .map((segment) => encodeURIComponent(String(segment)))
    .join("/")}`;
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

function decodePathSegment(segment: string): string {
  return decodeURIComponent(segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to parse JSON5 input.";
}

function isContainerValue(value: AppJsonValue | undefined): value is AppJsonObject | AppJsonValue[] {
  return isJsonObject(value) || Array.isArray(value);
}

function isJsonObject(value: AppJsonValue | unknown): value is AppJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
