// ========== 全局登录状态管理 ==========
const DEFAULT_CATEGORIES = [
  // 支出分类（独立配色）
  { id: 'food', name: '餐饮', icon: '🍜', type: 'expense', sort: 1, color: '#10B981' },
  { id: 'transport', name: '交通', icon: '🚗', type: 'expense', sort: 2, color: '#14B8A6' },
  { id: 'shopping', name: '购物', icon: '🛒', type: 'expense', sort: 3, color: '#0EA5E9' },
  { id: 'entertainment', name: '娱乐', icon: '🎮', type: 'expense', sort: 4, color: '#8B5CF6' },
  { id: 'medical', name: '医疗', icon: '💊', type: 'expense', sort: 5, color: '#F59E0B' },
  { id: 'education', name: '教育', icon: '📚', type: 'expense', sort: 6, color: '#EC4899' },
  // 收入分类
  { id: 'salary', name: '工资', icon: '💰', type: 'income', sort: 1, color: '#3B82F6' },
  { id: 'bonus', name: '奖金', icon: '🎁', type: 'income', sort: 2, color: '#06B6D4' },
  { id: 'parttime', name: '兼职', icon: '💼', type: 'income', sort: 3, color: '#8B5CF6' },
  { id: 'other-income', name: '其他收入', icon: '💵', type: 'income', sort: 4, color: '#10B981' }
];

// 分类ID兼容映射（应对旧数据、云端数据ID格式不统一）
const CATEGORY_ID_MAP = {
  // 支出：旧数字ID、别名都映射到标准ID
  1: 'food', '1': 'food', '餐饮': 'food',
  2: 'transport', '2': 'transport', '交通': 'transport',
  3: 'shopping', '3': 'shopping', '购物': 'shopping',
  4: 'entertainment', '4': 'entertainment', '娱乐': 'entertainment',
  5: 'medical', '5': 'medical', '医疗': 'medical',
  6: 'education', '6': 'education', '教育': 'education',
  // 收入
  10: 'salary', '10': 'salary', '工资': 'salary',
  11: 'bonus', '11': 'bonus', '奖金': 'bonus',
  12: 'parttime', '12': 'parttime', '兼职': 'parttime',
};

const STORAGE_TOKEN_KEY = 'budget_token';
const STORAGE_USER_KEY = 'budget_user';
const LOCAL_BILL_KEY = 'budget_bill_list';
const LOCAL_CATEGORY_KEY = 'budget_category_list';

export function getToken() {
  return localStorage.getItem(STORAGE_TOKEN_KEY) || null;
}
export function setToken(token) {
  if(token) localStorage.setItem(STORAGE_TOKEN_KEY, token);
  else localStorage.removeItem(STORAGE_TOKEN_KEY);
}
export function getUserInfo() {
  const str = localStorage.getItem(STORAGE_USER_KEY);
  return str ? JSON.parse(str) : null;
}
export function setUserInfo(user) {
  if(user) localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(STORAGE_USER_KEY);
}

// ========== 退出登录 ==========
export function logout() {
  setToken(null);
  setUserInfo(null);
}
export function isLogin(){
  return !!getToken();
}

// ========== HTTP 请求封装（自动携带token） ==========
async function request(url, opts={}){
  const headers = {
    'Content-Type':'application/json',
    ...opts.headers
  }
  const token = getToken();
  if(token){
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    ...opts,
    headers
  })
  return res.json();
}

// ========== 登录注册接口 ==========
export async function apiRegister(username, password){
  return request('/api/register', {
    method:'POST',
    body:JSON.stringify({username,password})
  })
}
export async function apiLogin(username, password){
  const ret = await request('/api/login', {
    method:'POST',
    body:JSON.stringify({username,password})
  })
  if(ret.ok){
    setToken(ret.token);
    setUserInfo({username:ret.username});
  }
  return ret;
}

// ========== 分类兼容工具（必须放在账单函数前面） ==========
export function normalizeCategoryId(rawId, billType = 'expense') {
  if (!rawId) {
    return billType === 'income' ? 'salary' : 'food';
  }
  if (CATEGORY_ID_MAP[rawId]) {
    return CATEGORY_ID_MAP[rawId];
  }
  const exists = DEFAULT_CATEGORIES.find(c => c.id === rawId);
  if (exists) return rawId;
  return billType === 'income' ? 'salary' : 'food';
}

// ========== 账单统一接口（自动区分本地/云端 + 字段自动映射） ==========

// 获取账单
export async function getBillList(){
  let list = [];
  if(isLogin()){
    const res = await request('/api/cloud/bills');
    console.log("【云端账单原始数据】", res.data);
    list = res.ok ? res.data : [];
    // 后端下划线字段 → 前端驼峰字段 映射
    return list.map(bill => ({
      id: bill.id,
      type: bill.type,
      amount: bill.amount,
      date: bill.date || new Date().toISOString().slice(0, 10),
      note: bill.remark || bill.note || '',
      categoryId: normalizeCategoryId(bill.category || bill.categoryId, bill.type),
      createdAt: bill.create_at || bill.createdAt || new Date().toISOString()
    }));
  }else{
    const str = localStorage.getItem(LOCAL_BILL_KEY);
    list = str ? JSON.parse(str) : [];
    // 本地数据也做一次标准化
    return list.map(bill => ({
      ...bill,
      categoryId: normalizeCategoryId(bill.categoryId, bill.type)
    }));
  }
}

