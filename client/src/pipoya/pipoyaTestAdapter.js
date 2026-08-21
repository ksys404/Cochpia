import manifest from './manifest.json';

// 开发测试适配器：Pipoya 不是主角色系统的固定实现。
// 角色档案只依赖下方 provider 接口，正式美术可替换为其他 adapter。
export const providerId = 'pipoya-test';
export const providerLabel = 'Pipoya 测试素材';
export const animationSpec = {
  frameWidth: 32,
  frameHeight: 32,
  frames: 3,
  directions: ['down', 'left', 'right', 'up'],
  rowByDirection: { down: 0, left: 1, right: 2, up: 3 },
  playbackMs: 180
};

const FRAME_W = 32;
const FRAME_H = 32;
const SHEET_W = 96;
const SHEET_H = 128;

export function getProviderInfo() {
  return { id: providerId, label: providerLabel, kind: 'sprite-sheet-composer', status: 'development-only', animation: animationSpec };
}

export function getBodyTypes() {
  return manifest.bodyTypes;
}

export function getCategoryOrder() {
  return [...manifest.categories].sort((a, b) => a.order - b.order);
}

// 返回某体型下「有部件」的分类(按图层顺序)
export function getCategories(bodySlug) {
  const body = manifest.bodyTypes.find(item => item.slug === bodySlug);
  if (!body) return [];
  return getCategoryOrder().map(cat => ({
    slug: cat.slug,
    name: cat.name,
    order: cat.order,
    parts: body.categories?.[cat.slug]?.parts || []
  })).filter(cat => cat.parts.length > 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`加载失败: ${src}`));
    img.src = src;
  });
}

// 合成整张精灵表(96×128),按图层顺序叠加
export async function composeSprite(bodySlug, selections = {}, colors = {}) {
  const body = manifest.bodyTypes.find(item => item.slug === bodySlug);
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (const cat of getCategoryOrder()) {
    const file = selections[cat.slug];
    if (!file) continue;
    const part = body?.categories?.[cat.slug]?.parts?.find(p => p.file === file);
    if (!part) continue;
    try {
      const img = await loadImage(part.path);
      const tint = colors[cat.slug];
      if (tint) {
        const layer = document.createElement('canvas');
        layer.width = SHEET_W;
        layer.height = SHEET_H;
        const layerCtx = layer.getContext('2d');
        layerCtx.imageSmoothingEnabled = false;
        layerCtx.drawImage(img, 0, 0, SHEET_W, SHEET_H);
        layerCtx.globalCompositeOperation = 'source-atop';
        layerCtx.globalAlpha = 0.62;
        layerCtx.fillStyle = tint;
        layerCtx.fillRect(0, 0, SHEET_W, SHEET_H);
        layerCtx.globalAlpha = 1;
        ctx.drawImage(layer, 0, 0);
      } else {
        ctx.drawImage(img, 0, 0, SHEET_W, SHEET_H);
      }
    } catch { /* 跳过加载失败的部件 */ }
  }
  return canvas;
}

// 裁出正面前方第一帧(32×32),放大 scale 倍,导出为头像 dataURL
export async function exportCharacterSheet(bodySlug, selections, colors = {}) {
  return composeSprite(bodySlug, selections, colors);
}

export async function exportAvatar(bodySlug, selections, scale = 6, colors = {}) {
  const sheet = await composeSprite(bodySlug, selections, colors);
  const out = document.createElement('canvas');
  out.width = FRAME_W * scale;
  out.height = FRAME_H * scale;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, 0, 0, FRAME_W, FRAME_H, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// 裁出单个部件的第一帧,用于缩略图
export const pipoyaTestAdapter = {
  id: providerId,
  label: providerLabel,
  getProviderInfo,
  getBodyTypes,
  getCategoryOrder,
  getCategories,
  composeSprite,
  exportAvatar,
  exportCharacterSheet,
  animationSpec,
  cropFirstFrame
};

export function cropFirstFrame(dataUrl, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = FRAME_W * scale;
      c.height = FRAME_H * scale;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, FRAME_W, FRAME_H, 0, 0, c.width, c.height);
      resolve(c.toDataURL());
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
