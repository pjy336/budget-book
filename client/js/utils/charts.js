/**
 * 预算魔法账本 · 轻量图表工具（原生 SVG，零依赖）
 * 提供：分类占比环形图、收支趋势柱状图
 * 所有渲染均基于受控 DOM API 构建 SVG，避免 XSS 注入。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 创建 SVG 元素 */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

/** 将字符串安全写入元素文本（不渲染 HTML） */
function setText(el, text) {
  el.textContent = text == null ? '' : String(text);
}

/**
 * 分类占比环形图
 * @param {HTMLElement} container 容器元素
 * @param {Array<{label:string, value:number, color:string}>} segments 数据段
 * @param {string} centerTitle 中心标题
 * @param {string} centerValue  中心数值
 */
export function renderDonutChart(container, segments, centerTitle, centerValue) {
  container.innerHTML = '';
  if (!segments.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    setText(empty, '暂无数据');
    container.appendChild(empty);
    return;
  }

  const SIZE = 168;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R = 60;
  const STROKE = 26;
  const CIRC = 2 * Math.PI * R;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    class: 'donut-chart__svg',
    role: 'img',
    'aria-label': '分类支出占比环形图',
  });

  // 底环
  svg.appendChild(svgEl('circle', {
    cx: CX, cy: CY, r: R,
    fill: 'none',
    stroke: 'var(--chart-track, #eceef3)',
    'stroke-width': STROKE,
  }));

  // 数据环（顺时针从 12 点开始）
  let angle = -Math.PI / 2;
  segments.forEach((seg) => {
    const ratio = seg.value <= 0 ? 0 : seg.value / Math.max(segments.reduce((s, x) => s + x.value, 0), 1e-9);
    const arc = ratio * CIRC;
    // 计算圆弧起点
    const x0 = CX + R * Math.cos(angle);
    const y0 = CY + R * Math.sin(angle);
    const x1 = CX + R * Math.cos(angle + 2 * Math.PI * ratio);
    const y1 = CY + R * Math.sin(angle + 2 * Math.PI * ratio);
    const largeArc = ratio > 0.5 ? 1 : 0;
    const path = svgEl('path', {
      d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      fill: 'none',
      stroke: seg.color,
      'stroke-width': STROKE,
    });
    path.setAttribute('stroke-linecap', ratio >= 0.995 ? 'round' : 'butt');
    svg.appendChild(path);
    angle += 2 * Math.PI * ratio;
  });

  // 中心文字
  const title = svgEl('text', {
    x: CX, y: CY - 4,
    'text-anchor': 'middle',
    class: 'donut-chart__center-title',
  });
  setText(title, centerTitle);
  const value = svgEl('text', {
    x: CX, y: CY + 18,
    'text-anchor': 'middle',
    class: 'donut-chart__center-value',
  });
  setText(value, centerValue);
  svg.appendChild(title);
  svg.appendChild(value);

  container.appendChild(svg);

  // 图例
  const legend = document.createElement('div');
  legend.className = 'donut-chart__legend';
  segments.forEach((seg) => {
    const item = document.createElement('div');
    item.className = 'donut-chart__legend-item';
    const dot = document.createElement('span');
    dot.className = 'donut-chart__legend-dot';
    dot.style.backgroundColor = seg.color;
    const label = document.createElement('span');
    label.className = 'donut-chart__legend-label';
    setText(label, seg.label);
    const val = document.createElement('span');
    val.className = 'donut-chart__legend-value';
    setText(val, seg.value);
    item.append(dot, label, val);
    legend.appendChild(item);
  });
  container.appendChild(legend);
}

/**
 * 收支趋势柱状图（按日/月聚合）
 * @param {HTMLElement} container 容器元素
 * @param {Array<{label:string, income:number, expense:number}>} series 数据序列
 */
export function renderTrendChart(container, series) {
  container.innerHTML = '';
  if (!series.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    setText(empty, '暂无数据');
    container.appendChild(empty);
    return;
  }

  const W = 320;
  const H = 150;
  const PAD = { top: 12, right: 8, bottom: 24, left: 34 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const maxVal = Math.max(...series.flatMap((d) => [d.income, d.expense]), 1);
  const maxRounded = niceMax(maxVal);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'trend-chart__svg',
    role: 'img',
    'aria-label': '收支趋势柱状图',
    preserveAspectRatio: 'none',
  });

  // 网格线（4 条水平线 + y 轴标签）
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = PAD.top + plotH - (plotH * i) / gridCount;
    const line = svgEl('line', {
      x1: PAD.left, y1: y.toFixed(2), x2: W - PAD.right, y2: y.toFixed(2),
      class: 'trend-chart__grid',
    });
    svg.appendChild(line);
    const label = svgEl('text', {
      x: PAD.left - 4, y: y + 3, 'text-anchor': 'end',
      class: 'trend-chart__axis-label',
    });
    setText(label, formatAxisValue((maxRounded * i) / gridCount));
    svg.appendChild(label);
  }

  // 柱子
  const slot = plotW / series.length;
  const barW = Math.min(slot * 0.32, 14);
  const gap = (slot - barW * 2) / 3;

  series.forEach((d, idx) => {
    const cx = PAD.left + slot * idx + slot / 2;
    // 支出柱（绿色系）
    const eh = (d.expense / maxRounded) * plotH;
    if (eh > 0) {
      svg.appendChild(svgEl('rect', {
        x: (cx - barW - gap / 2).toFixed(2),
        y: (PAD.top + plotH - eh).toFixed(2),
        width: barW.toFixed(2),
        height: eh.toFixed(2),
        rx: 2,
        class: 'trend-chart__bar trend-chart__bar--expense',
      }));
    }
    // 收入柱（蓝色系）
    const ih = (d.income / maxRounded) * plotH;
    if (ih > 0) {
      svg.appendChild(svgEl('rect', {
        x: (cx + gap / 2).toFixed(2),
        y: (PAD.top + plotH - ih).toFixed(2),
        width: barW.toFixed(2),
        height: ih.toFixed(2),
        rx: 2,
        class: 'trend-chart__bar trend-chart__bar--income',
      }));
    }
    // x 轴标签（稀疏显示，最多 ~8 个）
    const step = Math.ceil(series.length / 8);
    if (idx % step === 0 || idx === series.length - 1) {
      const label = svgEl('text', {
        x: cx, y: H - 6, 'text-anchor': 'middle',
        class: 'trend-chart__axis-label',
      });
      setText(label, d.label);
      svg.appendChild(label);
    }
  });

  container.appendChild(svg);

  // 图例
  const legend = document.createElement('div');
  legend.className = 'trend-chart__legend';
  legend.append(
    legendItem('支出', 'trend-chart__legend-dot--expense'),
    legendItem('收入', 'trend-chart__legend-dot--income'),
  );
  container.appendChild(legend);
}

function legendItem(text, cls) {
  const item = document.createElement('div');
  item.className = 'trend-chart__legend-item';
  const dot = document.createElement('span');
  dot.className = `trend-chart__legend-dot ${cls}`;
  const label = document.createElement('span');
  setText(label, text);
  item.append(dot, label);
  return item;
}

/** 计算美观的最大刻度值（1/2/5 × 10^n） */
function niceMax(v) {
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  let nice;
  if (m <= 1) nice = 1;
  else if (m <= 2) nice = 2;
  else if (m <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/** y 轴数值格式化：≥10000 显示 x.x万 */
function formatAxisValue(v) {
  if (v >= 10000) {
    const w = v / 10000;
    return `${w >= 10 ? Math.round(w) : w.toFixed(1)}万`;
  }
  return `${Math.round(v)}`;
}