// 保存账单（新增）
export async function addBill(bill){
  const standardBill = {
    ...bill,
    categoryId: normalizeCategoryId(bill.categoryId, bill.type)
  };

  if(isLogin()){
    // 前端驼峰 → 后端下划线 字段映射
    const serverData = {
      type: standardBill.type,
      amount: standardBill.amount,
      category: standardBill.categoryId,
      date: standardBill.date,
      remark: standardBill.note || ''
    };
    const res = await request('/api/cloud/bills', {
      method:'POST',
      body:JSON.stringify(serverData)
    });
    if (res.ok && res.data?.id) {
      standardBill.id = res.data.id;
    }
    return { ok: res.ok, id: standardBill.id };
  }else{
    const list = await getBillList();
    standardBill.id = Date.now();
    list.push(standardBill);
    localStorage.setItem(LOCAL_BILL_KEY, JSON.stringify(list));
    return {ok:true, id:standardBill.id}
  }
}

// 修改账单
export async function updateBill(id, bill){
  const updateData = {...bill};
  if (updateData.categoryId) {
    updateData.categoryId = normalizeCategoryId(updateData.categoryId, updateData.type || bill.type);
  }

  if(isLogin()){
    // 前端驼峰 → 后端下划线 字段映射
    const serverData = {};
    if (updateData.type) serverData.type = updateData.type;
    if (updateData.amount) serverData.amount = updateData.amount;
    if (updateData.categoryId) serverData.category = updateData.categoryId;
    if (updateData.date) serverData.date = updateData.date;
    if (updateData.note !== undefined) serverData.remark = updateData.note;

    return request(`/api/cloud/bills/${id}`, {
      method:'PUT',
      body:JSON.stringify(serverData)
    })
  }else{
    const list = await getBillList();
    const idx = list.findIndex(i=>i.id == id);
    if(idx>-1){
      list[idx] = {...list[idx], ...updateData};
      localStorage.setItem(LOCAL_BILL_KEY, JSON.stringify(list));
    }
    return {ok:true};
  }
}

// 删除账单
export async function deleteBill(id){
  if(isLogin()){
    return request(`/api/cloud/bills/${id}`, {method:'DELETE'})
  }else{
    let list = await getBillList();
    list = list.filter(i=>i.id != id);
    localStorage.setItem(LOCAL_BILL_KEY, JSON.stringify(list));
    return {ok:true};
  }
}

// 导出账单（仅登录可用）
export function exportBillCSV(){
  if(!isLogin()){
    alert('登录账号后才能云端导出账单');
    return;
  }
  window.open('/api/cloud/bills/export','_blank');
}

// 本地账单 迁移上传到云端
export async function migrateLocalToCloud(){
  if(!isLogin()) {
    alert('请先登录');
    return false;
  }
  const localStr = localStorage.getItem(LOCAL_BILL_KEY);
  if(!localStr){
    alert('没有本地账单');
    return false;
  }
  const localList = JSON.parse(localStr);
  for(const bill of localList){
    const standardBill = {
      ...bill,
      categoryId: normalizeCategoryId(bill.categoryId, bill.type)
    };
    const serverData = {
      type: standardBill.type,
      amount: standardBill.amount,
      category: standardBill.categoryId,
      date: standardBill.date,
      remark: standardBill.note || ''
    };
    await request('/api/cloud/bills', {
      method:'POST',
      body:JSON.stringify(serverData)
    })
  }
  alert(`迁移完成，共${localList.length}条账单！`);
  return true;
}

// ========== 分类数据接口 ==========

// 获取分类列表
export async function getCategoryList(){
  if(isLogin()){
    return [...DEFAULT_CATEGORIES];
  }else{
    const str = localStorage.getItem(LOCAL_CATEGORY_KEY);
    if(str){
      return JSON.parse(str);
    }else{
      localStorage.setItem(LOCAL_CATEGORY_KEY, JSON.stringify(DEFAULT_CATEGORIES));
      return [...DEFAULT_CATEGORIES];
    }
  }
}

// 保存分类（预留函数）
export async function saveCategoryList(catList){
  if(isLogin()){
    return {ok:true};
  }else{
    localStorage.setItem(LOCAL_CATEGORY_KEY, JSON.stringify(catList));
    return {ok:true};
  }
}

/**
 * 批量修复所有账单的分类ID
 */
export async function repairAllBillCategories(syncToCloud = false) {
  const list = await getBillList();
  let fixedCount = 0;

  const fixedList = list.map(bill => {
    const standardId = normalizeCategoryId(bill.categoryId, bill.type);
    if (bill.categoryId !== standardId) {
      fixedCount++;
      return { ...bill, categoryId: standardId };
    }
    return bill;
  });

  if (!isLogin()) {
    localStorage.setItem(LOCAL_BILL_KEY, JSON.stringify(fixedList));
  } 
  else if (syncToCloud) {
    for (const bill of fixedList) {
      const origin = list.find(b => b.id === bill.id);
      if (origin?.categoryId !== bill.categoryId) {
        await updateBill(bill.id, { categoryId: bill.categoryId });
      }
    }
  }

  return { fixedCount, total: list.length, list: fixedList };
}
// ========== 预算数据接口（按账号隔离持久化） ==========

// 生成按账号隔离的预算存储key，避免多账号数据串号
function getBudgetStorageKey() {
  const user = getUserInfo();
  return user ? `budget_${user.username}_list` : 'budget_guest_list';
}

// 获取预算列表
export async function getBudgetList() {
  const key = getBudgetStorageKey();
  const str = localStorage.getItem(key);
  return str ? JSON.parse(str) : [];
}

// 保存预算列表
export async function saveBudgets(budgetList) {
  const key = getBudgetStorageKey();
  localStorage.setItem(key, JSON.stringify(budgetList));
  return { ok: true };
}
