/**
 * 预算魔法账本 · 主逻辑脚本
 */

import {
  todayStr,
  monthLabel,
  monthShift,
  monthRange,
  addDays,
} from './utils/date.js';
import { fmtMoney, esc } from './utils/format.js';
import { getBillAnalysis, AI_ERROR } from './ai-service.js';
import { renderDonutChart, renderTrendChart } from './utils/charts.js';

function genIdFallback(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const state = {
  settings: null,
  categories: [],
  categoriesLoaded: false,
  transactions: [],
  budgets: [],
  month: '',
  currentView: 'home',
  formType: 'expense',
  selectedCatId: '',
  editingId: null,
  pendingDeleteId: null,
  range: { mode: 'month', start: '', end: '' },
  aiBills: null,
  aiModalTitle: 'AI 账单分析',
  aiAbort: null,
  budgetCatId: null,
};

let savingTx = false;
let savingBudget = false;
let aiRequestRunning = false;

let el = {};

let storageModule = null;
async function useStorage() {
  if (!storageModule) {
    try {
      storageModule = await import('./storage.js');
    } catch (err) {
      console.warn('storage.js 加载异常', err);
      storageModule = {};
    }
  }
  return storageModule;
}

/**
 * 增强版查找分类：区分「加载中/匹配成功/匹配失败」三种状态
 */
function findCategory(id, billType = 'expense') {
  // 分类尚未加载完成时，返回占位状态，不触发兜底
  if (!state.categoriesLoaded) {
    return {
      id: id,
      name: '加载中…',
      icon: '⏳',
      color: '#94A3B8'
    };
  }

  // 1. 精确匹配分类ID
  const target = state.categories.find(c => c.id === id);
  if (target) return target;

  // 2. 兜底：取同类型第一个分类
  const fallback = state.categories.find(c => c.type === billType);
  if (fallback) return fallback;

  // 3. 最终兜底：仅在分类加载完成且确实找不到时触发
  console.warn(`未找到分类ID: ${id}，已使用默认兜底`);
  return billType === 'income'
    ? { id: 'salary', name: '工资', icon: '💰', color: '#3B82F6' }
    : { id: 'food', name: '餐饮', icon: '🍔', color: '#10B981' };
}

function monthTxns() {
  return state.transactions.filter((t) => t.date&&t.date.startsWith(state.month));
}

function sumBy(txns, type) {
  return txns.filter((t) => t.type === type).reduce((s, t) => s + Number(t.amount), 0);
}

let toastTimer = null;
function showToast(msg) {
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2000);
}

function switchView(name) {
  state.currentView = name;
  el.views.forEach((v) => v.classList.toggle('view--active', v.dataset.view === name));
  el.tabItems.forEach((t) => t.classList.toggle('tab-item--active', t.dataset.view === name));
}

function getRangeDates() {
  const { mode, start, end } = state.range;
  if (mode === '7d') {
    const today = todayStr();
    return [addDays(today, -6), today];
  }
  if (mode === '30d') {
    const today = todayStr();
    return [addDays(today, -29), today];
  }
  if (mode === 'custom') {
    return start && end ? [start, end] : null;
  }
  if (mode === 'month') {
    return monthRange(state.month);
  }
  return null;
}

