/**
 * 预算魔法账本 · AI 账单分析服务（ai-service.js）
 * 封装兼容 OpenAI 规范（Chat Completions）的大模型请求
 *
 * 业务目标：读取账单数据 -> 自动组装提示词 -> 调用大模型
 *           -> 生成【消费分析 / 省钱建议 / 消费总结】
 *
 * ▎两种运行模式（顶部 AI_CONFIG.MODE 切换）
 *   1. 'local' 本地调试模式
 *      - 前端直连大模型厂商端点（OpenAI / DeepSeek / 智谱 等兼容服务）
 *      - API Key 由使用者在浏览器中手动填写，经 localStorage(bm_ai_api_key) 保存
 *      - 源码中【禁止写死】任何 Key；Key 仅存于当前浏览器，不随代码提交
 *   2. 'proxy' 后端代理模式
 *      - BASE_URL 指向自有后端路由（如 /api/ai/chat），由后端转发并保管密钥
 *      - 前端请求【不携带】 Authorization，密钥不进入浏览器
 *
 * ▎切换方法
 *   AI_CONFIG.MODE = 'local' | 'proxy'
 *   - local：BASE_URL 填厂商兼容端点，前端 setLocalApiKey() 手动填 Key 后调用
 *   - proxy：BASE_URL 填后端地址，后端需自行实现 OpenAI 兼容转发
 *
 * ▎安全风险提醒
 *   - 本地调试模式 Key 直接暴露于浏览器，仅供开发调试，严禁用于生产
 *   - 账单数据（含金额、备注）会随请求发送给模型服务商，涉及隐私请脱敏或自建代理
 *   - 页面为 http 时只能请求 https 端点（混合内容限制）；https 页面不可请求 http 端点
 *   - 提交代码前确认未把任何 Key 写入源码或本地文件
 */

// ==========【修改重点】删除顶层静态导入，改为函数内部动态import ==========
/* ---------- 配置区（唯一修改点，部署时按环境调整） ---------- */

/**
 * 解析代理服务 Base URL：
 *   - 优先读取 localStorage 覆盖值（键 bm_ai_base_url，便于特殊环境下不改代码切换地址）
 *   - 默认返回同源相对路径 '/api/ai'：页面与代理服务同源（本地 `node server/index.js` 或
 *     部署后均满足），浏览器直接请求同源后端，无需关心对外地址
 */
function resolveAiBaseUrl() {
  try {
    const overridden = localStorage.getItem('bm_ai_base_url');
    if (overridden && overridden.trim()) return overridden.trim();
  } catch (err) {
    /* 忽略存储不可用等异常 */
  }
  return '/api/ai';
}

const AI_CONFIG = Object.freeze({
  /** 运行模式：'local' 本地调试模式 | 'proxy' 后端代理模式 */
  MODE: 'proxy',
  /** OpenAI 兼容端点 Base URL（以 /chat/completions 结尾的地址请去掉该后缀，代码会自动拼接） */
  BASE_URL: resolveAiBaseUrl(),
  /** 模型名称：OpenAI 'gpt-4o-mini' / DeepSeek 'deepseek-chat' / 智谱 'glm-4-flash' 等 */
  MODEL_NAME: 'deepseek-chat',
  /** 请求超时（毫秒） */
  TIMEOUT_MS: 30000,
  /** 本地调试模式 Key 的 localStorage 键名（使用者手动填写，不写死在代码里） */
  KEY_STORE: 'bm_ai_api_key',
});

/** 错误码：调用方可根据 code 做差异化提示 */
const AI_ERROR = Object.freeze({
  BAD_INPUT: 'BAD_INPUT', // 入参不合法
  NO_KEY: 'NO_KEY', // 本地模式未填写 API Key
  CANCELED: 'CANCELED', // 请求被外部主动取消
  TIMEOUT: 'TIMEOUT', // 请求超时
  NETWORK: 'NETWORK', // 网络异常
  HTTP: 'HTTP', // 服务端返回非 2xx
  BAD_RESPONSE: 'BAD_RESPONSE', // 响应结构不符合 OpenAI 规范
});

