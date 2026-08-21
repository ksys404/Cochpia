import { useCallback, useEffect, useState } from 'react';
const CORE_CATEGORIES = ['skin', 'base', 'eyes', 'clothes', 'hair'];
const COLOR_PALETTES = {
  hair: ['#241b1b', '#5b3524', '#9b632f', '#d49a45', '#e1c29a', '#8b4b68', '#526c9b', '#6e8b65'],
  eyes: ['#2c2524', '#5b3929', '#4d9fb2', '#557c55', '#7182b8', '#956083', '#d49b4b'],
  clothes: ['#26384b', '#385f78', '#557c70', '#728b57', '#9d734f', '#a95654', '#80649c', '#d1a64e']
};
const COLOR_NAMES = { hair: '发色', eyes: '眼睛颜色', clothes: '服装颜色' };

function PartThumb({ part, active, onClick }) {
  return (
    <button type="button" className={`char-part ${active ? 'active' : ''}`} onClick={onClick} title={part.label} aria-label={part.label}>
      <span className="char-part-crop"><img src={part.path} alt="" /></span>
      <small>{part.label}</small>
    </button>
  );
}

export default function CharacterComposer({ onUseAvatar, onUseCharacterSheet, provider }) {
  if (!provider) throw new Error('CharacterComposer requires a character asset provider');
  const [bodySlug, setBodySlug] = useState(() => provider.getBodyTypes()[0]?.slug || 'default');
  const [selections, setSelections] = useState({});
  const [colors, setColors] = useState({});
  const [previewUrl, setPreviewUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const categories = provider.getCategories(bodySlug);

  const render = useCallback(async () => {
    setBusy(true);
    try {
      const sheet = await provider.composeSprite(bodySlug, selections, colors);
      const preview = document.createElement('canvas');
      preview.width = 96 * 3; preview.height = 128 * 3;
      const ctx = preview.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sheet, 0, 0, preview.width, preview.height);
      setPreviewUrl(preview.toDataURL());
    } catch { setPreviewUrl(null); }
    finally { setBusy(false); }
  }, [bodySlug, selections, colors]);

  useEffect(() => { render(); }, [render]);

  const changeBody = slug => { setBodySlug(slug); setSelections({}); setColors({}); };
  const pick = (catSlug, file) => setSelections(s => ({ ...s, [catSlug]: file || undefined }));
  const setColor = (catSlug, color) => setColors(s => ({ ...s, [catSlug]: color }));
  const randomize = () => {
    const next = {};
    for (const cat of categories) {
      if (CORE_CATEGORIES.includes(cat.slug) || Math.random() < 0.45) next[cat.slug] = cat.parts[Math.floor(Math.random() * cat.parts.length)].file;
    }
    setSelections(next);
    setColors({ hair: COLOR_PALETTES.hair[Math.floor(Math.random() * COLOR_PALETTES.hair.length)], eyes: COLOR_PALETTES.eyes[Math.floor(Math.random() * COLOR_PALETTES.eyes.length)], clothes: COLOR_PALETTES.clothes[Math.floor(Math.random() * COLOR_PALETTES.clothes.length)] });
  };
  const useAsAvatar = async () => {
    setBusy(true);
    try {
      const sheet = provider.exportCharacterSheet ? await provider.exportCharacterSheet(bodySlug, selections, colors) : await provider.composeSprite(bodySlug, selections, colors);
      const avatar = await provider.exportAvatar(bodySlug, selections, 6, colors);
      onUseAvatar?.(avatar);
      onUseCharacterSheet?.(sheet.toDataURL('image/png'), provider.animationSpec || provider.getProviderInfo?.().animation);
      setNotice('已保存头像与场景行走图 ✓');
      window.setTimeout(() => setNotice(''), 2000);
    }
    catch { setNotice('导出失败,请重试'); }
    finally { setBusy(false); }
  };

  return (
    <div className="char-composer">
      <div className="char-composer-stage">
        <div className="char-composer-preview">{previewUrl ? <img src={previewUrl} alt="立绘预览" /> : <span className="char-composer-loading">合成中…</span>}</div>
        <div className="char-composer-actions"><button type="button" className="select-model" onClick={randomize} disabled={busy}>🎲 随机</button><button type="button" className="select-model" onClick={useAsAvatar} disabled={busy}>用作头像</button>{notice && <span className="char-composer-notice">{notice}</span>}</div>
      </div>
      <div className="char-composer-provider-note">当前测试素材提供器：{provider.label}</div>
      <div className="char-composer-bodytypes" role="group" aria-label="体型">{provider.getBodyTypes().map(b => <button key={b.slug} type="button" className={`char-bodytype ${b.slug === bodySlug ? 'active' : ''}`} onClick={() => changeBody(b.slug)}>{b.name}</button>)}</div>
      <div className="char-composer-cats">
        {categories.map(cat => <section key={cat.slug} className="char-composer-category"><div className="char-category-head"><strong>{cat.name}</strong><span>{cat.parts.length} 个选择</span></div><div className="char-parts-grid"><button type="button" className={`char-part char-part-none ${!selections[cat.slug] ? 'active' : ''}`} onClick={() => pick(cat.slug, '')}>无</button>{cat.parts.map(part => <PartThumb key={part.file} part={part} active={selections[cat.slug] === part.file} onClick={() => pick(cat.slug, part.file)} />)}</div>{COLOR_PALETTES[cat.slug] && <div className="char-color-row"><span>{COLOR_NAMES[cat.slug]}</span>{COLOR_PALETTES[cat.slug].map(color => <button key={color} type="button" className={`char-color ${colors[cat.slug] === color ? 'active' : ''}`} style={{ backgroundColor: color }} onClick={() => setColor(cat.slug, color)} aria-label={`${COLOR_NAMES[cat.slug]} ${color}`} />)}<input type="color" value={colors[cat.slug] || '#6b7280'} onChange={e => setColor(cat.slug, e.target.value)} aria-label={`自定义${COLOR_NAMES[cat.slug]}`} /></div>}</section>)}
      </div>
    </div>
  );
}