function filteredTxns() {
  const range = getRangeDates();
  let list = state.transactions;
  if (range) {
    const [s, e] = range;
    list = list.filter((t) => t.date >= s && t.date <= e);
  }
  return list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

function resetRange() {
  state.range = { mode: 'month', start: '', end: '' };
  el.filterStart.value = '';
  el.filterEnd.value = '';
  updateFilterUI();
}

function setRangeMode(mode) {
  state.range = { mode, start: '', end: '' };
  el.filterStart.value = '';
  el.filterEnd.value = '';
  updateFilterUI();
  renderLedger();
  renderStats();
}

function onCustomRangeChange() {
  let start = el.filterStart.value;
  let end = el.filterEnd.value;
  if (start && end && start > end) {
    [start, end] = [end, start];
    el.filterStart.value = start;
    el.filterEnd.value = end;
  }
  state.range = { mode: 'custom', start, end };
  updateFilterUI();
  renderLedger();
  renderStats();
}

function updateFilterUI() {
  const { mode } = state.range;
  el.filterChips.forEach((chip) => {
    chip.classList.toggle('filter-chip--active', chip.dataset.range === mode);
  });
  const isCustom = mode === 'custom';
  el.filterBadge.hidden = !isCustom;
  el.filterClear.hidden = !isCustom;
  const showSummary = mode !== 'month';
  el.filterSummary.hidden = !showSummary;
  if (showSummary) {
    const range = getRangeDates();
    const count = filteredTxns().length;
    el.filterSummary.textContent = range
      ? `${range[0].slice(5)} – ${range[1].slice(5)} · 共 ${count} 笔`
      : `全部账目 · 共 ${count} 笔`;
  }
}

function renderHome() {
  const txns = monthTxns();
  const income = sumBy(txns, 'income');
  const expense = sumBy(txns, 'expense');
  el.homeIncome.textContent = fmtMoney(income);
  el.homeExpense.textContent = fmtMoney(expense);
  el.homeBalance.textContent = fmtMoney(income - expense);
}

function renderLedger() {
  const txns = filteredTxns();
  const hasAny = state.transactions.length > 0;

  el.ledgerEmpty.hidden = txns.length > 0;
  if (txns.length === 0) {
    el.ledgerEmptyText.textContent = hasAny ? '没有符合条件的账单' : '本月还没有账目';
    el.txnList.innerHTML = '';
    return;
  }

  el.txnList.innerHTML = '';
  const frag = document.createDocumentFragment();
  const groups = new Map();
  txns.forEach((t) => {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  });
  groups.forEach((list, date) => {
    frag.appendChild(dayHeaderEl(date, list));
    list.forEach((t) => frag.appendChild(txnItemEl(t)));
  });
  el.txnList.appendChild(frag);
}

function dayHeaderEl(date, list) {
  const dayExpense = sumBy(list, 'expense');
  const li = document.createElement('li');
  li.className = 'txn-day';
  li.innerHTML = `<span>${date}</span>${
    dayExpense > 0 ? `<span class="txn-day__total">支出 ${fmtMoney(dayExpense)}</span>` : ''
  }`;
  return li;
}

function txnItemEl(t) {
  const cat = findCategory(t.categoryId, t.type);
  const li = document.createElement('li');
  li.className = 'txn-item';
  li.dataset.id = String(t.id);
  li.innerHTML = `
    <span class="txn-item__icon" style="background:${cat.color}1f">${cat.icon}</span>
    <div class="txn-item__info">
      <p class="txn-item__name">${esc(cat.name)}${t.note ? ` · ${esc(t.note)}` : ''}</p>
    </div>
    <span class="txn-item__amount ${t.type}">${t.type === 'expense' ? '-' : '+'}${fmtMoney(Number(t.amount))}</span>
    <div class="txn-item__actions">
      <button type="button" class="txn-item__ai" data-action="ai" aria-label="AI 分析这笔账">AI</button>
      <button type="button" class="txn-item__delete" data-action="delete" aria-label="删除这笔账">✕</button>
    </div>
  `;
  return li;
}

function renderStats() {
  const txns = filteredTxns();
  const income = sumBy(txns, 'income');
  const expense = sumBy(txns, 'expense');
  el.statIncome.textContent = fmtMoney(income);
  el.statExpense.textContent = fmtMoney(expense);
  el.statBalance.textContent = fmtMoney(income - expense);

  renderRankList(el.rankListIncome, el.rankEmptyIncome, buildRankRows(txns, 'income'), income);
  renderRankList(el.rankListExpense, el.rankEmptyExpense, buildRankRows(txns, 'expense'), expense);

  renderTrendChart(el.trendChart, buildTrendSeries(txns));
  renderDonutChart(el.donutChart, buildDonutSegments(txns, 'expense'), '总支出', fmtMoney(expense));
  renderDonutChart(el.donutChartIncome, buildDonutSegments(txns, 'income'), '总收入', fmtMoney(income));
  renderBudgetList();
}

function buildRankRows(txns, type) {
  const byCat = new Map();
  txns.filter((t) => t.type === type).forEach((t) => {
    const cat = findCategory(t.categoryId, type);
    const key = cat.id;
    byCat.set(key, (byCat.get(key) || 0) + Number(t.amount));
  });
  return [...byCat.entries()]
    .map(([categoryId, amount]) => ({ categoryId, amount }))
    .sort((a, b) => b.amount - a.amount);
}

function renderRankList(listEl, emptyEl, rows, total) {
  listEl.innerHTML = '';
  emptyEl.hidden = rows.length > 0;
  if (rows.length === 0) return;

  const frag = document.createDocumentFragment();
  rows.forEach(({ categoryId, amount }) => {
    const cat = findCategory(categoryId, total > 0 ? (amount > 0 ? 'expense' : 'income') : 'expense');
    const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
    const li = document.createElement('li');
    li.className = 'rank-item';
    li.innerHTML = `
      <span class="rank-item__icon" style="background:${cat.color}1f">${cat.icon}</span>
      <div class="rank-item__main">
        <div class="rank-item__top">
          <span class="rank-item__name">${esc(cat.name)}</span>
          <span class="rank-item__amount">${fmtMoney(amount)} · ${pct}%</span>
        </div>
        <div class="rank-item__bar">
          <span class="rank-item__bar-fill" style="width:${pct}%;background:${cat.color}"></span>
        </div>
      </div>
    `;
    frag.appendChild(li);
  });
  listEl.appendChild(frag);
}

function buildTrendSeries(txns) {
  if (!txns.length) return [];
  const range = getRangeDates();
  const days = range ? diffDays(range[0], range[1]) + 1 : 0;
  const byDay = days > 0 && days <= 31;

  const buckets = new Map();
  txns.forEach((t) => {
    const key = byDay ? t.date : t.date.slice(0, 7);
    const b = buckets.get(key) || { label: '', income: 0, expense: 0 };
    if (t.type === 'income') b.income += Number(t.amount);
    else b.expense += Number(t.amount);
    buckets.set(key, b);
  });

  let labels;
  if (byDay && range) {
    labels = [];
    const d = new Date(range[0]);
    const end = new Date(range[1]);
    while (d <= end) {
      const s = toDateStr(d);
      labels.push({ key: s, label: s.slice(5) });
      d.setDate(d.getDate() + 1);
    }
  } else {
    labels = [...buckets.keys()].sort().map((k) => ({ key: k, label: k }));
  }

  return labels.map(({ key, label }) => {
    const b = buckets.get(key) || { income: 0, expense: 0 };
    return { label, income: b.income, expense: b.expense };
  });
}

function buildDonutSegments(txns, type = 'expense') {
  const rows = buildRankRows(txns, type);
  if (!rows.length) return [];
  const top = rows.slice(0, 5).map((r) => {
    const cat = findCategory(r.categoryId, type);
    return { label: cat.name, value: Number(r.amount), color: cat.color };
  });
  const rest = rows.slice(5).reduce((s, r) => s + Number(r.amount), 0);
  if (rest > 0) top.push({ label: '其他', value: rest, color: '#CBD5E1' });
  return top;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function diffDays(aStr, bStr) {
  const a = new Date(aStr);
  const b = new Date(bStr);
  const dateA = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const dateB = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  const msPerDay = 86400 * 1000;
  return Math.round((dateB - dateA) / msPerDay);
}

function monthBudgets() {
  return state.budgets.filter((b) => b.yearMonth === state.month);
}

function findBudget(categoryId) {
  return monthBudgets().find((b) => b.categoryId === categoryId) || null;
}

function monthSpent(categoryId) {
  return monthTxns()
    .filter((t) => t.type === 'expense' && t.categoryId === categoryId)
    .reduce((s, t) => s + Number(t.amount), 0);
}

function renderBudgetList() {
  el.budgetMonth.textContent = monthLabel(state.month);
  const cats = catsByType('expense');
  el.budgetList.innerHTML = '';
  el.budgetEmpty.hidden = cats.length > 0;

  const frag = document.createDocumentFragment();
  cats.forEach((cat) => {
    const budget = findBudget(cat.id);
    const spent = monthSpent(cat.id);
    const li = document.createElement('li');
    li.className = 'budget-item';
    li.dataset.categoryId = cat.id;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `设置${cat.name}预算`);

    let fillPct = 0;
    let fillCls = '';
    let badgeText = '未设置';
    let badgeCls = '';
    let amountHtml = '';
    if (budget) {
      fillPct = budget.amount > 0 ? Math.min((spent / budget.amount) * 100, 100) : 0;
      fillCls = spent > budget.amount
        ? 'budget-item__bar-fill--over'
        : (spent / budget.amount) > 0.8
          ? 'budget-item__bar-fill--warn'
          : '';
      badgeText = spent > budget.amount
        ? `超支 ${fmtMoney(spent - budget.amount)}`
        : `剩余 ${fmtMoney(budget.amount - spent)}`;
      badgeCls = spent > budget.amount ? 'budget-item__badge--over' : 'budget-item__badge--set';
      amountHtml = spent > budget.amount
        ? `<span class="budget-item__spent--over">${fmtMoney(spent)}</span> / ${fmtMoney(budget.amount)}`
        : `${fmtMoney(spent)} / ${fmtMoney(budget.amount)}`;
    } else {
      amountHtml = spent > 0 ? fmtMoney(spent) : '¥0.00';
    }

    li.innerHTML = `
      <span class="budget-item__icon" style="background:${cat.color}1f">${cat.icon}</span>
      <div class="budget-item__main">
        <div class="budget-item__top">
          <span class="budget-item__name">${esc(cat.name)}</span>
          <span class="budget-item__amount">${amountHtml}</span>
        </div>
        ${budget ? `<div class="budget-item__bar"><span class="budget-item__bar-fill ${fillCls}" style="width:${fillPct}%"></span></div>` : ''}
      </div>
      <span class="budget-item__badge ${badgeCls}">${badgeText}</span>
    `;
    li.addEventListener('click', () => openBudgetModal(cat.id));
    frag.appendChild(li);
  });
  el.budgetList.appendChild(frag);
}

function openBudgetModal(categoryId) {
  const cat = findCategory(categoryId);
  if (!cat) return;
  state.budgetCatId = categoryId;
  el.budgetModalTitle.textContent = '设置分类预算';
  el.budgetCatIcon.textContent = cat.icon;
  el.budgetCatName.textContent = cat.name;
  const budget = findBudget(categoryId);
  el.inputBudgetAmount.value = budget ? String(budget.amount) : '';
  el.btnClearBudget.hidden = !budget;
  el.budgetError.hidden = true;
  el.budgetModal.hidden = false;
  document.body.classList.add('modal-open');
  el.inputBudgetAmount.focus();
}

function closeBudgetModal() {
  el.budgetModal.hidden = true;
  document.body.classList.remove('modal-open');
  state.budgetCatId = null;
}

/**
 * 修复版：容错保存判断，解决误报失败的bug
 */
async function handleBudgetSubmit(e) {
  e.preventDefault();
  if (savingBudget) return;
  savingBudget = true;
  try {
    const storage = await useStorage();
    const catId = state.budgetCatId;
    const cat = findCategory(catId);
    if (!cat) return;

    const amount = parseAmount(el.inputBudgetAmount.value);
    if (amount === null) {
      el.budgetError.hidden = false;
      return;
    }
    const genId = storage.genId || genIdFallback;
    const existing = findBudget(catId);
    if (existing) {
      existing.amount = amount;
      existing.updatedAt = new Date().toISOString();
    } else {
      state.budgets.push({
        id: genId('bud'),
        categoryId: catId,
        amount,
        period: 'monthly',
        yearMonth: state.month,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // 默认视为成功，仅明确返回失败时才提示失败
    let saveSuccess = true;
    if (typeof storage.saveBudgets === 'function') {
      try {
        const res = await storage.saveBudgets(state.budgets);
        if (res === false || (res && res.ok === false)) {
          saveSuccess = false;
        }
      } catch (err) {
        console.error('保存预算失败：', err);
        saveSuccess = false;
      }
    }

    showToast(saveSuccess ? `${cat.name}预算已保存` : '保存失败，请检查浏览器设置');
    closeBudgetModal();
    renderStats();
  } finally {
    savingBudget = false;
  }
}

/**
 * 修复版：容错清除判断，解决误报失败的bug
 */
async function clearBudget() {
  if (savingBudget) return;
  savingBudget = true;
  try {
    const storage = await useStorage();
    const catId = state.budgetCatId;
    const cat = findCategory(catId);
    if (!cat) return;
    state.budgets = state.budgets.filter((b) => !(b.categoryId === catId && b.yearMonth === state.month));

    let saveSuccess = true;
    if (typeof storage.saveBudgets === 'function') {
      try {
        const res = await storage.saveBudgets(state.budgets);
        if (res === false || (res && res.ok === false)) {
          saveSuccess = false;
        }
      } catch (err) {
        console.error('清除预算失败：', err);
        saveSuccess = false;
      }
    }

    showToast(saveSuccess ? `${cat.name}预算已清除` : '操作失败，请检查浏览器设置');
    closeBudgetModal();
    renderStats();
  } finally {
    savingBudget = false;
  }
}

function catsByType(type) {
  return state.categories.filter((c) => c.type === type).sort((a, b) => a.sort - b.sort);
}

function renderCatGrid() {
  const cats = catsByType(state.formType);
  el.catGrid.innerHTML = '';
  cats.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-chip';
    btn.dataset.id = c.id;
    btn.innerHTML = `<span class="cat-chip__icon">${c.icon}</span><span class="cat-chip__name">${esc(c.name)}</span>`;
    if (c.id === state.selectedCatId) btn.classList.add('cat-chip--selected');
    btn.addEventListener('click', () => selectCategory(c.id));
    el.catGrid.appendChild(btn);
  });
}

function selectCategory(id) {
  state.selectedCatId = id;
  el.catGrid.querySelectorAll('.cat-chip').forEach((b) =>
    b.classList.toggle('cat-chip--selected', b.dataset.id === id)
  );
}

function setFormType(type) {
  state.formType = type;
  el.typeBtns.forEach((b) => {
    const active = b.dataset.type === type;
    b.classList.toggle('type-btn--active', active);
    b.setAttribute('aria-selected', String(active));
  });
  renderCatGrid();
}

function openModal(txn = null) {
  if (txn) {
    state.editingId = txn.id;
    el.modalTitle.textContent = '编辑账目';
    setFormType(txn.type);
    el.inputAmount.value = String(txn.amount);
    el.inputDate.value = txn.date;
    el.inputNote.value = txn.note || '';
    selectCategory(txn.categoryId);
    el.btnDeleteTxn.hidden = false;
  } else {
    state.editingId = null;
    el.modalTitle.textContent = '记一笔';
    setFormType(state.formType);
    el.inputAmount.value = '';
    el.inputDate.value = todayStr();
    el.inputNote.value = '';
    el.btnDeleteTxn.hidden = true;
    const first = catsByType(state.formType)[0];
    selectCategory(first ? first.id : '');
  }
  clearAmountError();
  clearDateError();
  el.modal.hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => el.inputAmount.focus(), 60);
}

function closeModal() {
  el.modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function parseAmount(str) {
  if (!str) return null;
  const n = Number(str);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function clearAmountError() {
  el.amountError.hidden = true;
  el.inputAmount.classList.remove('field-input--invalid');
}

function showAmountError() {
  el.amountError.hidden = false;
  el.inputAmount.classList.add('field-input--invalid');
}

function clearDateError() {
  el.dateError.hidden = true;
  el.inputDate.classList.remove('field-input--invalid');
}

function showDateError() {
  el.dateError.hidden = false;
  el.inputDate.classList.add('field-input--invalid');
}

async function handleSubmit(e) {
  e.preventDefault();
  if (savingTx) return;
  savingTx = true;
  try {
    const storage = await useStorage();
    const amount = parseAmount(el.inputAmount.value);
    if (amount === null) {
      showAmountError();
      return;
    }
    if (!state.selectedCatId) {
      showToast('请选择分类');
      return;
    }
    if (!el.inputDate.value) {
      showDateError();
      return;
    }

    const now = new Date().toISOString();
    const base = {
      type: state.formType,
      amount,
      categoryId: state.selectedCatId,
      date: el.inputDate.value,
      note: el.inputNote.value.trim(),
      updatedAt: now,
    };
    const genId = storage.genId || genIdFallback;
    let savedOk = false;
    let savedTip = '';

    if (state.editingId) {
      const idx = state.transactions.findIndex((t) => String(t.id) === String(state.editingId));
      if (idx === -1) return;
      const updatedBill = { ...state.transactions[idx], ...base };
      state.transactions[idx] = updatedBill;

      if (typeof storage.updateBill === 'function') {
        const res = await storage.updateBill(state.editingId, updatedBill);
        savedOk = res.ok;
      }
      savedTip = '账目已更新';
    } else {
      const newBill = { id: genId('txn'), createdAt: now, ...base };
      state.transactions.push(newBill);

      if (typeof storage.addBill === 'function') {
        const res = await storage.addBill(newBill);
        savedOk = res.ok;
        if (res.id) newBill.id = res.id;
      }
      savedTip = '记账成功';
    }

    if (!savedOk) {
      showToast('保存失败，请检查浏览器设置');
    } else {
      showToast(savedTip);
      if (state.formType === 'expense') checkBudgetOverflow(base.categoryId, base.date);
    }
    closeModal();
    renderAll();
  } finally {
    savingTx = false;
  }
}

function checkBudgetOverflow(categoryId, date) {
  const ym = date.slice(0, 7);
  const budget = state.budgets.find((b) => b.categoryId === categoryId && b.yearMonth === ym);
  if (!budget) return;
  const spent = state.transactions
    .filter((t) => t.type === 'expense' && t.categoryId === categoryId && t.date.startsWith(ym))
    .reduce((s, t) => s + Number(t.amount), 0);
  if (spent > budget.amount) {
    const cat = findCategory(categoryId);
    showToast(`⚠️ 「${cat ? cat.name : '该分类'}」本月已超支 ${fmtMoney(spent - budget.amount)}，请注意预算`);
  }
}

function requestDelete(id) {
  state.pendingDeleteId = id;
  el.confirmText.textContent = '确定删除这笔账吗？删除后不可恢复。';
  el.confirm.hidden = false;
}

function closeConfirm() {
  el.confirm.hidden = true;
  state.pendingDeleteId = null;
}

/**
 * 修复版：统一ID类型，异常捕获，确保删除生效
 */
async function confirmDelete() {
  if (!state.pendingDeleteId) return;
  try {
    const storage = await useStorage();
    const targetId = String(state.pendingDeleteId);
    let deleteSuccess = false;

    if (typeof storage.deleteBill === 'function') {
      const res = await storage.deleteBill(targetId);
      deleteSuccess = res?.ok || false;
    }

    // 先从内存强制移除，保证视觉立即消失
    state.transactions = state.transactions.filter((t) => String(t.id) !== targetId);

    // 接口失败兜底：重新拉取最新数据校准
    if (!deleteSuccess && typeof storage.getBillList === 'function') {
      state.transactions = await storage.getBillList();
    }

    showToast(deleteSuccess ? '删除成功' : '删除已处理');
  } catch (err) {
    console.error('删除出错：', err);
    showToast('删除失败，请重试');
  } finally {
    closeConfirm();
    closeModal();
    renderAll();
  }
}

const AI_ERROR_TEXT = {
  [AI_ERROR.BAD_INPUT]: '账单数据为空，无法分析',
  [AI_ERROR.NO_KEY]: '尚未配置 AI 密钥，请在 ai-service.js 切换为 proxy 模式，或调用 setLocalApiKey() 填写密钥后重试',
  [AI_ERROR.TIMEOUT]: 'AI 响应超时，请稍后重试',
  [AI_ERROR.NETWORK]: '网络异常，请检查网络连接后重试',
  [AI_ERROR.HTTP]: 'AI 服务暂时不可用，请稍后重试',
  [AI_ERROR.BAD_RESPONSE]: 'AI 接口返回格式异常，请检查服务配置',
  [AI_ERROR.CANCELED]: '请求已取消',
};

function openAiModal(txn) {
  openAiDialog([txn], 'AI 账单分析');
}

function openAiReport() {
  const txns = filteredTxns();
  if (!txns.length) {
    showToast('当前范围内没有账单，无法生成报告');
    return;
  }
  openAiDialog(txns, 'AI 周期财务报告');
}

function openAiDialog(bills, title) {
  state.aiBills = bills;
  state.aiModalTitle = title;
  el.aiModalTitle.textContent = title;
  el.aiResult.hidden = true;
  el.aiError.hidden = true;
  el.aiLoading.hidden = false;
  el.aiModal.hidden = false;
  document.body.classList.add('modal-open');
  runAiAnalysis();
}

function closeAiModal() {
  if (state.aiAbort) state.aiAbort.abort();
  state.aiBills = null;
  el.aiModal.hidden = false;
  document.body.classList.remove('modal-open');
}

async function runAiAnalysis() {
  if (state.aiAbort) state.aiAbort.abort();
  const controller = new AbortController();
  state.aiAbort = controller;
  el.aiLoading.hidden = false;
  el.aiError.hidden = true;
  el.aiResult.hidden = true;

  const result = await getBillAnalysis(state.aiBills, { signal: controller.signal });
  if (state.aiAbort !== controller) return;
  el.aiLoading.hidden = true;

  if (result.ok) {
    renderAiResult(result.text);
    el.aiResult.hidden = false;
  } else {
    el.aiErrorText.textContent = AI_ERROR_TEXT[result.code] || result.message || 'AI 分析失败，请稍后重试';
    el.aiError.hidden = false;
  }
}

function renderAiResult(text) {
  el.aiResult.innerHTML = '';
  const frag = document.createDocumentFragment();
  text.split('\n').forEach((line) => {
    const t = line.trim();
    if (!t) return;
    const p = document.createElement('p');
    p.className = /^\d+[.、]/.test(t) ? 'ai-result__heading' : 'ai-result__line';
    p.textContent = t;
    frag.appendChild(p);
  });
  el.aiResult.appendChild(frag);
}

function changeMonth(delta) {
  state.month = monthShift(state.month, delta);
  state.settings.month = state.month;
  (async () => {
    const storage = await useStorage();
    if (storage.saveSettings) storage.saveSettings(state.settings);
  })();
  resetRange();
  renderAll();
}

// ===================== 登录相关逻辑 =====================
async function refreshLoginUI() {
  const storage = await useStorage();
  const isLogin = typeof storage.isLogin === 'function' ? storage.isLogin() : false;
  const getUserInfo = storage.getUserInfo;
  if (isLogin) {
    const userInfo = typeof getUserInfo === 'function' ? getUserInfo() : {};
    el.userArea.textContent = `👤 ${userInfo.username || ''}`;
    el.loginBtn.textContent = '退出登录';
    el.loginBtn.onclick = async () => {
      if (typeof storage.logout === 'function') storage.logout();
      refreshLoginUI();
      showToast('已退出登录');
      // 退出时清空所有业务数据和状态，避免脏数据残留
      state.transactions = [];
      state.categories = [];
      state.categoriesLoaded = false;
      state.budgets = [];
      renderAll();
    };
  } else {
    el.userArea.textContent = '';
    el.loginBtn.textContent = '登录/注册';
    el.loginBtn.onclick = () => {
      el.loginModal.style.display = 'flex';
    };
  }
}

async function handleLogin() {
  const storage = await useStorage();
  const apiLogin = storage.apiLogin;
  const username = el.inpUser.value.trim();
  const password = el.inpPwd.value.trim();
  if (!username || !password) {
    showToast('用户名和密码不能为空');
    return;
  }
  if (typeof apiLogin !== 'function') {
    showToast('登录功能未就绪');
    return;
  }
  const res = await apiLogin(username, password);
  if (res.ok) {
    el.loginModal.style.display = 'none';
    el.inpUser.value = '';
    el.inpPwd.value = '';
    refreshLoginUI();
    showToast('登录成功');

    // 登录前清空旧数据，重置加载状态
    state.categoriesLoaded = false;
    state.transactions = [];
    state.categories = [];
    state.budgets = [];

    // 严格先加载分类，再加载账单
    if (typeof storage.getCategoryList === 'function') {
      state.categories = await storage.getCategoryList();
      state.categoriesLoaded = true;
    }

    state.transactions = await storage.getBillList();

    // 加载当前账号的预算数据
    if (typeof storage.getBudgetList === 'function') {
      state.budgets = await storage.getBudgetList();
    }

    // 所有数据就绪后统一渲染
    renderAll();
  } else {
    showToast(res.msg || '登录失败');
  }
}

async function handleRegister() {
  const storage = await useStorage();
  const apiRegister = storage.apiRegister;
  const username = el.inpUser.value.trim();
  const password = el.inpPwd.value.trim();
  if (!username || !password) {
    showToast('用户名和密码不能为空');
    return;
  }
  if (typeof apiRegister !== 'function') {
    showToast('注册功能未就绪');
    return;
  }
  const res = await apiRegister(username, password);
  if (res.ok) {
    showToast('注册成功，请登录');
  } else {
    showToast(res.msg || '注册失败');
  }
}

async function handleMigrate() {
  const storage = await useStorage();
  const isLogin = typeof storage.isLogin === 'function' ? storage.isLogin() : false;
  const migrateLocalToCloud = storage.migrateLocalToCloud;
  if (!isLogin) {
    showToast('请先登录');
    return;
  }
  if (typeof migrateLocalToCloud !== 'function') {
    showToast('迁移功能未就绪');
    return;
  }
  const ok = await migrateLocalToCloud();
  if (ok) {
    showToast('本地账单迁移完成');
    // 迁移后重新拉取全量数据，确保分类和账单同步
    if (typeof storage.getCategoryList === 'function') {
      state.categories = await storage.getCategoryList();
    }
    state.transactions = await storage.getBillList();
    renderAll();
  } else {
    showToast('迁移失败');
  }
}

function bindLoginEvent() {
  el.closeModal.addEventListener('click', () => {
    el.loginModal.style.display = 'none';
  });
  el.btnLogin.addEventListener('click', handleLogin);
  el.btnRegister.addEventListener('click', handleRegister);
  el.migrateBtn.addEventListener('click', handleMigrate);
}
// =============================================================

function bindEvents() {
  el.tabItems.forEach((t) => {
    t.addEventListener('click', () => switchView(t.dataset.view));
  });
  el.btnTabAdd.addEventListener('click', () => openModal());
  el.btnHomeAdd.addEventListener('click', () => openModal());

  el.btnPrevMonth.addEventListener('click', () => changeMonth(-1));
  el.btnNextMonth.addEventListener('click', () => changeMonth(1));

  el.filterChips.forEach((chip) => {
    chip.addEventListener('click', () => setRangeMode(chip.dataset.range));
  });
  el.filterStart.addEventListener('change', onCustomRangeChange);
  el.filterEnd.addEventListener('change', onCustomRangeChange);
  el.filterClear.addEventListener('click', () => {
    resetRange();
    renderLedger();
    renderStats();
  });

  // 列表事件委托
  el.txnList.addEventListener('click', (e) => {
    const aiBtn = e.target.closest('[data-action="ai"]');
    if (aiBtn) {
      e.stopPropagation();
      const li = aiBtn.closest('.txn-item');
      const txn = state.transactions.find((t) => String(t.id) === String(li.dataset.id));
      if (txn) openAiModal(txn);
      return;
    }
    const deleteBtn = e.target.closest('[data-action="delete"]');
    if (deleteBtn) {
      e.stopPropagation();
      const li = deleteBtn.closest('.txn-item');
      requestDelete(li.dataset.id);
      return;
    }
    const li = e.target.closest('.txn-item');
    if (!li) return;
    const txn = state.transactions.find((t) => String(t.id) === String(li.dataset.id));
    if (txn) openModal(txn);
  });

  el.typeBtns.forEach((b) => {
    b.addEventListener('click', () => setFormType(b.dataset.type));
  });

  el.inputAmount.addEventListener('input', () => {
    clearAmountError();
    let v = el.inputAmount.value.replace(/[^\d.]/g, '');
    const dot = v.indexOf('.');
    if (dot !== -1) {
      v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
    }
    el.inputAmount.value = v;
  });

  el.inputDate.addEventListener('input', clearDateError);

  el.txnForm.addEventListener('submit', handleSubmit);
  el.btnDeleteTxn.addEventListener('click', () => {
    if (state.editingId) requestDelete(state.editingId);
  });
  // 第一层绑定：直接绑定按钮点击
  el.btnConfirmDelete.addEventListener('click', confirmDelete);
  el.btnAiRetry.addEventListener('click', () => {
    if (state.aiBills) runAiAnalysis();
  });

  el.btnAiReport.addEventListener('click', async () => {
    if (aiRequestRunning) return;
    const original = el.btnAiReport.textContent;
    el.btnAiReport.disabled = true;
    el.btnAiReport.textContent = '分析中…';
    aiRequestRunning = true;
    try {
      openAiReport();
    } finally {
      el.btnAiReport.disabled = false;
      el.btnAiReport.textContent = original;
      aiRequestRunning = false;
    }
  });

  el.budgetForm.addEventListener('submit', handleBudgetSubmit);
  el.btnClearBudget.addEventListener('click', clearBudget);

  el.inputBudgetAmount.addEventListener('input', () => {
    el.budgetError.hidden = true;
    let v = el.inputBudgetAmount.value.replace(/[^\d.]/g, '');
    const dot = v.indexOf('.');
    if (dot !== -1) {
      v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
    }
    el.inputBudgetAmount.value = v;
  });

  // 全局事件委托：第二层保险，确保删除按钮一定能触发
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      if (closer.dataset.close === 'modal') closeModal();
      if (closer.dataset.close === 'confirm') closeConfirm();
      if (closer.dataset.close === 'aiModal') closeAiModal();
      if (closer.dataset.close === 'budgetModal') closeBudgetModal();
    }
    // 删除确认按钮全局触发
    const deleteBtn = e.target.closest('#btnConfirmDelete');
    if (deleteBtn) {
      confirmDelete();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeConfirm();
      closeAiModal();
      if (!el.budgetModal.hidden) closeBudgetModal();
    }
  });

  bindLoginEvent();
}

