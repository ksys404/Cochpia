import { useEffect, useState } from 'react';

const DEFAULT_ANIMATION = {
  frameWidth: 32,
  frameHeight: 32,
  frames: 3,
  directions: ['down', 'left', 'right', 'up'],
  rowByDirection: { down: 0, left: 1, right: 2, up: 3 },
  playbackMs: 180
};

/** 通用场景精灵：播放完整角色表，不依赖具体素材包。 */
export default function CharacterSprite({ sheet, animation = DEFAULT_ANIMATION, direction = 'down', walking = true, scale = 2, alt = '' }) {
  const [frame, setFrame] = useState(1);
  const row = animation.rowByDirection?.[direction] ?? 0;
  useEffect(() => {
    if (!walking || animation.frames < 2) { setFrame(1); return undefined; }
    const timer = window.setInterval(() => setFrame(current => (current + 1) % animation.frames), animation.playbackMs || 180);
    return () => window.clearInterval(timer);
  }, [walking, animation.frames, animation.playbackMs]);
  if (!sheet) return <span className="character-sprite-fallback" aria-label={alt}>✦</span>;
  const width = animation.frameWidth * scale;
  const height = animation.frameHeight * scale;
  return <span className="character-sprite" role={alt ? 'img' : undefined} aria-label={alt} style={{ width, height }}>
    <img src={sheet} alt="" draggable="false" style={{ width: animation.frameWidth * animation.frames * scale, height: animation.frameHeight * animation.directions.length * scale, transform: `translate(${-frame * width}px, ${-row * height}px)` }} />
  </span>;
}
