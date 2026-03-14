import type { ProceduralAvatar } from "@social/shared";

interface AvatarRenderOptions {
  avatar: ProceduralAvatar;
  seed: string;
  size: number;
}

interface AvatarRenderer {
  render: (options: AvatarRenderOptions) => string;
}

const avatarCache = new Map<string, string>();
let renderer: AvatarRenderer | null | undefined;

export function getProceduralAvatarDataUrl(
  options: AvatarRenderOptions
): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cacheKey = [
    options.seed,
    options.size,
    options.avatar.pattern,
    options.avatar.base,
    options.avatar.accent,
    options.avatar.highlight
  ].join(":");
  const cached = avatarCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  renderer ??= createAvatarRenderer();
  if (!renderer) {
    return null;
  }

  try {
    const dataUrl = renderer.render(options);
    avatarCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

function createAvatarRenderer(): AvatarRenderer | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    stencil: false
  });

  if (!gl) {
    return null;
  }

  const vertexShaderSource = `#version 300 es
  precision highp float;
  in vec2 a_position;
  out vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }`;

  const fragmentShaderSource = `#version 300 es
  precision highp float;

  in vec2 v_uv;
  out vec4 outColor;

  uniform float u_seed;
  uniform float u_variant;
  uniform vec3 u_colorA;
  uniform vec3 u_colorB;
  uniform vec3 u_colorC;
  uniform vec3 u_colorD;
  uniform vec2 u_point0;
  uniform vec2 u_point1;
  uniform vec2 u_point2;
  uniform vec2 u_point3;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7)) + u_seed * 0.173) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  vec3 gradientMesh(vec2 p) {
    float w0 = 1.0 / (0.05 + pow(distance(p, u_point0), 1.45));
    float w1 = 1.0 / (0.05 + pow(distance(p, u_point1), 1.45));
    float w2 = 1.0 / (0.05 + pow(distance(p, u_point2), 1.45));
    float w3 = 1.0 / (0.05 + pow(distance(p, u_point3), 1.45));
    float sum = w0 + w1 + w2 + w3;

    return (
      u_colorA * w0 +
      u_colorB * w1 +
      u_colorC * w2 +
      u_colorD * w3
    ) / sum;
  }

  mat2 rotate2d(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
  }

  void main() {
    vec2 uv = v_uv;
    vec2 centered = uv * 2.0 - 1.0;
    float radius = length(centered);
    float orb = 1.0 - smoothstep(0.86, 1.0, radius);

    if (orb <= 0.0) {
      outColor = vec4(0.0);
      return;
    }

    float z = sqrt(max(0.0, 1.0 - radius * radius));
    vec3 normal = normalize(vec3(centered * vec2(1.04, 0.98), z));
    float angle = atan(centered.y, centered.x);
    float seedPhase = u_seed * 0.013 + u_variant * 0.37;

    vec2 flowUvA = rotate2d(0.45 + u_variant * 0.08) * centered * 2.6;
    vec2 flowUvB = rotate2d(-0.72 - u_variant * 0.05) * centered * 3.4;
    float flowA = noise(flowUvA + vec2(seedPhase, -seedPhase * 0.7));
    float flowB = noise(flowUvB + vec2(-seedPhase * 0.6, seedPhase * 0.9));
    float wave = 0.5 + 0.5 * sin(angle * (5.0 + u_variant * 0.45) + flowA * 4.8 + radius * 8.0 + seedPhase * 11.0);
    float ripple = 0.5 + 0.5 * cos((flowB * 3.4 + normal.y * 2.1 - normal.x * 1.6) * 3.2 + seedPhase * 7.0);

    vec2 meshUv = uv + normal.xy * 0.11;
    vec3 baseColor = gradientMesh(meshUv);
    vec3 iridescence = mix(
      mix(u_colorA, u_colorB, wave),
      mix(u_colorC, u_colorD, ripple),
      0.56
    );
    vec3 color = mix(baseColor, iridescence, 0.52);

    float coreGlow = pow(max(normal.z, 0.0), 1.8);
    float fresnel = pow(1.0 - max(normal.z, 0.0), 2.7);
    float highlight = pow(max(dot(normal, normalize(vec3(-0.58, 0.64, 1.0))), 0.0), 24.0);
    float secondaryHighlight = pow(max(dot(normal, normalize(vec3(0.46, -0.22, 0.95))), 0.0), 12.0);

    color *= 0.62 + coreGlow * 0.92;
    color += mix(u_colorC, vec3(1.0), 0.45) * highlight * 0.7;
    color += mix(u_colorB, vec3(1.0), 0.28) * secondaryHighlight * 0.22;
    color += mix(u_colorD, u_colorB, 0.55) * fresnel * 0.48;

    float innerFog = 1.0 - smoothstep(0.0, 0.78, radius);
    color += innerFog * 0.1 * mix(u_colorA, u_colorC, 0.5);

    float grain = hash(gl_FragCoord.xy + u_seed * 41.0) - 0.5;
    color += grain * 0.035;

    color = mix(vec3(0.045, 0.048, 0.06), color, orb);
    outColor = vec4(clamp(color, 0.0, 1.0), orb);
  }`;

  const program = createProgram(gl, vertexShaderSource, fragmentShaderSource);
  if (!program) {
    return null;
  }

  const positionBuffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  const positionLocation = gl.getAttribLocation(program, "a_position");

  if (!positionBuffer || !vao || positionLocation < 0) {
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const uniforms = {
    seed: getUniformLocation(gl, program, "u_seed"),
    variant: getUniformLocation(gl, program, "u_variant"),
    colorA: getUniformLocation(gl, program, "u_colorA"),
    colorB: getUniformLocation(gl, program, "u_colorB"),
    colorC: getUniformLocation(gl, program, "u_colorC"),
    colorD: getUniformLocation(gl, program, "u_colorD"),
    point0: getUniformLocation(gl, program, "u_point0"),
    point1: getUniformLocation(gl, program, "u_point1"),
    point2: getUniformLocation(gl, program, "u_point2"),
    point3: getUniformLocation(gl, program, "u_point3")
  };

  return {
    render({ avatar, seed, size }) {
      const seedHash = hashString(`${seed}:${avatar.pattern}`);
      const random = createSeededRandom(seedHash);
      const palette = getAvatarPalette(avatar);
      const mesh = createGradientMesh(avatar.pattern, random);

      canvas.width = size;
      canvas.height = size;

      gl.viewport(0, 0, size, size);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform1f(uniforms.seed, seedHash % 10_000);
      gl.uniform1f(uniforms.variant, getPatternVariant(avatar.pattern));
      gl.uniform3fv(uniforms.colorA, palette.base);
      gl.uniform3fv(uniforms.colorB, palette.accent);
      gl.uniform3fv(uniforms.colorC, palette.highlight);
      gl.uniform3fv(uniforms.colorD, palette.shadow);
      gl.uniform2fv(uniforms.point0, mesh.point0);
      gl.uniform2fv(uniforms.point1, mesh.point1);
      gl.uniform2fv(uniforms.point2, mesh.point2);
      gl.uniform2fv(uniforms.point3, mesh.point3);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindVertexArray(null);

      return canvas.toDataURL("image/png");
    }
  };
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  if (!vertexShader || !fragmentShader) {
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);

  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function getUniformLocation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);

  if (!location) {
    throw new Error(`Missing avatar shader uniform: ${name}`);
  }

  return location;
}