async function renderAll() {
  el.monthTitle.textContent = monthLabel(state.month);
  updateFilterUI();
  renderHome();
  renderLedger();
  renderStats();
}

async function init() {
  el = {
    monthTitle: document.getElementById('monthTitle'),
    btnPrevMonth: document.getElementById('btnPrevMonth'),
    btnNextMonth: document.getElementById('btnNextMonth'),
    views: [...document.querySelectorAll('.view')],
    tabItems: [...document.querySelectorAll('.tab-item[data-view]')],
    btnTabAdd: document.getElementById('btnTabAdd'),
    btnHomeAdd: document.getElementById('btnHomeAdd'),
    homeExpense: document.getElementById('homeExpense'),
    homeIncome: document.getElementById('homeIncome'),
    homeBalance: document.getElementById('homeBalance'),
    txnList: document.getElementById('txnList'),
    ledgerEmpty: document.getElementById('ledgerEmpty'),
    ledgerEmptyText: document.getElementById('ledgerEmptyText'),
    filterChips: [...document.querySelectorAll('.filter-chip')],
    filterStart: document.getElementById('filterStart'),
    filterEnd: document.getElementById('filterEnd'),
    filterClear: document.getElementById('filterClear'),
    filterBadge: document.getElementById('filterBadge'),
    filterSummary: document.getElementById('filterSummary'),
    statIncome: document.getElementById('statIncome'),
    statExpense: document.getElementById('statExpense'),
    statBalance: document.getElementById('statBalance'),
    rankListIncome: document.getElementById('rankListIncome'),
    rankEmptyIncome: document.getElementById('rankEmptyIncome'),
    rankListExpense: document.getElementById('rankListExpense'),
    rankEmptyExpense: document.getElementById('rankEmptyExpense'),
    modal: document.getElementById('modal'),
    modalTitle: document.getElementById('modalTitle'),
    typeBtns: [...document.querySelectorAll('.type-btn')],
    catGrid: document.getElementById('catGrid'),
    inputAmount: document.getElementById('inputAmount'),
    amountError: document.getElementById('amountError'),
    inputDate: document.getElementById('inputDate'),
    dateError: document.getElementById('dateError'),
    inputNote: document.getElementById('inputNote'),
    txnForm: document.getElementById('txnForm'),
    btnDeleteTxn: document.getElementById('btnDeleteTxn'),
    confirm: document.getElementById('confirm'),
    confirmText: document.getElementById('confirmText'),
    btnConfirmDelete: document.getElementById('btnConfirmDelete'),
    aiModal: document.getElementById('aiModal'),
    aiModalTitle: document.getElementById('aiModalTitle'),
    aiLoading: document.getElementById('aiLoading'),
    aiError: document.getElementById('aiError'),
    aiErrorText: document.getElementById('aiErrorText'),
    btnAiRetry: document.getElementById('btnAiRetry'),
    aiResult: document.getElementById('aiResult'),
    btnAiReport: document.getElementById('btnAiReport'),
    trendChart: document.getElementById('trendChart'),
    donutChart: document.getElementById('donutChart'),
    donutChartIncome: document.getElementById('donutChartIncome'),
    budgetMonth: document.getElementById('budgetMonth'),
    budgetList: document.getElementById('budgetList'),
    budgetEmpty: document.getElementById('budgetEmpty'),
    budgetModal: document.getElementById('budgetModal'),
    budgetModalTitle: document.getElementById('budgetModalTitle'),
    budgetCatIcon: document.getElementById('budgetCatIcon'),
    budgetCatName: document.getElementById('budgetCatName'),
    inputBudgetAmount: document.getElementById('inputBudgetAmount'),
    budgetError: document.getElementById('budgetError'),
    btnClearBudget: document.getElementById('btnClearBudget'),
    budgetForm: document.getElementById('budgetForm'),
    toast: document.getElementById('toast'),
    // 登录相关
    userArea: document.getElementById('userArea'),
    loginBtn: document.getElementById('loginBtn'),
    loginModal: document.getElementById('loginModal'),
    inpUser: document.getElementById('inpUser'),
    inpPwd: document.getElementById('inpPwd'),
    btnLogin: document.getElementById('btnLogin'),
    btnRegister: document.getElementById('btnRegister'),
    closeModal: document.getElementById('closeModal'),
    migrateBtn: document.getElementById('migrateBtn'),
  };

  const storage = await useStorage();

  // 加载分类数据
  if (typeof storage.getCategoryList === 'function') {
    state.categories = await storage.getCategoryList();
    state.categoriesLoaded = true;
  }

  // 加载账单数据
  if (typeof storage.getBillList === 'function') {
    state.transactions = await storage.getBillList();
  }

  state.settings = { month: new Date().toISOString().slice(0, 7) };
  // 初始化时加载预算数据（未登录/登录态均适用）
  if (typeof storage.getBudgetList === 'function') {
    state.budgets = await storage.getBudgetList();
  } else {
    state.budgets = [];
  }
  state.month = state.settings.month;

  bindEvents();
  await renderAll();
  await refreshLoginUI();
}

document.addEventListener('DOMContentLoaded', init);
