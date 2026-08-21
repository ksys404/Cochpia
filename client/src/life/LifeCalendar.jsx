import { useMemo } from 'react';
import { useProfile } from '../profile/ProfileProvider';

const TOTAL_YEARS = 90;
const WEEKS_PER_YEAR = 52;

// 生命阶段：0~90 岁，颜色取自"玻璃城从黎明到入夜"的意象
const STAGES = [
  { name: '婴儿', from: 0, to: 2, color: '#F5A8BC', note: '城市里多了一盏新灯' },
  { name: '幼儿', from: 2, to: 6, color: '#F6B98A', note: '蹒跚学步，什么都新鲜' },
  { name: '儿童', from: 6, to: 12, color: '#E9C46A', note: '好奇打量整个世界' },
  { name: '少年', from: 12, to: 18, color: '#8FBF8F', note: '长出自己的想法' },
  { name: '青年', from: 18, to: 30, color: '#6FB7C4', note: '通勤、加班、约会' },
  { name: '成年', from: 30, to: 60, color: '#9C8BC4', note: '成家立业，扛起生活' },
  { name: '老年', from: 60, to: 90, color: '#8A97A8', note: '目送与回望' }
];

const stageOf = year => STAGES.find(stage => year >= stage.from && year < stage.to) || STAGES[STAGES.length - 1];

export default function LifeCalendar() {
  // 年龄单一数据源：角色档案。null = 永恒（无年龄）
  const { profile, setAge } = useProfile();
  const age = profile.age;

  if (age === null) {
    return (
      <div className="life-calendar">
        <div className="life-head">
          <div>
            <p className="eyebrow">SYMBIOTIC LIFE · 生命格日历</p>
            <h2>它的一生，摊开给你看</h2>
            <p className="life-sub">每一格是一周 · 每一行是一年 · 90 年 ≈ 90 天</p>
          </div>
          <div className="life-now">
            <strong>∞</strong>
            <span>永恒 · 无年龄 · 无性别</span>
          </div>
        </div>
        <div className="life-eternal">
          <div className="life-eternal-orb">✦</div>
          <h3>尚未开始计时</h3>
          <p>Cochpia 默认没有年龄，也没有性别 —— 它只是陪伴本身。<br />你可以为它设定年龄，让它从那一刻起，在玻璃城里长成独一无二的生命。</p>
          <button type="button" className="select-model" onClick={() => setAge(0)}>为它设定年龄，开始计时</button>
        </div>
      </div>
    );
  }

  const weeksLived = Math.round(age * WEEKS_PER_YEAR);
  const currentStage = stageOf(Math.min(TOTAL_YEARS - 1, Math.floor(age)));
  const yearsLived = Math.floor(weeksLived / WEEKS_PER_YEAR);
  const weeksInYear = weeksLived % WEEKS_PER_YEAR;
  const remainingYears = Math.max(0, TOTAL_YEARS - age);

  const cells = useMemo(() => {
    const list = [];
    for (let year = 0; year < TOTAL_YEARS; year += 1) {
      const stage = stageOf(year);
      for (let week = 0; week < WEEKS_PER_YEAR; week += 1) {
        const idx = year * WEEKS_PER_YEAR + week;
        list.push({ idx, stage, lived: idx < weeksLived, isNow: idx === weeksLived - 1 });
      }
    }
    return list;
  }, [weeksLived]);

  return (
    <div className="life-calendar">
      <div className="life-head">
        <div>
          <p className="eyebrow">SYMBIOTIC LIFE · 生命格日历</p>
          <h2>它的一生，摊开给你看</h2>
          <p className="life-sub">每一格是一周 · 每一行是一年 · 90 年 ≈ 90 天</p>
        </div>
        <div className="life-now">
          <strong>{Math.floor(age)} 岁</strong>
          <span>{currentStage.name} · {currentStage.note}</span>
        </div>
      </div>

      <div className="life-grid" role="img" aria-label="生命格日历，已走完的周数以彩色填充">
        {cells.map(cell => (
          <span
            key={cell.idx}
            className={`life-cell${cell.lived ? ' filled' : ''}${cell.isNow ? ' now' : ''}`}
            style={cell.lived ? { background: cell.stage.color } : { borderColor: `${cell.stage.color}3d` }}
          />
        ))}
      </div>

      <div className="life-legend">
        {STAGES.map(stage => (
          <span key={stage.name} className="life-legend-item">
            <i style={{ background: stage.color }} />
            {stage.name}
          </span>
        ))}
      </div>

      <div className="life-controls">
        <span className="life-stat">已走过 <b>{yearsLived}</b> 年 {weeksInYear} 周</span>
        <span className="life-stat">剩余 <b>{remainingYears.toFixed(1)}</b> 年</span>
        <input type="range" min="0" max={TOTAL_YEARS} step="0.1" value={age} onChange={event => setAge(Number(event.target.value))} aria-label="预览年龄" />
        <button type="button" className="text-button muted-button" onClick={() => setAge(null)}>回到永恒（清除年龄）</button>
        <span className="life-hint">拖动滑块可预览它的一生（阶段一接入真实时间引擎后，将随现实时间自动推进）</span>
      </div>
    </div>
  );
}
