import React from 'react';
import { getTypographyFont } from './typographyRegistry';

export function TypographyPreview({ typography }) {
  const font = getTypographyFont(typography.fontFamily);
  const previewStyle = {
    '--preview-font-family': font.stack,
    '--preview-font-weight': typography.fontWeight,
    '--preview-letter-spacing': `${typography.letterSpacing}px`,
    '--preview-line-height': typography.lineHeight,
    '--preview-scale': typography.fontScale
  };

  return <div className="typography-preview" style={previewStyle} aria-label="Typography preview">
    <div className="typography-preview-meta"><span>Preview</span><b>{font.name}</b></div>
    <p className="typography-preview-display">Aa</p>
    <p className="typography-preview-title">Still becoming, one quiet thought at a time.</p>
    <p className="typography-preview-body">The quick brown fox jumps over the lazy dog. 0123456789</p>
  </div>;
}
