/**
 * 预算魔法账本 · 格式化工具
 */

/** 金额格式化：¥1,234.56（千分位 + 两位小数） */
export function fmtMoney(n) {
  return `¥${Number(n || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** HTML 转义，防止用户输入注入 */
export function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
