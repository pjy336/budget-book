/**
 * 预算魔法账本 · 日期工具
 * 所有日期统一使用 yyyy-MM-dd 字符串（账目日期）与 ISO 8601（时间戳），见 docs/03-data-struct.md
 */

/** 数字补零 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 当前日期字符串 yyyy-MM-dd */
export function todayStr() {
  return toDateStr(new Date());
}

/** Date -> yyyy-MM-dd（本地时区） */
export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** yyyy-MM-dd -> Date（本地时区，避免 UTC 偏移问题） */
export function parseDateStr(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 日期字符串加减天数，返回 yyyy-MM-dd */
export function addDays(dateStr, days) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

/** yyyy-MM -> "2026年8月" */
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}年${m}月`;
}

/** yyyy-MM 平移 delta 个月 */
export function monthShift(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 返回指定月份的首末日 [start, end] */
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = toDateStr(new Date(y, m - 1, 1));
  const end = toDateStr(new Date(y, m, 0));
  return [start, end];
}

/** 是否为合法 yyyy-MM-dd */
export function isDateStr(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}
