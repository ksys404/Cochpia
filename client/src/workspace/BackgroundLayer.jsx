import React from 'react';
import { useWorkspacePreferences } from './WorkspacePreferencesProvider';

const particles = [
  ['bubble bubble-a', '泡沫'], ['bubble bubble-b', '泡沫'], ['bubble bubble-c', '泡沫'],
  ['dandelion-seed seed-a', '蒲公英种子'], ['dandelion-seed seed-b', '蒲公英种子'], ['dandelion-seed seed-c', '蒲公英种子'], ['dandelion-seed seed-d', '蒲公英种子']
];

export function BackgroundLayer() {
  const { state } = useWorkspacePreferences();
  const { background, motion } = state;
  const style = {
    '--ambient-background-image': background.imageUrl ? `url(${background.imageUrl})` : 'none',
    '--ambient-gradient': background.gradient || 'none',
    '--ambient-overlay-opacity': background.overlayOpacity
  };
  const visibleParticles = motion.animationLevel === 'low' ? particles.slice(0, 2) : motion.animationLevel === 'medium' ? particles.slice(0, 5) : particles;
  return <div className={`ambient-layer ambient-${motion.animationLevel || 'medium'} ${background.animationEnabled ? 'ambient-enabled' : 'ambient-disabled'}`} style={style} aria-hidden="true">
    <div className="ambient-image" />
    <div className="ambient-gradient" />
    <div className="ambient-blob blob-a" />
    <div className="ambient-blob blob-b" />
    <div className="ambient-light" />
    <div className="ambient-particles">{visibleParticles.map(([className, label], index) => <span className={className} key={`${className}-${index}`} aria-label={label} />)}</div>
    <div className="ambient-overlay" />
  </div>;
}
