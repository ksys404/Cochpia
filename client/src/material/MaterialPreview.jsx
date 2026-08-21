import React, { useState } from 'react';
import { MATERIAL_PARAMETER_KEYS } from './materialRegistry';
import { useMaterial } from './MaterialProvider';

const labels = {
  opacity: ['透明度', 0, 1, 0.01],
  blur: ['模糊', 0, 40, 1],
  saturation: ['饱和度', 0.6, 1.6, 0.01],
  brightness: ['亮度', 0.7, 1.3, 0.01],
  borderOpacity: ['边框透明度', 0, 1, 0.01],
  shadowOpacity: ['阴影透明度', 0, 0.5, 0.01],
  highlightOpacity: ['高光透明度', 0, 1, 0.01],
  glow: ['环境光', 0, 0.5, 0.01],
  noise: ['噪点', 0, 0.2, 0.01],
  radius: ['圆角', 0, 40, 1]
};

export function MaterialPreview() {
  const [customName, setCustomName] = useState('');
  const { state, materialOptions, material, setWorkspaceMaterial, setWorkspaceParameter, resetMaterial, saveCustomMaterial } = useMaterial();
  const parameters = state.workspaceDefault.materialParameters;

  return <section className="material-preview" aria-labelledby="material-preview-title">
    <div className="section-heading"><span id="material-preview-title">材质预览</span><button type="button" className="text-button" onClick={resetMaterial}>重置</button></div>
    <div className="material-preview-surface" style={{ '--preview-material-radius': `${parameters.radius}px` }}>
      <strong>{material.name}</strong>
      <span>{material.description}</span>
    </div>
    <label className="material-select-label">工作区默认材质<select value={state.workspaceDefault.materialId} onChange={event => setWorkspaceMaterial(event.target.value)}>{materialOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    <div className="material-parameters">{MATERIAL_PARAMETER_KEYS.map(key => { const [label, min, max, step] = labels[key]; return <label className="material-parameter" key={key}><span>{label}<b>{key === 'blur' || key === 'radius' ? `${Math.round(parameters[key])}px` : Math.round(parameters[key] * 100) + '%'}</b></span><input type="range" min={min} max={max} step={step} value={parameters[key]} onChange={event => setWorkspaceParameter(key, Number(event.target.value))} /></label>; })}</div>
    <div className="material-save-row"><input value={customName} onChange={event => setCustomName(event.target.value)} placeholder="自定义材质名称" aria-label="自定义材质名称" /><button type="button" className="text-button material-save" disabled={!customName.trim()} onClick={() => { saveCustomMaterial(customName); setCustomName(''); }}>保存为自定义材质</button></div>
  </section>;
}
