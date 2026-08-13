const parameterDefaults = {
  opacity: 0.14,
  blur: 12,
  saturation: 1,
  brightness: 1,
  borderOpacity: 0.24,
  shadowOpacity: 0.09,
  highlightOpacity: 0.16,
  glow: 0.04,
  noise: 0,
  radius: 18
};

const defineMaterial = material => Object.freeze({
  ...material,
  baseParameters: Object.freeze({ ...parameterDefaults, ...material.baseParameters }),
  motionProfile: Object.freeze({
    transitionMs: 420,
    hoverScale: 1.005,
    ...material.motionProfile
  }),
  performanceProfile: Object.freeze({
    backdropFilter: true,
    noiseLayer: false,
    cost: 'low',
    ...material.performanceProfile
  })
});

export const MATERIAL_IDS = Object.freeze([
  'pure-glass',
  'frosted-glass',
  'pearl',
  'bubble',
  'liquid',
  'soft-fabric',
  'crystal',
  'obsidian'
]);

export const MATERIAL_REGISTRY = Object.freeze({
  'pure-glass': defineMaterial({
    id: 'pure-glass',
    name: 'Pure Glass',
    description: '清透、克制的透明表面，保留背景空间感。',
    baseParameters: { opacity: 0.1, blur: 4, borderOpacity: 0.32, shadowOpacity: 0.08, highlightOpacity: 0.2, glow: 0.04 },
    motionProfile: { transitionMs: 350, hoverScale: 1.002 },
    performanceProfile: { cost: 'low' }
  }),
  'frosted-glass': defineMaterial({
    id: 'frosted-glass',
    name: 'Frosted Glass',
    description: '柔和的磨砂折射，适合主要工作窗口。',
    baseParameters: { opacity: 0.18, blur: 18, saturation: 1.08, highlightOpacity: 0.26, glow: 0.06 },
    performanceProfile: { cost: 'medium' }
  }),
  pearl: defineMaterial({
    id: 'pearl',
    name: 'Pearl',
    description: '轻盈的珍珠表面，带有细微的内侧高光。',
    baseParameters: { opacity: 0.52, blur: 14, saturation: 1.02, brightness: 1.05, borderOpacity: 0.38, highlightOpacity: 0.34, glow: 0.08, noise: 0.015, radius: 28 },
    performanceProfile: { cost: 'medium' }
  }),
  bubble: defineMaterial({
    id: 'bubble',
    name: 'Bubble',
    description: '更明亮、更柔软的漂浮表面，适合轻量浮层。',
    baseParameters: { opacity: 0.22, blur: 20, saturation: 1.16, brightness: 1.08, borderOpacity: 0.42, highlightOpacity: 0.42, glow: 0.18, radius: 32 },
    motionProfile: { transitionMs: 520, hoverScale: 1.008 },
    performanceProfile: { cost: 'medium' }
  }),
  liquid: defineMaterial({
    id: 'liquid',
    name: 'Liquid',
    description: '具有流动感的折射表面，保留低频动效余量。',
    baseParameters: { opacity: 0.26, blur: 22, saturation: 1.2, brightness: 1.06, borderOpacity: 0.3, shadowOpacity: 0.14, highlightOpacity: 0.3, glow: 0.16, noise: 0.02, radius: 26 },
    motionProfile: { transitionMs: 600, hoverScale: 1.01 },
    performanceProfile: { cost: 'high' }
  }),
  'soft-fabric': defineMaterial({
    id: 'soft-fabric',
    name: 'Soft Fabric',
    description: '温和、低反射的触感，减少玻璃感和屏幕感。',
    baseParameters: { opacity: 0.44, blur: 8, saturation: 0.98, brightness: 0.98, borderOpacity: 0.25, shadowOpacity: 0.11, highlightOpacity: 0.16, glow: 0.02, noise: 0.08, radius: 20 },
    performanceProfile: { backdropFilter: false, noiseLayer: true, cost: 'low' }
  }),
  crystal: defineMaterial({
    id: 'crystal',
    name: 'Crystal',
    description: '高透明度、高高光的精致表面，用于强调性窗口。',
    baseParameters: { opacity: 0.2, blur: 12, saturation: 1.2, brightness: 1.12, borderOpacity: 0.48, shadowOpacity: 0.12, highlightOpacity: 0.5, glow: 0.22, radius: 22 },
    performanceProfile: { cost: 'high' }
  }),
  obsidian: defineMaterial({
    id: 'obsidian',
    name: 'Obsidian',
    description: '深色、低亮度的沉静表面，适合夜间和专注场景。',
    baseParameters: { opacity: 0.18, blur: 16, saturation: 0.9, brightness: 0.86, borderOpacity: 0.22, shadowOpacity: 0.24, highlightOpacity: 0.12, glow: 0.05, noise: 0.02, radius: 20 },
    performanceProfile: { cost: 'medium' }
  })
});

export const MATERIAL_PARAMETER_KEYS = Object.freeze(Object.keys(parameterDefaults));

export const getMaterialDefinition = (materialId, customMaterials = {}) => (
  customMaterials[materialId] || MATERIAL_REGISTRY[materialId] || MATERIAL_REGISTRY['pure-glass']
);

export const normalizeMaterialParameters = parameters => MATERIAL_PARAMETER_KEYS.reduce((result, key) => {
  const value = Number(parameters?.[key]);
  result[key] = Number.isFinite(value) ? value : parameterDefaults[key];
  return result;
}, {});

export const createCustomMaterial = ({ id, name, description, parameters }) => defineMaterial({
  id,
  name,
  description,
  baseParameters: normalizeMaterialParameters(parameters),
  motionProfile: { transitionMs: 420, hoverScale: 1.005 },
  performanceProfile: { cost: 'medium' }
});
