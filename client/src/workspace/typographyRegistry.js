export const typographyRegistry = [
  { id: 'system', name: 'System', stack: 'ui-sans-serif, system-ui, sans-serif' },
  { id: 'inter', name: 'Inter', stack: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  { id: 'geist', name: 'Geist', stack: 'Geist, Inter, ui-sans-serif, system-ui, sans-serif' },
  { id: 'noto-sans', name: 'Noto Sans', stack: '"Noto Sans", Inter, ui-sans-serif, system-ui, sans-serif' },
  { id: 'noto-serif', name: 'Noto Serif', stack: '"Noto Serif", Georgia, serif' },
  { id: 'plex-sans', name: 'IBM Plex Sans', stack: '"IBM Plex Sans", Inter, ui-sans-serif, system-ui, sans-serif' },
  { id: 'plex-mono', name: 'IBM Plex Mono', stack: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace' },
  { id: 'serif', name: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'monospace', name: 'Monospace', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
];

export const getTypographyFont = id => typographyRegistry.find(font => font.id === id) || typographyRegistry[0];
