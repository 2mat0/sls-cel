import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: SLS Cel Rocket
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createSLSCelRocketModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "SLS Cel Rocket";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["orange"] = createSculptMaterial(
    "orange",
    {"id": "orange", "name": "orange", "type": "toon", "shaderModel": "MeshToonMaterial; three-band gradient, inverted hull ink outline", "baseColor": "#ed7d27", "color": "#ed7d27", "albedo": {"dominant": "#ed7d27", "secondary": ["#6E614B", "#A08F70"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#8A7A5F", "#6E614B", "#A08F70"], "pattern": "graphic panels", "amplitude": 0.15, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.15, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "orange-accent", "region": "seams", "color": "#292638", "roughness": 0.95, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Art-directed flat albedo for requested cel shading. No photographic surface matching."},
    options
  );
  materialMap["ivory"] = createSculptMaterial(
    "ivory",
    {"id": "ivory", "name": "ivory", "type": "toon", "shaderModel": "MeshToonMaterial; three-band gradient, inverted hull ink outline", "baseColor": "#fff2ce", "color": "#fff2ce", "albedo": {"dominant": "#fff2ce", "secondary": ["#6E614B", "#A08F70"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#8A7A5F", "#6E614B", "#A08F70"], "pattern": "graphic panels", "amplitude": 0.15, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.15, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "ivory-accent", "region": "seams", "color": "#292638", "roughness": 0.95, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Art-directed flat albedo for requested cel shading. No photographic surface matching."},
    options
  );
  materialMap["ink"] = createSculptMaterial(
    "ink",
    {"id": "ink", "name": "ink", "type": "toon", "shaderModel": "MeshToonMaterial; three-band gradient, inverted hull ink outline", "baseColor": "#1b2030", "color": "#1b2030", "albedo": {"dominant": "#1b2030", "secondary": ["#6E614B", "#A08F70"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#8A7A5F", "#6E614B", "#A08F70"], "pattern": "graphic panels", "amplitude": 0.15, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.15, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "ink-accent", "region": "seams", "color": "#292638", "roughness": 0.95, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Art-directed flat albedo for requested cel shading. No photographic surface matching."},
    options
  );
  materialMap["red"] = createSculptMaterial(
    "red",
    {"id": "red", "name": "red", "type": "toon", "shaderModel": "MeshToonMaterial; three-band gradient, inverted hull ink outline", "baseColor": "#ef4f43", "color": "#ef4f43", "albedo": {"dominant": "#ef4f43", "secondary": ["#6E614B", "#A08F70"], "samplingNotes": "Use image-observed local color zones, not a single averaged color."}, "colorVariation": {"palette": ["#8A7A5F", "#6E614B", "#A08F70"], "pattern": "graphic panels", "amplitude": 0.15, "heightCorrelation": 0.3}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.42, "role": "broad color and height breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.22, "role": "ridges, pores, grain, dents, or equivalent visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "highlight breakup visible under grazing light"}], "roughness": {"base": 0.75, "variation": 0.15, "map": "independent-procedural-field", "localResponse": "higher roughness in cavities, lower roughness on worn edges"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 24.0, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "red-accent", "region": "seams", "color": "#292638", "roughness": 0.95, "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Art-directed flat albedo for requested cel shading. No photographic surface matching."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "root", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "root-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "root-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "root", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "root-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);
  const socket_root_root_socket_0 = new THREE.Object3D();
  socket_root_root_socket_0.name = "root-socket";
  socket_root_root_socket_0.position.set(0.0, 0.0, 0.0);
  socket_root_root_socket_0.rotation.set(0, 0, 0);
  socket_root_root_socket_0.userData.socket = {"id": "root-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_root_0.add(socket_root_root_socket_0);
  sockets["root:root-socket"] = socket_root_root_socket_0;

  const attachment_core_1 = {"parentSocket": "root-socket", "localStart": [0, -5.0, 0], "localEnd": [0, 5.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_core_1 = makeAttachmentEndpoint(attachment_core_1);
  const node_core_1 = new THREE.Group();
  node_core_1.name = "core__pivot";
  node_core_1.scale.set(1, 1, 1);
  if (endpoint_core_1) {
    node_core_1.position.copy(endpoint_core_1.start);
    node_core_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_core_1.position.set(0.0, 6.3, 0.0);
    node_core_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_core_1.userData.sculptComponent = {"id": "core", "name": "core", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -5.0, 0], "localEnd": [0, 5.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 2.7, "height": 10, "depth": 2.7, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 6.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "core-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "orange", "materialLayers": ["orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "feed-line", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "intertank-ribs", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 125, 39, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_core_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "core-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_core_1);
  nodes["core"] = node_core_1;
  const mesh_core_1Geometry = endpoint_core_1
    ? new THREE.CylinderGeometry(endpoint_core_1.endRadius, endpoint_core_1.baseRadius, endpoint_core_1.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_core_1) {
    mesh_core_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_core_1 = new THREE.Mesh(
    mesh_core_1Geometry,
    materialMap["orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_core_1.name = "core";
  if (endpoint_core_1) {
    mesh_core_1.position.copy(endpoint_core_1.midpoint);
    mesh_core_1.quaternion.copy(endpoint_core_1.quaternion);
  }
  mesh_core_1.castShadow = options.castShadow ?? true;
  mesh_core_1.receiveShadow = options.receiveShadow ?? true;
  mesh_core_1.userData.sculptComponent = {"id": "core", "name": "core", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -5.0, 0], "localEnd": [0, 5.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 2.7, "height": 10, "depth": 2.7, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 6.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "core-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "orange", "materialLayers": ["orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "feed-line", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "intertank-ribs", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 125, 39, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_core_1.add(mesh_core_1);
  meshes["core"] = mesh_core_1;
  colliders["core"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_core_1);
  const socket_core_core_socket_0 = new THREE.Object3D();
  socket_core_core_socket_0.name = "core-socket";
  socket_core_core_socket_0.position.set(0.0, 0.0, 0.0);
  socket_core_core_socket_0.rotation.set(0, 0, 0);
  socket_core_core_socket_0.userData.socket = {"id": "core-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_core_1.add(socket_core_core_socket_0);
  sockets["core:core-socket"] = socket_core_core_socket_0;

  const attachment_booster_port_2 = {"parentSocket": "root-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_booster_port_2 = makeAttachmentEndpoint(attachment_booster_port_2);
  const node_booster_port_2 = new THREE.Group();
  node_booster_port_2.name = "booster-port__pivot";
  node_booster_port_2.scale.set(1, 1, 1);
  if (endpoint_booster_port_2) {
    node_booster_port_2.position.copy(endpoint_booster_port_2.start);
    node_booster_port_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_booster_port_2.position.set(-2.05, 4.9, 0.0);
    node_booster_port_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_booster_port_2.userData.sculptComponent = {"id": "booster-port", "name": "booster-port", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 8, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [-2.05, 4.9, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "booster-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "segment-rings-port", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "checker-port", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_booster_port_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "booster-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_booster_port_2);
  nodes["booster-port"] = node_booster_port_2;
  const mesh_booster_port_2Geometry = endpoint_booster_port_2
    ? new THREE.CylinderGeometry(endpoint_booster_port_2.endRadius, endpoint_booster_port_2.baseRadius, endpoint_booster_port_2.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_booster_port_2) {
    mesh_booster_port_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_booster_port_2 = new THREE.Mesh(
    mesh_booster_port_2Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_booster_port_2.name = "booster-port";
  if (endpoint_booster_port_2) {
    mesh_booster_port_2.position.copy(endpoint_booster_port_2.midpoint);
    mesh_booster_port_2.quaternion.copy(endpoint_booster_port_2.quaternion);
  }
  mesh_booster_port_2.castShadow = options.castShadow ?? true;
  mesh_booster_port_2.receiveShadow = options.receiveShadow ?? true;
  mesh_booster_port_2.userData.sculptComponent = {"id": "booster-port", "name": "booster-port", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 8, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [-2.05, 4.9, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "booster-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "segment-rings-port", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "checker-port", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_booster_port_2.add(mesh_booster_port_2);
  meshes["booster-port"] = mesh_booster_port_2;
  colliders["booster-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_booster_port_2);
  const socket_booster_port_booster_port_socket_0 = new THREE.Object3D();
  socket_booster_port_booster_port_socket_0.name = "booster-port-socket";
  socket_booster_port_booster_port_socket_0.position.set(0.0, 0.0, 0.0);
  socket_booster_port_booster_port_socket_0.rotation.set(0, 0, 0);
  socket_booster_port_booster_port_socket_0.userData.socket = {"id": "booster-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_booster_port_2.add(socket_booster_port_booster_port_socket_0);
  sockets["booster-port:booster-port-socket"] = socket_booster_port_booster_port_socket_0;

  const attachment_nose_port_3 = {"parentSocket": "booster-port-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_nose_port_3 = makeAttachmentEndpoint(attachment_nose_port_3);
  const node_nose_port_3 = new THREE.Group();
  node_nose_port_3.name = "nose-port__pivot";
  node_nose_port_3.scale.set(1, 1, 1);
  if (endpoint_nose_port_3) {
    node_nose_port_3.position.copy(endpoint_nose_port_3.start);
    node_nose_port_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_port_3.position.set(0.0, 4.5, 0.0);
    node_nose_port_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_port_3.userData.sculptComponent = {"id": "nose-port", "name": "nose-port", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-port", "attachment": {"parentSocket": "booster-port-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 1, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 4.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nose-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nose_port_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nose-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["booster-port"] ?? root).add(node_nose_port_3);
  nodes["nose-port"] = node_nose_port_3;
  const mesh_nose_port_3Geometry = endpoint_nose_port_3
    ? new THREE.CylinderGeometry(endpoint_nose_port_3.endRadius, endpoint_nose_port_3.baseRadius, endpoint_nose_port_3.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_nose_port_3) {
    mesh_nose_port_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nose_port_3 = new THREE.Mesh(
    mesh_nose_port_3Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_port_3.name = "nose-port";
  if (endpoint_nose_port_3) {
    mesh_nose_port_3.position.copy(endpoint_nose_port_3.midpoint);
    mesh_nose_port_3.quaternion.copy(endpoint_nose_port_3.quaternion);
  }
  mesh_nose_port_3.castShadow = options.castShadow ?? true;
  mesh_nose_port_3.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_port_3.userData.sculptComponent = {"id": "nose-port", "name": "nose-port", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-port", "attachment": {"parentSocket": "booster-port-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 1, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 4.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nose-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nose_port_3.add(mesh_nose_port_3);
  meshes["nose-port"] = mesh_nose_port_3;
  colliders["nose-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_port_3);
  const socket_nose_port_nose_port_socket_0 = new THREE.Object3D();
  socket_nose_port_nose_port_socket_0.name = "nose-port-socket";
  socket_nose_port_nose_port_socket_0.position.set(0.0, 0.0, 0.0);
  socket_nose_port_nose_port_socket_0.rotation.set(0, 0, 0);
  socket_nose_port_nose_port_socket_0.userData.socket = {"id": "nose-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_nose_port_3.add(socket_nose_port_nose_port_socket_0);
  sockets["nose-port:nose-port-socket"] = socket_nose_port_nose_port_socket_0;

  const attachment_nozzle_port_4 = {"parentSocket": "booster-port-socket", "localStart": [0, -0.35, 0], "localEnd": [0, 0.35, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_nozzle_port_4 = makeAttachmentEndpoint(attachment_nozzle_port_4);
  const node_nozzle_port_4 = new THREE.Group();
  node_nozzle_port_4.name = "nozzle-port__pivot";
  node_nozzle_port_4.scale.set(1, 1, 1);
  if (endpoint_nozzle_port_4) {
    node_nozzle_port_4.position.copy(endpoint_nozzle_port_4.start);
    node_nozzle_port_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nozzle_port_4.position.set(0.0, -4.3, 0.0);
    node_nozzle_port_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_nozzle_port_4.userData.sculptComponent = {"id": "nozzle-port", "name": "nozzle-port", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-port", "attachment": {"parentSocket": "booster-port-socket", "localStart": [0, -0.35, 0], "localEnd": [0, 0.35, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.3, "height": 0.7, "depth": 1.3, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, -4.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nozzle-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nozzle_port_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nozzle-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["booster-port"] ?? root).add(node_nozzle_port_4);
  nodes["nozzle-port"] = node_nozzle_port_4;
  const mesh_nozzle_port_4Geometry = endpoint_nozzle_port_4
    ? new THREE.CylinderGeometry(endpoint_nozzle_port_4.endRadius, endpoint_nozzle_port_4.baseRadius, endpoint_nozzle_port_4.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_nozzle_port_4) {
    mesh_nozzle_port_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nozzle_port_4 = new THREE.Mesh(
    mesh_nozzle_port_4Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nozzle_port_4.name = "nozzle-port";
  if (endpoint_nozzle_port_4) {
    mesh_nozzle_port_4.position.copy(endpoint_nozzle_port_4.midpoint);
    mesh_nozzle_port_4.quaternion.copy(endpoint_nozzle_port_4.quaternion);
  }
  mesh_nozzle_port_4.castShadow = options.castShadow ?? true;
  mesh_nozzle_port_4.receiveShadow = options.receiveShadow ?? true;
  mesh_nozzle_port_4.userData.sculptComponent = {"id": "nozzle-port", "name": "nozzle-port", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-port", "attachment": {"parentSocket": "booster-port-socket", "localStart": [0, -0.35, 0], "localEnd": [0, 0.35, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.3, "height": 0.7, "depth": 1.3, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, -4.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nozzle-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nozzle_port_4.add(mesh_nozzle_port_4);
  meshes["nozzle-port"] = mesh_nozzle_port_4;
  colliders["nozzle-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nozzle_port_4);
  const socket_nozzle_port_nozzle_port_socket_0 = new THREE.Object3D();
  socket_nozzle_port_nozzle_port_socket_0.name = "nozzle-port-socket";
  socket_nozzle_port_nozzle_port_socket_0.position.set(0.0, 0.0, 0.0);
  socket_nozzle_port_nozzle_port_socket_0.rotation.set(0, 0, 0);
  socket_nozzle_port_nozzle_port_socket_0.userData.socket = {"id": "nozzle-port-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_nozzle_port_4.add(socket_nozzle_port_nozzle_port_socket_0);
  sockets["nozzle-port:nozzle-port-socket"] = socket_nozzle_port_nozzle_port_socket_0;

  const attachment_booster_starboard_5 = {"parentSocket": "root-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_booster_starboard_5 = makeAttachmentEndpoint(attachment_booster_starboard_5);
  const node_booster_starboard_5 = new THREE.Group();
  node_booster_starboard_5.name = "booster-starboard__pivot";
  node_booster_starboard_5.scale.set(1, 1, 1);
  if (endpoint_booster_starboard_5) {
    node_booster_starboard_5.position.copy(endpoint_booster_starboard_5.start);
    node_booster_starboard_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_booster_starboard_5.position.set(2.05, 4.9, 0.0);
    node_booster_starboard_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_booster_starboard_5.userData.sculptComponent = {"id": "booster-starboard", "name": "booster-starboard", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 8, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [2.05, 4.9, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "booster-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "segment-rings-starboard", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "checker-starboard", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_booster_starboard_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "booster-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_booster_starboard_5);
  nodes["booster-starboard"] = node_booster_starboard_5;
  const mesh_booster_starboard_5Geometry = endpoint_booster_starboard_5
    ? new THREE.CylinderGeometry(endpoint_booster_starboard_5.endRadius, endpoint_booster_starboard_5.baseRadius, endpoint_booster_starboard_5.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_booster_starboard_5) {
    mesh_booster_starboard_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_booster_starboard_5 = new THREE.Mesh(
    mesh_booster_starboard_5Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_booster_starboard_5.name = "booster-starboard";
  if (endpoint_booster_starboard_5) {
    mesh_booster_starboard_5.position.copy(endpoint_booster_starboard_5.midpoint);
    mesh_booster_starboard_5.quaternion.copy(endpoint_booster_starboard_5.quaternion);
  }
  mesh_booster_starboard_5.castShadow = options.castShadow ?? true;
  mesh_booster_starboard_5.receiveShadow = options.receiveShadow ?? true;
  mesh_booster_starboard_5.userData.sculptComponent = {"id": "booster-starboard", "name": "booster-starboard", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 8, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [2.05, 4.9, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "booster-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "segment-rings-starboard", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "checker-starboard", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_booster_starboard_5.add(mesh_booster_starboard_5);
  meshes["booster-starboard"] = mesh_booster_starboard_5;
  colliders["booster-starboard"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_booster_starboard_5);
  const socket_booster_starboard_booster_starboard_socket_0 = new THREE.Object3D();
  socket_booster_starboard_booster_starboard_socket_0.name = "booster-starboard-socket";
  socket_booster_starboard_booster_starboard_socket_0.position.set(0.0, 0.0, 0.0);
  socket_booster_starboard_booster_starboard_socket_0.rotation.set(0, 0, 0);
  socket_booster_starboard_booster_starboard_socket_0.userData.socket = {"id": "booster-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_booster_starboard_5.add(socket_booster_starboard_booster_starboard_socket_0);
  sockets["booster-starboard:booster-starboard-socket"] = socket_booster_starboard_booster_starboard_socket_0;

  const attachment_nose_starboard_6 = {"parentSocket": "booster-starboard-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_nose_starboard_6 = makeAttachmentEndpoint(attachment_nose_starboard_6);
  const node_nose_starboard_6 = new THREE.Group();
  node_nose_starboard_6.name = "nose-starboard__pivot";
  node_nose_starboard_6.scale.set(1, 1, 1);
  if (endpoint_nose_starboard_6) {
    node_nose_starboard_6.position.copy(endpoint_nose_starboard_6.start);
    node_nose_starboard_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_starboard_6.position.set(0.0, 4.5, 0.0);
    node_nose_starboard_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_starboard_6.userData.sculptComponent = {"id": "nose-starboard", "name": "nose-starboard", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-starboard", "attachment": {"parentSocket": "booster-starboard-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 1, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 4.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nose-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nose_starboard_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nose-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["booster-starboard"] ?? root).add(node_nose_starboard_6);
  nodes["nose-starboard"] = node_nose_starboard_6;
  const mesh_nose_starboard_6Geometry = endpoint_nose_starboard_6
    ? new THREE.CylinderGeometry(endpoint_nose_starboard_6.endRadius, endpoint_nose_starboard_6.baseRadius, endpoint_nose_starboard_6.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_nose_starboard_6) {
    mesh_nose_starboard_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nose_starboard_6 = new THREE.Mesh(
    mesh_nose_starboard_6Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_starboard_6.name = "nose-starboard";
  if (endpoint_nose_starboard_6) {
    mesh_nose_starboard_6.position.copy(endpoint_nose_starboard_6.midpoint);
    mesh_nose_starboard_6.quaternion.copy(endpoint_nose_starboard_6.quaternion);
  }
  mesh_nose_starboard_6.castShadow = options.castShadow ?? true;
  mesh_nose_starboard_6.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_starboard_6.userData.sculptComponent = {"id": "nose-starboard", "name": "nose-starboard", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-starboard", "attachment": {"parentSocket": "booster-starboard-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.25, "height": 1, "depth": 1.25, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 4.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nose-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nose_starboard_6.add(mesh_nose_starboard_6);
  meshes["nose-starboard"] = mesh_nose_starboard_6;
  colliders["nose-starboard"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_starboard_6);
  const socket_nose_starboard_nose_starboard_socket_0 = new THREE.Object3D();
  socket_nose_starboard_nose_starboard_socket_0.name = "nose-starboard-socket";
  socket_nose_starboard_nose_starboard_socket_0.position.set(0.0, 0.0, 0.0);
  socket_nose_starboard_nose_starboard_socket_0.rotation.set(0, 0, 0);
  socket_nose_starboard_nose_starboard_socket_0.userData.socket = {"id": "nose-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_nose_starboard_6.add(socket_nose_starboard_nose_starboard_socket_0);
  sockets["nose-starboard:nose-starboard-socket"] = socket_nose_starboard_nose_starboard_socket_0;

  const attachment_nozzle_starboard_7 = {"parentSocket": "booster-starboard-socket", "localStart": [0, -0.35, 0], "localEnd": [0, 0.35, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_nozzle_starboard_7 = makeAttachmentEndpoint(attachment_nozzle_starboard_7);
  const node_nozzle_starboard_7 = new THREE.Group();
  node_nozzle_starboard_7.name = "nozzle-starboard__pivot";
  node_nozzle_starboard_7.scale.set(1, 1, 1);
  if (endpoint_nozzle_starboard_7) {
    node_nozzle_starboard_7.position.copy(endpoint_nozzle_starboard_7.start);
    node_nozzle_starboard_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nozzle_starboard_7.position.set(0.0, -4.3, 0.0);
    node_nozzle_starboard_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_nozzle_starboard_7.userData.sculptComponent = {"id": "nozzle-starboard", "name": "nozzle-starboard", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-starboard", "attachment": {"parentSocket": "booster-starboard-socket", "localStart": [0, -0.35, 0], "localEnd": [0, 0.35, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.3, "height": 0.7, "depth": 1.3, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, -4.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nozzle-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nozzle_starboard_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nozzle-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["booster-starboard"] ?? root).add(node_nozzle_starboard_7);
  nodes["nozzle-starboard"] = node_nozzle_starboard_7;
  const mesh_nozzle_starboard_7Geometry = endpoint_nozzle_starboard_7
    ? new THREE.CylinderGeometry(endpoint_nozzle_starboard_7.endRadius, endpoint_nozzle_starboard_7.baseRadius, endpoint_nozzle_starboard_7.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_nozzle_starboard_7) {
    mesh_nozzle_starboard_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nozzle_starboard_7 = new THREE.Mesh(
    mesh_nozzle_starboard_7Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nozzle_starboard_7.name = "nozzle-starboard";
  if (endpoint_nozzle_starboard_7) {
    mesh_nozzle_starboard_7.position.copy(endpoint_nozzle_starboard_7.midpoint);
    mesh_nozzle_starboard_7.quaternion.copy(endpoint_nozzle_starboard_7.quaternion);
  }
  mesh_nozzle_starboard_7.castShadow = options.castShadow ?? true;
  mesh_nozzle_starboard_7.receiveShadow = options.receiveShadow ?? true;
  mesh_nozzle_starboard_7.userData.sculptComponent = {"id": "nozzle-starboard", "name": "nozzle-starboard", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "booster-starboard", "attachment": {"parentSocket": "booster-starboard-socket", "localStart": [0, -0.35, 0], "localEnd": [0, 0.35, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.3, "height": 0.7, "depth": 1.3, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, -4.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "nozzle-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_nozzle_starboard_7.add(mesh_nozzle_starboard_7);
  meshes["nozzle-starboard"] = mesh_nozzle_starboard_7;
  colliders["nozzle-starboard"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nozzle_starboard_7);
  const socket_nozzle_starboard_nozzle_starboard_socket_0 = new THREE.Object3D();
  socket_nozzle_starboard_nozzle_starboard_socket_0.name = "nozzle-starboard-socket";
  socket_nozzle_starboard_nozzle_starboard_socket_0.position.set(0.0, 0.0, 0.0);
  socket_nozzle_starboard_nozzle_starboard_socket_0.rotation.set(0, 0, 0);
  socket_nozzle_starboard_nozzle_starboard_socket_0.userData.socket = {"id": "nozzle-starboard-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_nozzle_starboard_7.add(socket_nozzle_starboard_nozzle_starboard_socket_0);
  sockets["nozzle-starboard:nozzle-starboard-socket"] = socket_nozzle_starboard_nozzle_starboard_socket_0;

  const attachment_upper_stack_8 = {"parentSocket": "root-socket", "localStart": [0, -1.25, 0], "localEnd": [0, 1.25, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_upper_stack_8 = makeAttachmentEndpoint(attachment_upper_stack_8);
  const node_upper_stack_8 = new THREE.Group();
  node_upper_stack_8.name = "upper-stack__pivot";
  node_upper_stack_8.scale.set(1, 1, 1);
  if (endpoint_upper_stack_8) {
    node_upper_stack_8.position.copy(endpoint_upper_stack_8.start);
    node_upper_stack_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_stack_8.position.set(0.0, 12.5, 0.0);
    node_upper_stack_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_stack_8.userData.sculptComponent = {"id": "upper-stack", "name": "upper-stack", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -1.25, 0], "localEnd": [0, 1.25, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.85, "height": 2.5, "depth": 1.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 12.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-stack-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "adapter-ring", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "capsule-seam", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_upper_stack_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-stack-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_upper_stack_8);
  nodes["upper-stack"] = node_upper_stack_8;
  const mesh_upper_stack_8Geometry = endpoint_upper_stack_8
    ? new THREE.CylinderGeometry(endpoint_upper_stack_8.endRadius, endpoint_upper_stack_8.baseRadius, endpoint_upper_stack_8.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_upper_stack_8) {
    mesh_upper_stack_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_stack_8 = new THREE.Mesh(
    mesh_upper_stack_8Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_stack_8.name = "upper-stack";
  if (endpoint_upper_stack_8) {
    mesh_upper_stack_8.position.copy(endpoint_upper_stack_8.midpoint);
    mesh_upper_stack_8.quaternion.copy(endpoint_upper_stack_8.quaternion);
  }
  mesh_upper_stack_8.castShadow = options.castShadow ?? true;
  mesh_upper_stack_8.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_stack_8.userData.sculptComponent = {"id": "upper-stack", "name": "upper-stack", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentSocket": "root-socket", "localStart": [0, -1.25, 0], "localEnd": [0, 1.25, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 1.85, "height": 2.5, "depth": 1.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 12.5, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-stack-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "adapter-ring", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "capsule-seam", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_upper_stack_8.add(mesh_upper_stack_8);
  meshes["upper-stack"] = mesh_upper_stack_8;
  colliders["upper-stack"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_upper_stack_8);
  const socket_upper_stack_upper_stack_socket_0 = new THREE.Object3D();
  socket_upper_stack_upper_stack_socket_0.name = "upper-stack-socket";
  socket_upper_stack_upper_stack_socket_0.position.set(0.0, 0.0, 0.0);
  socket_upper_stack_upper_stack_socket_0.rotation.set(0, 0, 0);
  socket_upper_stack_upper_stack_socket_0.userData.socket = {"id": "upper-stack-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_upper_stack_8.add(socket_upper_stack_upper_stack_socket_0);
  sockets["upper-stack:upper-stack-socket"] = socket_upper_stack_upper_stack_socket_0;

  const attachment_abort_tower_9 = {"parentSocket": "upper-stack-socket", "localStart": [0, -1.0, 0], "localEnd": [0, 1.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_abort_tower_9 = makeAttachmentEndpoint(attachment_abort_tower_9);
  const node_abort_tower_9 = new THREE.Group();
  node_abort_tower_9.name = "abort-tower__pivot";
  node_abort_tower_9.scale.set(1, 1, 1);
  if (endpoint_abort_tower_9) {
    node_abort_tower_9.position.copy(endpoint_abort_tower_9.start);
    node_abort_tower_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_abort_tower_9.position.set(0.0, 2.3, 0.0);
    node_abort_tower_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_abort_tower_9.userData.sculptComponent = {"id": "abort-tower", "name": "abort-tower", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "upper-stack", "attachment": {"parentSocket": "upper-stack-socket", "localStart": [0, -1.0, 0], "localEnd": [0, 1.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.35, "height": 2, "depth": 0.35, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 2.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "abort-tower-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "abort-nozzles", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_abort_tower_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "abort-tower-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["upper-stack"] ?? root).add(node_abort_tower_9);
  nodes["abort-tower"] = node_abort_tower_9;
  const mesh_abort_tower_9Geometry = endpoint_abort_tower_9
    ? new THREE.CylinderGeometry(endpoint_abort_tower_9.endRadius, endpoint_abort_tower_9.baseRadius, endpoint_abort_tower_9.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_abort_tower_9) {
    mesh_abort_tower_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_abort_tower_9 = new THREE.Mesh(
    mesh_abort_tower_9Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_abort_tower_9.name = "abort-tower";
  if (endpoint_abort_tower_9) {
    mesh_abort_tower_9.position.copy(endpoint_abort_tower_9.midpoint);
    mesh_abort_tower_9.quaternion.copy(endpoint_abort_tower_9.quaternion);
  }
  mesh_abort_tower_9.castShadow = options.castShadow ?? true;
  mesh_abort_tower_9.receiveShadow = options.receiveShadow ?? true;
  mesh_abort_tower_9.userData.sculptComponent = {"id": "abort-tower", "name": "abort-tower", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "upper-stack", "attachment": {"parentSocket": "upper-stack-socket", "localStart": [0, -1.0, 0], "localEnd": [0, 1.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.35, "height": 2, "depth": 0.35, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 2.3, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "abort-tower-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "abort-nozzles", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_abort_tower_9.add(mesh_abort_tower_9);
  meshes["abort-tower"] = mesh_abort_tower_9;
  colliders["abort-tower"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_abort_tower_9);
  const socket_abort_tower_abort_tower_socket_0 = new THREE.Object3D();
  socket_abort_tower_abort_tower_socket_0.name = "abort-tower-socket";
  socket_abort_tower_abort_tower_socket_0.position.set(0.0, 0.0, 0.0);
  socket_abort_tower_abort_tower_socket_0.rotation.set(0, 0, 0);
  socket_abort_tower_abort_tower_socket_0.userData.socket = {"id": "abort-tower-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_abort_tower_9.add(socket_abort_tower_abort_tower_socket_0);
  sockets["abort-tower:abort-tower-socket"] = socket_abort_tower_abort_tower_socket_0;

  const attachment_engine_section_10 = {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_engine_section_10 = makeAttachmentEndpoint(attachment_engine_section_10);
  const node_engine_section_10 = new THREE.Group();
  node_engine_section_10.name = "engine-section__pivot";
  node_engine_section_10.scale.set(1, 1, 1);
  if (endpoint_engine_section_10) {
    node_engine_section_10.position.copy(endpoint_engine_section_10.start);
    node_engine_section_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_section_10.position.set(0.0, -4.65, 0.0);
    node_engine_section_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_section_10.userData.sculptComponent = {"id": "engine-section", "name": "engine-section", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 2.7, "height": 0.85, "depth": 2.7, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, -4.65, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-section-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "thermal-panels", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_section_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-section-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_engine_section_10);
  nodes["engine-section"] = node_engine_section_10;
  const mesh_engine_section_10Geometry = endpoint_engine_section_10
    ? new THREE.CylinderGeometry(endpoint_engine_section_10.endRadius, endpoint_engine_section_10.baseRadius, endpoint_engine_section_10.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_engine_section_10) {
    mesh_engine_section_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_section_10 = new THREE.Mesh(
    mesh_engine_section_10Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_section_10.name = "engine-section";
  if (endpoint_engine_section_10) {
    mesh_engine_section_10.position.copy(endpoint_engine_section_10.midpoint);
    mesh_engine_section_10.quaternion.copy(endpoint_engine_section_10.quaternion);
  }
  mesh_engine_section_10.castShadow = options.castShadow ?? true;
  mesh_engine_section_10.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_section_10.userData.sculptComponent = {"id": "engine-section", "name": "engine-section", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 2.7, "height": 0.85, "depth": 2.7, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, -4.65, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-section-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "thermal-panels", "type": "raised ridge", "placement": "component surface", "size": 0.08, "confidence": 0.8, "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_section_10.add(mesh_engine_section_10);
  meshes["engine-section"] = mesh_engine_section_10;
  colliders["engine-section"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_section_10);
  const socket_engine_section_engine_section_socket_0 = new THREE.Object3D();
  socket_engine_section_engine_section_socket_0.name = "engine-section-socket";
  socket_engine_section_engine_section_socket_0.position.set(0.0, 0.0, 0.0);
  socket_engine_section_engine_section_socket_0.rotation.set(0, 0, 0);
  socket_engine_section_engine_section_socket_0.userData.socket = {"id": "engine-section-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_engine_section_10.add(socket_engine_section_engine_section_socket_0);
  sockets["engine-section:engine-section-socket"] = socket_engine_section_engine_section_socket_0;

  const attachment_engine_0_11 = {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_engine_0_11 = makeAttachmentEndpoint(attachment_engine_0_11);
  const node_engine_0_11 = new THREE.Group();
  node_engine_0_11.name = "engine-0__pivot";
  node_engine_0_11.scale.set(1, 1, 1);
  if (endpoint_engine_0_11) {
    node_engine_0_11.position.copy(endpoint_engine_0_11.start);
    node_engine_0_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_0_11.position.set(0.65, -5.5, 0.65);
    node_engine_0_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_0_11.userData.sculptComponent = {"id": "engine-0", "name": "engine-0", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.65, -5.5, 0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-0-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_0_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-0-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_engine_0_11);
  nodes["engine-0"] = node_engine_0_11;
  const mesh_engine_0_11Geometry = endpoint_engine_0_11
    ? new THREE.CylinderGeometry(endpoint_engine_0_11.endRadius, endpoint_engine_0_11.baseRadius, endpoint_engine_0_11.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_engine_0_11) {
    mesh_engine_0_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_0_11 = new THREE.Mesh(
    mesh_engine_0_11Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_0_11.name = "engine-0";
  if (endpoint_engine_0_11) {
    mesh_engine_0_11.position.copy(endpoint_engine_0_11.midpoint);
    mesh_engine_0_11.quaternion.copy(endpoint_engine_0_11.quaternion);
  }
  mesh_engine_0_11.castShadow = options.castShadow ?? true;
  mesh_engine_0_11.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_0_11.userData.sculptComponent = {"id": "engine-0", "name": "engine-0", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.65, -5.5, 0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-0-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_0_11.add(mesh_engine_0_11);
  meshes["engine-0"] = mesh_engine_0_11;
  colliders["engine-0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_0_11);
  const socket_engine_0_engine_0_socket_0 = new THREE.Object3D();
  socket_engine_0_engine_0_socket_0.name = "engine-0-socket";
  socket_engine_0_engine_0_socket_0.position.set(0.0, 0.0, 0.0);
  socket_engine_0_engine_0_socket_0.rotation.set(0, 0, 0);
  socket_engine_0_engine_0_socket_0.userData.socket = {"id": "engine-0-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_engine_0_11.add(socket_engine_0_engine_0_socket_0);
  sockets["engine-0:engine-0-socket"] = socket_engine_0_engine_0_socket_0;

  const attachment_engine_1_12 = {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_engine_1_12 = makeAttachmentEndpoint(attachment_engine_1_12);
  const node_engine_1_12 = new THREE.Group();
  node_engine_1_12.name = "engine-1__pivot";
  node_engine_1_12.scale.set(1, 1, 1);
  if (endpoint_engine_1_12) {
    node_engine_1_12.position.copy(endpoint_engine_1_12.start);
    node_engine_1_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_1_12.position.set(-0.65, -5.5, 0.65);
    node_engine_1_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_1_12.userData.sculptComponent = {"id": "engine-1", "name": "engine-1", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.65, -5.5, 0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-1-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_1_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-1-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_engine_1_12);
  nodes["engine-1"] = node_engine_1_12;
  const mesh_engine_1_12Geometry = endpoint_engine_1_12
    ? new THREE.CylinderGeometry(endpoint_engine_1_12.endRadius, endpoint_engine_1_12.baseRadius, endpoint_engine_1_12.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_engine_1_12) {
    mesh_engine_1_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_1_12 = new THREE.Mesh(
    mesh_engine_1_12Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_1_12.name = "engine-1";
  if (endpoint_engine_1_12) {
    mesh_engine_1_12.position.copy(endpoint_engine_1_12.midpoint);
    mesh_engine_1_12.quaternion.copy(endpoint_engine_1_12.quaternion);
  }
  mesh_engine_1_12.castShadow = options.castShadow ?? true;
  mesh_engine_1_12.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_1_12.userData.sculptComponent = {"id": "engine-1", "name": "engine-1", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.65, -5.5, 0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-1-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_1_12.add(mesh_engine_1_12);
  meshes["engine-1"] = mesh_engine_1_12;
  colliders["engine-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_1_12);
  const socket_engine_1_engine_1_socket_0 = new THREE.Object3D();
  socket_engine_1_engine_1_socket_0.name = "engine-1-socket";
  socket_engine_1_engine_1_socket_0.position.set(0.0, 0.0, 0.0);
  socket_engine_1_engine_1_socket_0.rotation.set(0, 0, 0);
  socket_engine_1_engine_1_socket_0.userData.socket = {"id": "engine-1-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_engine_1_12.add(socket_engine_1_engine_1_socket_0);
  sockets["engine-1:engine-1-socket"] = socket_engine_1_engine_1_socket_0;

  const attachment_engine_2_13 = {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_engine_2_13 = makeAttachmentEndpoint(attachment_engine_2_13);
  const node_engine_2_13 = new THREE.Group();
  node_engine_2_13.name = "engine-2__pivot";
  node_engine_2_13.scale.set(1, 1, 1);
  if (endpoint_engine_2_13) {
    node_engine_2_13.position.copy(endpoint_engine_2_13.start);
    node_engine_2_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_2_13.position.set(0.65, -5.5, -0.65);
    node_engine_2_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_2_13.userData.sculptComponent = {"id": "engine-2", "name": "engine-2", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.65, -5.5, -0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-2-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_2_13.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-2-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_engine_2_13);
  nodes["engine-2"] = node_engine_2_13;
  const mesh_engine_2_13Geometry = endpoint_engine_2_13
    ? new THREE.CylinderGeometry(endpoint_engine_2_13.endRadius, endpoint_engine_2_13.baseRadius, endpoint_engine_2_13.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_engine_2_13) {
    mesh_engine_2_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_2_13 = new THREE.Mesh(
    mesh_engine_2_13Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_2_13.name = "engine-2";
  if (endpoint_engine_2_13) {
    mesh_engine_2_13.position.copy(endpoint_engine_2_13.midpoint);
    mesh_engine_2_13.quaternion.copy(endpoint_engine_2_13.quaternion);
  }
  mesh_engine_2_13.castShadow = options.castShadow ?? true;
  mesh_engine_2_13.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_2_13.userData.sculptComponent = {"id": "engine-2", "name": "engine-2", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.65, -5.5, -0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-2-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_2_13.add(mesh_engine_2_13);
  meshes["engine-2"] = mesh_engine_2_13;
  colliders["engine-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_2_13);
  const socket_engine_2_engine_2_socket_0 = new THREE.Object3D();
  socket_engine_2_engine_2_socket_0.name = "engine-2-socket";
  socket_engine_2_engine_2_socket_0.position.set(0.0, 0.0, 0.0);
  socket_engine_2_engine_2_socket_0.rotation.set(0, 0, 0);
  socket_engine_2_engine_2_socket_0.userData.socket = {"id": "engine-2-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_engine_2_13.add(socket_engine_2_engine_2_socket_0);
  sockets["engine-2:engine-2-socket"] = socket_engine_2_engine_2_socket_0;

  const attachment_engine_3_14 = {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_engine_3_14 = makeAttachmentEndpoint(attachment_engine_3_14);
  const node_engine_3_14 = new THREE.Group();
  node_engine_3_14.name = "engine-3__pivot";
  node_engine_3_14.scale.set(1, 1, 1);
  if (endpoint_engine_3_14) {
    node_engine_3_14.position.copy(endpoint_engine_3_14.start);
    node_engine_3_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_engine_3_14.position.set(-0.65, -5.5, -0.65);
    node_engine_3_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_engine_3_14.userData.sculptComponent = {"id": "engine-3", "name": "engine-3", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.65, -5.5, -0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-3-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_3_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-3-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_engine_3_14);
  nodes["engine-3"] = node_engine_3_14;
  const mesh_engine_3_14Geometry = endpoint_engine_3_14
    ? new THREE.CylinderGeometry(endpoint_engine_3_14.endRadius, endpoint_engine_3_14.baseRadius, endpoint_engine_3_14.length, 16, 6)
    : new THREE.ConeGeometry(0.5, 1, 24, 1);
  if (!endpoint_engine_3_14) {
    mesh_engine_3_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_engine_3_14 = new THREE.Mesh(
    mesh_engine_3_14Geometry,
    materialMap["ink"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_engine_3_14.name = "engine-3";
  if (endpoint_engine_3_14) {
    mesh_engine_3_14.position.copy(endpoint_engine_3_14.midpoint);
    mesh_engine_3_14.quaternion.copy(endpoint_engine_3_14.quaternion);
  }
  mesh_engine_3_14.castShadow = options.castShadow ?? true;
  mesh_engine_3_14.receiveShadow = options.receiveShadow ?? true;
  mesh_engine_3_14.userData.sculptComponent = {"id": "engine-3", "name": "engine-3", "level": "meso", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.425, 0], "localEnd": [0, 0.425, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.85, "height": 0.85, "depth": 0.85, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.65, -5.5, -0.65], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "engine-3-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ink", "materialLayers": ["ink"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_engine_3_14.add(mesh_engine_3_14);
  meshes["engine-3"] = mesh_engine_3_14;
  colliders["engine-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_engine_3_14);
  const socket_engine_3_engine_3_socket_0 = new THREE.Object3D();
  socket_engine_3_engine_3_socket_0.name = "engine-3-socket";
  socket_engine_3_engine_3_socket_0.position.set(0.0, 0.0, 0.0);
  socket_engine_3_engine_3_socket_0.rotation.set(0, 0, 0);
  socket_engine_3_engine_3_socket_0.userData.socket = {"id": "engine-3-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_engine_3_14.add(socket_engine_3_engine_3_socket_0);
  sockets["engine-3:engine-3-socket"] = socket_engine_3_engine_3_socket_0;

  const attachment_intertank_ribs_15 = {"parentSocket": "core-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_intertank_ribs_15 = makeAttachmentEndpoint(attachment_intertank_ribs_15);
  const node_intertank_ribs_15 = new THREE.Group();
  node_intertank_ribs_15.name = "intertank-ribs__pivot";
  node_intertank_ribs_15.scale.set(1, 1, 1);
  if (endpoint_intertank_ribs_15) {
    node_intertank_ribs_15.position.copy(endpoint_intertank_ribs_15.start);
    node_intertank_ribs_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_intertank_ribs_15.position.set(0.0, 0.6, 0.0);
    node_intertank_ribs_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_intertank_ribs_15.userData.sculptComponent = {"id": "intertank-ribs", "name": "intertank-ribs", "level": "micro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 2.74, "height": 1, "depth": 2.74, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0.6, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "intertank-ribs-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "orange", "materialLayers": ["orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 125, 39, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_intertank_ribs_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "intertank-ribs-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_intertank_ribs_15);
  nodes["intertank-ribs"] = node_intertank_ribs_15;
  const mesh_intertank_ribs_15Geometry = endpoint_intertank_ribs_15
    ? new THREE.CylinderGeometry(endpoint_intertank_ribs_15.endRadius, endpoint_intertank_ribs_15.baseRadius, endpoint_intertank_ribs_15.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_intertank_ribs_15) {
    mesh_intertank_ribs_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_intertank_ribs_15 = new THREE.Mesh(
    mesh_intertank_ribs_15Geometry,
    materialMap["orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_intertank_ribs_15.name = "intertank-ribs";
  if (endpoint_intertank_ribs_15) {
    mesh_intertank_ribs_15.position.copy(endpoint_intertank_ribs_15.midpoint);
    mesh_intertank_ribs_15.quaternion.copy(endpoint_intertank_ribs_15.quaternion);
  }
  mesh_intertank_ribs_15.castShadow = options.castShadow ?? true;
  mesh_intertank_ribs_15.receiveShadow = options.receiveShadow ?? true;
  mesh_intertank_ribs_15.userData.sculptComponent = {"id": "intertank-ribs", "name": "intertank-ribs", "level": "micro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -0.5, 0], "localEnd": [0, 0.5, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 2.74, "height": 1, "depth": 2.74, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0.6, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "intertank-ribs-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "orange", "materialLayers": ["orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(237, 125, 39, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_intertank_ribs_15.add(mesh_intertank_ribs_15);
  meshes["intertank-ribs"] = mesh_intertank_ribs_15;
  colliders["intertank-ribs"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_intertank_ribs_15);
  const socket_intertank_ribs_intertank_ribs_socket_0 = new THREE.Object3D();
  socket_intertank_ribs_intertank_ribs_socket_0.name = "intertank-ribs-socket";
  socket_intertank_ribs_intertank_ribs_socket_0.position.set(0.0, 0.0, 0.0);
  socket_intertank_ribs_intertank_ribs_socket_0.rotation.set(0, 0, 0);
  socket_intertank_ribs_intertank_ribs_socket_0.userData.socket = {"id": "intertank-ribs-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_intertank_ribs_15.add(socket_intertank_ribs_intertank_ribs_socket_0);
  sockets["intertank-ribs:intertank-ribs-socket"] = socket_intertank_ribs_intertank_ribs_socket_0;

  const attachment_feed_line_16 = {"parentSocket": "core-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01};
  const endpoint_feed_line_16 = makeAttachmentEndpoint(attachment_feed_line_16);
  const node_feed_line_16 = new THREE.Group();
  node_feed_line_16.name = "feed-line__pivot";
  node_feed_line_16.scale.set(1, 1, 1);
  if (endpoint_feed_line_16) {
    node_feed_line_16.position.copy(endpoint_feed_line_16.start);
    node_feed_line_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_feed_line_16.position.set(0.8, -0.4, 1.12);
    node_feed_line_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_feed_line_16.userData.sculptComponent = {"id": "feed-line", "name": "feed-line", "level": "micro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.12, "height": 8, "depth": 0.12, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.8, -0.4, 1.12], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "feed-line-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_feed_line_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "feed-line-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["core"] ?? root).add(node_feed_line_16);
  nodes["feed-line"] = node_feed_line_16;
  const mesh_feed_line_16Geometry = endpoint_feed_line_16
    ? new THREE.CylinderGeometry(endpoint_feed_line_16.endRadius, endpoint_feed_line_16.baseRadius, endpoint_feed_line_16.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_feed_line_16) {
    mesh_feed_line_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_feed_line_16 = new THREE.Mesh(
    mesh_feed_line_16Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_feed_line_16.name = "feed-line";
  if (endpoint_feed_line_16) {
    mesh_feed_line_16.position.copy(endpoint_feed_line_16.midpoint);
    mesh_feed_line_16.quaternion.copy(endpoint_feed_line_16.quaternion);
  }
  mesh_feed_line_16.castShadow = options.castShadow ?? true;
  mesh_feed_line_16.receiveShadow = options.receiveShadow ?? true;
  mesh_feed_line_16.userData.sculptComponent = {"id": "feed-line", "name": "feed-line", "level": "micro", "role": "body", "importance": 1.0, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete fabricated axisymmetric metal or insulated assembly.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "core", "attachment": {"parentSocket": "core-socket", "localStart": [0, -4.0, 0], "localEnd": [0, 4.0, 0], "contactType": "overlap", "overlap": 0.04, "embedDepth": 0.04, "gapTolerance": 0.01}, "dimensions": {"width": 0.12, "height": 8, "depth": 0.12, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.8, -0.4, 1.12], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "feed-line-socket", "position": [0, 0, 0], "axis": [0, 1, 0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 242, 206, 1)", "secondaryAlbedo": "rgba(100, 86, 91, 1)", "materialClass": "metal", "materialClassConfidence": 0.85}};
  node_feed_line_16.add(mesh_feed_line_16);
  meshes["feed-line"] = mesh_feed_line_16;
  colliders["feed-line"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_feed_line_16);
  const socket_feed_line_feed_line_socket_0 = new THREE.Object3D();
  socket_feed_line_feed_line_socket_0.name = "feed-line-socket";
  socket_feed_line_feed_line_socket_0.position.set(0.0, 0.0, 0.0);
  socket_feed_line_feed_line_socket_0.rotation.set(0, 0, 0);
  socket_feed_line_feed_line_socket_0.userData.socket = {"id": "feed-line-socket", "position": [0, 0, 0], "axis": [0, 1, 0]};
  node_feed_line_16.add(socket_feed_line_feed_line_socket_0);
  sockets["feed-line:feed-line-socket"] = socket_feed_line_feed_line_socket_0;

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "stylized-cel", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createSLSCelRocketLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "SLS Cel Rocket look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "directional", "role": "key", "position": [-8, 16, 10], "intensity": 3, "color": "#fff1d0"}, {"type": "hemisphere", "role": "fill", "intensity": 1, "color": "#b6d4f0"}, {"role": "rim", "position": [5, 10, -8], "intensity": 1, "notes": "No tone mapping, exposure 1; graphic ground shadow disc."}];
  lights.userData.lookDevTargets = {"qualityPriority": "stylized-cel", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createSLSCelRocketEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameSLSCelRocketCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createSLSCelRocketPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureSLSCelRocketRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createSLSCelRocketInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