/** 系统提示词：约束模型输出风格与安全边界 */
const SYSTEM_PROMPT =
  '你是「预算魔法账本」内置的个人财务顾问。要求：用简体中文，语气务实，条理清晰，' +
  '不使用 Markdown 表格，不虚构数据，只基于用户提供的账单信息作答。';

/* ---------- 本地调试模式：API Key 管理 ---------- */

/** 读取本地调试模式的 API Key；未填写返回空字符串 */
function getLocalApiKey() {
  try {
    return localStorage.getItem(AI_CONFIG.KEY_STORE) || '';
  } catch (err) {
    return '';
  }
}

/** 保存本地调试模式的 API Key（仅存当前浏览器，供使用者手动填写） */
function setLocalApiKey(key) {
  try {
    localStorage.setItem(AI_CONFIG.KEY_STORE, String(key || '').trim());
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- 提示词组装 ---------- */

function formatAmount(n) {
  return `¥${Number(n).toFixed(2)}`;
}

/** 按分类聚合指定类型流水金额，返回降序 [{ name, amount }] */
async function aggregateByCategory(bills, type) {
  let catMap = new Map();
  try {
    // 【修改重点】函数内部动态导入，模块不会在页面启动时直接崩溃
    const storageModule = await import('./storage.js');
    if (typeof storageModule.getCategories === 'function') {
      catMap = new Map(storageModule.getCategories().map((c) => [c.id, c.name]));
    }
  } catch (err) {
    // 导入失败不会阻塞全局，仅分类名称降级处理
    console.warn('加载分类数据失败，将使用原始categoryId展示', err);
  }

  const map = new Map();
  bills
    .filter((b) => b.type === type)
    .forEach((b) => {
      const key = catMap.get(b.categoryId) || b.categoryName || b.categoryId || '未分类';
      map.set(key, (map.get(key) || 0) + Number(b.amount || 0));
    });
  return [...map.entries()]
    .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);
}

/** 根据账单数组自动组装分析提示词 */
async function buildPrompt(billList) {
  const bills = Array.isArray(billList) ? billList : [];
  const income = bills
    .filter((b) => b.type === 'income')
    .reduce((s, b) => s + Number(b.amount || 0), 0);
  const expense = bills
    .filter((b) => b.type === 'expense')
    .reduce((s, b) => s + Number(b.amount || 0), 0);
  const incomeRanks = await aggregateByCategory(bills, 'income');
  const expenseRanks = await aggregateByCategory(bills, 'expense');

  const rankLines = (rows) =>
    rows.length
      ? rows.map((r, i) => `${i + 1}. ${r.name} ${formatAmount(r.amount)}`).join('\n')
      : '（暂无记录）';

  const notes = bills
    .filter((b) => b.note)
    .slice(-10)
    .map((b) => `- ${b.date} ${b.note}`)
    .join('\n');

  return [
    '你是一位专业的个人财务顾问，请基于以下账单数据生成简洁、可落地的消费分析。',
    '',
    `【统计范围】共 ${bills.length} 笔流水`,
    `【总收入】${formatAmount(income)}`,
    `【总支出】${formatAmount(expense)}`,
    `【结余】${formatAmount(income - expense)}`,
    '',
    '【收入分类汇总】',
    rankLines(incomeRanks),
    '',
    '【支出分类汇总】',
    rankLines(expenseRanks),
    '',
    notes ? `【近期备注摘录】\n${notes}` : '',
    '',
    '请按以下结构输出（全部使用中文，不要使用 Markdown 表格）：',
    '1. 消费分析：用 3-4 句话点评支出结构与主要去向；',
    '2. 省钱建议：给出 3-5 条具体、可执行的建议；',
    '3. 消费总结：用 2-3 句话收尾概括。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/* ---------- 请求封装 ---------- */

/** 发起 OpenAI 兼容请求；失败抛出带 code 的 Error */
async function requestChat({ key, prompt, timeout, signal }) {
  // local 模式直连厂商需带 /v1 前缀（如 https://api.deepseek.com/v1/chat/completions）；
  // proxy 模式指向后端别名路由（如 http://localhost:3000/api/ai/chat/completions），不再重复拼接 /v1
  const suffix = AI_CONFIG.MODE === 'local' ? '/v1/chat/completions' : '/chat/completions';
  const endpoint = `${AI_CONFIG.BASE_URL.replace(/\/+$/, '')}${suffix}`;
  const headers = { 'Content-Type': 'application/json' };
  if (AI_CONFIG.MODE === 'local') headers.Authorization = `Bearer ${key}`;
  // 后端代理模式：鉴权由后端完成，前端不携带任何密钥

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: AI_CONFIG.MODEL_NAME,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (signal && signal.aborted) {
      throw Object.assign(new Error('请求已取消'), { code: AI_ERROR.CANCELED });
    }
    if (err && err.name === 'AbortError') {
      throw Object.assign(new Error('请求超时，请稍后重试'), { code: AI_ERROR.TIMEOUT });
    }
    throw Object.assign(new Error('网络异常，请检查网络连接'), { code: AI_ERROR.NETWORK });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = (body && body.error && body.error.message) || JSON.stringify(body);
    } catch (err) {
      /* 忽略响应体解析失败 */
    }
    throw Object.assign(
      new Error(`服务端返回 ${res.status}${detail ? `：${detail}` : ''}`),
      { code: AI_ERROR.HTTP }
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw Object.assign(new Error('响应解析失败，服务端返回非 JSON'), {
      code: AI_ERROR.BAD_RESPONSE,
    });
  }

  const text =
    data && data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('响应缺少 choices[0].message.content，可能不是 OpenAI 兼容端点'), {
      code: AI_ERROR.BAD_RESPONSE,
    });
  }
  return text.trim();
}

