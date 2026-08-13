import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import {
  createCustomMaterial,
  getMaterialDefinition,
  MATERIAL_REGISTRY,
  normalizeMaterialParameters
} from './materialRegistry';

const STORAGE_KEY = 'cochpia.material.v1';

const defaultMaterialState = {
  workspaceDefault: {
    materialId: 'pure-glass',
    materialParameters: getMaterialDefinition('pure-glass').baseParameters
  },
  windowOverride: {},
  customMaterials: {}
};

const clone = value => JSON.parse(JSON.stringify(value));

const normalizeSelection = (selection, customMaterials = {}, fallbackSelection = defaultMaterialState.workspaceDefault) => {
  const materialId = selection?.materialId || fallbackSelection?.materialId;
  const definition = getMaterialDefinition(materialId, customMaterials);
  return {
    materialId: definition.id,
    materialParameters: normalizeMaterialParameters({
      ...definition.baseParameters,
      ...(fallbackSelection?.materialParameters || {}),
      ...(selection?.materialParameters || {})
    })
  };
};

const normalizeState = state => {
  const customMaterials = Object.entries(state?.customMaterials || {}).reduce((result, [id, material]) => {
    if (!material?.id || !material?.baseParameters) return result;
    result[id] = {
      ...material,
      baseParameters: normalizeMaterialParameters(material.baseParameters)
    };
    return result;
  }, {});
  const workspaceDefault = normalizeSelection(state?.workspaceDefault || defaultMaterialState.workspaceDefault, customMaterials);
  const rawOverrides = state?.windowOverride || {};
  const windowOverride = Object.entries(rawOverrides).reduce((result, [windowId, selection]) => {
    result[windowId] = selection ? normalizeSelection(selection, customMaterials, workspaceDefault) : null;
    return result;
  }, {});
  return {
    workspaceDefault,
    windowOverride,
    customMaterials
  };
};

const reducer = (state, action) => {
  switch (action.type) {
    case 'SET_WORKSPACE_MATERIAL':
      return { ...state, workspaceDefault: normalizeSelection(action.selection, state.customMaterials) };
    case 'SET_WORKSPACE_PARAMETER':
      return {
        ...state,
        workspaceDefault: {
          ...state.workspaceDefault,
          materialParameters: normalizeMaterialParameters({ ...state.workspaceDefault.materialParameters, [action.key]: action.value })
        }
      };
    case 'SET_WINDOW_OVERRIDE':
      return {
        ...state,
        windowOverride: {
          ...state.windowOverride,
          [action.windowId]: action.selection ? normalizeSelection(action.selection, state.customMaterials, state.workspaceDefault) : null
        }
      };
    case 'RESET_MATERIAL':
      return { ...state, workspaceDefault: normalizeSelection(defaultMaterialState.workspaceDefault, state.customMaterials), windowOverride: {} };
    case 'SAVE_CUSTOM_MATERIAL':
      return { ...state, customMaterials: { ...state.customMaterials, [action.material.id]: action.material } };
    default:
      return state;
  }
};

const toCssVariables = selection => {
  const params = selection.materialParameters;
  return {
    '--material-opacity': params.opacity,
    '--material-blur': `${params.blur}px`,
    '--material-saturation': params.saturation,
    '--material-brightness': params.brightness,
    '--material-border-opacity': params.borderOpacity,
    '--material-shadow-opacity': params.shadowOpacity,
    '--material-highlight-opacity': params.highlightOpacity,
    '--material-glow': params.glow,
    '--material-noise': params.noise,
    '--material-radius': `${params.radius}px`
  };
};

const readStoredState = () => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeState(JSON.parse(stored)) : normalizeState(defaultMaterialState);
  } catch {
    return defaultMaterialState;
  }
};

const MaterialContext = createContext(null);

export function MaterialProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, defaultMaterialState, readStoredState);
  const workspaceMaterial = useMemo(() => ({
    ...getMaterialDefinition(state.workspaceDefault.materialId, state.customMaterials),
    baseParameters: state.workspaceDefault.materialParameters
  }), [state.workspaceDefault, state.customMaterials]);

  useEffect(() => {
    const variables = toCssVariables(state.workspaceDefault);
    Object.entries(variables).forEach(([name, value]) => document.documentElement.style.setProperty(name, value));
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Storage is optional. */ }
  }, [state]);

  const value = useMemo(() => ({
    state,
    registry: { ...MATERIAL_REGISTRY, ...state.customMaterials },
    material: workspaceMaterial,
    materialOptions: Object.values({ ...MATERIAL_REGISTRY, ...state.customMaterials }),
    getWindowMaterial: windowId => {
      const selection = state.windowOverride[windowId] || state.workspaceDefault;
      return {
        ...getMaterialDefinition(selection.materialId, state.customMaterials),
        baseParameters: selection.materialParameters
      };
    },
    getMaterialStyle: windowId => toCssVariables(state.windowOverride[windowId] || state.workspaceDefault),
    setWorkspaceMaterial: materialId => dispatch({ type: 'SET_WORKSPACE_MATERIAL', selection: { materialId } }),
    setWorkspaceParameter: (key, value) => dispatch({ type: 'SET_WORKSPACE_PARAMETER', key, value }),
    setWindowOverride: (windowId, selection) => dispatch({ type: 'SET_WINDOW_OVERRIDE', windowId, selection }),
    resetMaterial: () => dispatch({ type: 'RESET_MATERIAL' }),
    saveCustomMaterial: name => {
      const safeName = String(name || '').trim();
      if (!safeName) return null;
      const id = `custom-${safeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || Date.now()}`;
      const material = createCustomMaterial({ id, name: safeName, description: '用户保存的材质预设。', parameters: state.workspaceDefault.materialParameters });
      dispatch({ type: 'SAVE_CUSTOM_MATERIAL', material });
      return material;
    }
  }), [state, workspaceMaterial]);

  return <MaterialContext.Provider value={value}>{children}</MaterialContext.Provider>;
}

export const useMaterial = () => {
  const value = useContext(MaterialContext);
  if (!value) throw new Error('useMaterial must be used inside MaterialProvider');
  return value;
};

export { toCssVariables };
