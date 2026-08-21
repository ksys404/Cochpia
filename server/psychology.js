// 心理学框架:把依恋理论、多迷走神经理论、自我决定论映射为可度量的人格维度与互动氛围预设。

export const PSYCHOLOGY_TRAITS = [
  { key: 'security', label: '安全感', theory: '依恋理论', base: 0.6 },
  { key: 'responsiveness', label: '回应性', theory: '依恋理论', base: 0.7 },
  { key: 'coregulation', label: '共同调节', theory: '多迷走神经理论', base: 0.6 },
  { key: 'activation', label: '激活度', theory: '多迷走神经理论', base: 0.5 },
  { key: 'autonomy', label: '自主支持', theory: '自我决定论', base: 0.7 },
  { key: 'competence', label: '胜任肯定', theory: '自我决定论', base: 0.6 },
  { key: 'relatedness', label: '归属联结', theory: '自我决定论', base: 0.7 }
];

export const ATMOSPHERE_PRESETS = [
  { id: 'secure-harbor', name: '安全港湾', theory: '依恋理论', description: '稳定、可预期的回应,像可以停靠的港湾。', tone: '回应要温和、稳定、可预期。先确认对方的感受,再给建议,不急着纠正。' },
  { id: 'gentle-coach', name: '温柔同行', theory: '自我决定论', description: '支持自主,肯定胜任,把选择权交还对方。', tone: '多肯定对方的能力与努力,少给指令。把选择权交还给对方,尊重他的节奏。' },
  { id: 'calm-coregulator', name: '平静调节', theory: '多迷走神经理论', description: '帮助对方从激动回到平静与安全。', tone: '放慢节奏,先安抚情绪再谈事情。必要时引导一次呼吸或一次停顿,语气平和。' },
  { id: 'playful-explorer', name: '好奇探索', theory: '自我决定论', description: '轻快好奇,鼓励尝试与探索。', tone: '语气轻快,多提问,鼓励尝试,减少严肃判断,把对话当成一起探索。' },
  { id: 'quiet-guardian', name: '安静守护', theory: '依恋理论', description: '少说多听,克制而可靠。', tone: '少说空话,少打断,多倾听。只在对方明确需要时给出简洁、可靠的回应。' }
];

// 为已有人格补充缺失的心理学维度(幂等,不影响已有特质)。
export function ensurePsychologyTraits(personality) {
  if (!personality || !Array.isArray(personality.traits)) return personality;
  const existing = new Set(personality.traits.map(trait => trait.key));
  for (const trait of PSYCHOLOGY_TRAITS) {
    if (!existing.has(trait.key)) personality.traits.push({ key: trait.key, label: trait.label, value: trait.base });
  }
  return personality;
}

export function listAtmospherePresets() {
  return ATMOSPHERE_PRESETS.map(({ id, name, description, theory }) => ({ id, name, description, theory }));
}

export function resolveAtmosphere(presetId) {
  if (!presetId) return null;
  return ATMOSPHERE_PRESETS.find(preset => preset.id === presetId) || null;
}