/**
 * 获取账单 AI 分析（消费分析 / 省钱建议 / 消费总结）
 * @param {object[]} billList 账单数组（03-data-struct.md 中 bm_transactions 结构）
 * @param {object} [options]
 * @param {Function} [options.onStatus] 加载状态回调：'loading' | 'done' | 'error'
 * @param {number} [options.timeout] 覆盖默认超时时间（毫秒）
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @returns {Promise<{ok: true, text: string} | {ok: false, code: string, message: string}>}
 */
async function getBillAnalysis(billList, options = {}) {
  const { onStatus, timeout = AI_CONFIG.TIMEOUT_MS, signal } = options;
  const report = (status) => {
    if (typeof onStatus === 'function') onStatus(status);
  };
  const fail = (code, message) => ({ ok: false, code, message });

  if (!Array.isArray(billList)) {
    return fail(AI_ERROR.BAD_INPUT, 'billList 必须为账单数组');
  }
  if (billList.length === 0) {
    return fail(AI_ERROR.BAD_INPUT, '账单列表为空，无数据可分析');
  }
  if (!billList.every((b) => b && typeof b === 'object')) {
    return fail(AI_ERROR.BAD_INPUT, '账单数组包含非法元素');
  }

  if (AI_CONFIG.MODE === 'local') {
    const key = getLocalApiKey();
    if (!key) {
      return fail(AI_ERROR.NO_KEY, '本地调试模式未配置 API Key，请先调用 setLocalApiKey() 手动填写');
    }
  }

  report('loading');
  try {
    const prompt = await buildPrompt(billList);
    const text = await requestChat({
      key: getLocalApiKey(),
      prompt,
      timeout,
      signal,
    });
    report('done');
    return { ok: true, text };
  } catch (err) {
    report('error');
    return fail(err.code || AI_ERROR.NETWORK, err.message || '请求失败');
  }
}

export {
  AI_CONFIG,
  AI_ERROR,
  getLocalApiKey,
  setLocalApiKey,
  buildPrompt,
  getBillAnalysis,
};