function getAvatarPalette(avatar: ProceduralAvatar) {
  const base = parseHslColor(avatar.base);
  const accent = parseHslColor(avatar.accent);
  const highlight = parseHslColor(avatar.highlight);
  const bridge = mixRgb(base, accent, 0.38);
  const shadow = darkenRgb(saturateRgb(bridge, 1.18), 0.42);

  return { base, accent, highlight, shadow };
}

function createGradientMesh(
  pattern: ProceduralAvatar["pattern"],
  random: () => number
) {
  const point0: [number, number] = [0.18 + random() * 0.18, 0.16 + random() * 0.2];
  const point1: [number, number] = [0.72 - random() * 0.12, 0.16 + random() * 0.2];
  const point2: [number, number] = [0.2 + random() * 0.16, 0.72 - random() * 0.12];
  const point3: [number, number] = [0.7 - random() * 0.14, 0.72 - random() * 0.12];

  switch (pattern) {
    case "bands":
      point0[1] -= 0.06;
      point1[1] += 0.04;
      point2[1] -= 0.02;
      break;
    case "bloom":
      point0[0] -= 0.04;
      point1[0] += 0.02;
      point2[0] += 0.03;
      point3[0] -= 0.02;
      break;
    case "grid":
      point0[0] -= 0.05;
      point0[1] -= 0.03;
      point3[0] += 0.03;
      point3[1] += 0.02;
      break;
    case "orbit":
      point1[0] += 0.05;
      point2[0] -= 0.03;
      point2[1] += 0.03;
      break;
    case "slice":
      point0[0] += 0.05;
      point1[1] -= 0.04;
      point3[1] += 0.04;
      break;
  }

  return { point0, point1, point2, point3 };
}

function getPatternVariant(pattern: ProceduralAvatar["pattern"]): number {
  switch (pattern) {
    case "bands":
      return 0;
    case "bloom":
      return 1;
    case "grid":
      return 2;
    case "orbit":
      return 3;
    case "slice":
      return 4;
  }
}

function parseHslColor(value: string): [number, number, number] {
  const match = value.match(
    /hsl\(([-\d.]+)\s+([-\d.]+)%\s+([-\d.]+)%\)/
  );

  if (!match) {
    return [0.5, 0.5, 0.5];
  }

  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  return hslToRgb(hue, saturation, lightness);
}

function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number
): [number, number, number] {
  const normalizedHue = (((hue % 360) + 360) % 360) / 360;

  if (saturation === 0) {
    return [lightness, lightness, lightness];
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return [
    hueToRgb(p, q, normalizedHue + 1 / 3),
    hueToRgb(p, q, normalizedHue),
    hueToRgb(p, q, normalizedHue - 1 / 3)
  ];
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;

  if (next < 0) {
    next += 1;
  }
  if (next > 1) {
    next -= 1;
  }
  if (next < 1 / 6) {
    return p + (q - p) * 6 * next;
  }
  if (next < 1 / 2) {
    return q;
  }
  if (next < 2 / 3) {
    return p + (q - p) * (2 / 3 - next) * 6;
  }

  return p;
}

function mixRgb(
  left: [number, number, number],
  right: [number, number, number],
  amount: number
): [number, number, number] {
  return [
    left[0] + (right[0] - left[0]) * amount,
    left[1] + (right[1] - left[1]) * amount,
    left[2] + (right[2] - left[2]) * amount
  ];
}

function darkenRgb(
  color: [number, number, number],
  amount: number
): [number, number, number] {
  return [
    clamp01(color[0] * (1 - amount)),
    clamp01(color[1] * (1 - amount)),
    clamp01(color[2] * (1 - amount))
  ];
}

function saturateRgb(
  color: [number, number, number],
  amount: number
): [number, number, number] {
  const average = (color[0] + color[1] + color[2]) / 3;

  return [
    clamp01(average + (color[0] - average) * amount),
    clamp01(average + (color[1] - average) * amount),
    clamp01(average + (color[2] - average) * amount)
  ];
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }

  return value;
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;

  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
