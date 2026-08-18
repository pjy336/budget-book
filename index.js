/**
 * 预算魔法账本・AI 中转代理服务
 * 新增：登录注册、SQLite 云端账单、导出 CSV 接口
 */
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const https = require('https');

// ========= 新增数据库与鉴权模块 =========
const db = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET } = require('./middleware/auth');

// 加载 .env 配置
dotenv.config();
const app = express();

/* ---------- 配置区（全部来自环境变量） ---------- */
const PORT = Number(process.env.PORT || 8787);
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions').trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const MODEL_NAME = process.env.MODEL_NAME || 'deepseek-chat';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60000);

/* ---------- 基础中间件 ---------- */
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ===================== 【AI 接口：放在最顶部，确保优先匹配】 =====================
async function handleChat(req, res) {
    // 【关键日志】请求到达就会打印，用来验证路由是否生效
    console.log('[AI接口收到请求]', req.method, req.path);

    if (!DEEPSEEK_API_KEY) {
        return res.status(500).json({
            error: { message: '服务端未配置 DEEPSEEK_API_KEY，请编辑环境变量后重启服务' },
        });
    }

    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return res.status(400).json({
            error: { message: '请求体缺少有效的 messages 字段，需为 OpenAI Chat Completions 格式' },
        });
    }

    const upstreamBody = {
        model: body.model || MODEL_NAME,
        messages: body.messages,
    };
    if (typeof body.temperature === 'number') upstreamBody.temperature = body.temperature;
    if (typeof body.max_tokens === 'number') upstreamBody.max_tokens = body.max_tokens;
    if (typeof body.top_p === 'number') upstreamBody.top_p = body.top_p;
    if (typeof body.stream === 'boolean') upstreamBody.stream = body.stream;

    const postData = JSON.stringify(upstreamBody);
    const url = new URL(DEEPSEEK_BASE_URL);

    const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: TIMEOUT_MS,
    };

    const reqUpstream = https.request(options, (resUpstream) => {
        let data = '';
        resUpstream.on('data', (chunk) => { data += chunk; });
        resUpstream.on('end', () => {
            console.log('[AI上游响应] 状态码:', resUpstream.statusCode);
            res.status(resUpstream.statusCode).type('application/json').send(data);
        });
    });

    reqUpstream.on('error', (err) => {
        console.error('[AI上游请求失败]', err.message);
        return res.status(502).json({
            error: { message: `无法连接上游 AI 服务：${err.message}` },
        });
    });

    reqUpstream.on('timeout', () => {
        reqUpstream.destroy();
        return res.status(504).json({
            error: { message: `上游请求超时（${TIMEOUT_MS}ms），请稍后重试` },
        });
    });

    reqUpstream.write(postData);
    reqUpstream.end();
}

// AI 路由（最优先匹配）
app.post('/api/ai/chat', handleChat);
app.post('/api/ai/chat/completions', handleChat);
app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'budget-book-ai-proxy', keyConfigured: Boolean(DEEPSEEK_API_KEY) });
});

// ===================== 【账号 & 云端账单接口】 =====================
// 注册
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.json({ ok: false, msg: '账号密码不能为空' });

        db.get(`SELECT id FROM users WHERE username = ?`, [username], async (err, row) => {
            if (row) return res.json({ ok: false, msg: '用户名已存在' });
            const hash = await bcrypt.hash(password, 10);
            db.run(`INSERT INTO users(username,password) VALUES(?,?)`, [username, hash], function (e) {
                if (e) return res.json({ ok: false, msg: '注册失败' });
                res.json({ ok: true, msg: '注册成功' });
            })
        })

    } catch (e) {
        res.json({ ok: false, msg: '服务异常：' + e.message })
    }
})

// 登录
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        db.get(`SELECT * FROM users WHERE username=?`, [username], async (err, user) => {
            if (!user) return res.json({ ok: false, msg: '账号不存在' });
            const ok = await bcrypt.compare(password, user.password);
            if (!ok) return res.json({ ok: false, msg: '密码错误' });
            const token = jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
            res.json({ ok: true, token, username: user.username })
        })
    } catch (e) {
        res.json({ ok: false, msg: '服务异常：' + e.message })
    }
})

// 获取当前用户所有账单
app.get('/api/cloud/bills', authMiddleware, (req, res) => {
    const uid = req.user.uid;
    db.all(`SELECT * FROM bills WHERE user_id=? ORDER BY date DESC`, [uid], (err, list) => {
        res.json({ ok: true, data: list })
    })
})

// 新增账单
app.post('/api/cloud/bills', authMiddleware, (req, res) => {
    const uid = req.user.uid;
    const { type, amount, category, date, remark } = req.body;
    db.run(`INSERT INTO bills(user_id,type,amount,category,date,remark) VALUES(?,?,?,?,?,?)`,
        [uid, type, amount, category, date, remark],
        function () {
            res.json({ ok: true, id: this.lastID })
        })
})

// 修改账单
app.put('/api/cloud/bills/:id', authMiddleware, (req, res) => {
    const uid = req.user.uid;
    const billId = req.params.id;
    const { type, amount, category, date, remark } = req.body;
    db.run(`UPDATE bills SET type=?,amount=?,category=?,date=?,remark=? WHERE id=? AND user_id=?`,
        [type, amount, category, date, remark, billId, uid],
        (err) => {
            res.json({ ok: !err })
        })
})

// 删除账单
app.delete('/api/cloud/bills/:id', authMiddleware, (req, res) => {
    const uid = req.user.uid;
    const billId = req.params.id;
    db.run(`DELETE FROM bills WHERE id=? AND user_id=?`, [billId, uid], err => {
        res.json({ ok: !err })
    })
})

// 导出账单 CSV 接口
app.get('/api/cloud/bills/export', authMiddleware, (req, res) => {
    const uid = req.user.uid;
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment;filename=bills.csv');
    db.all(`SELECT date,type,amount,category,remark FROM bills WHERE user_id=? ORDER BY date`, [uid], (err, rows) => {
        let csv = '日期,收支类型,金额,分类,备注\n';
        rows.forEach(r => {
            csv += `${r.date},${r.type},${r.amount},${r.category},"${r.remark || ''}"\n`
        })
        res.end('\uFEFF' + csv);
    })
})

// ========= 静态页面【所有API接口之后】 =========
const CLIENT_DIR = path.join(__dirname, 'client');
if (fs.existsSync(CLIENT_DIR)) {
    app.use(express.static(CLIENT_DIR));
}

// ========= SPA单页回退路由，放在文件路由最末尾 =========
if (fs.existsSync(path.join(CLIENT_DIR, 'index.html'))) {
    app.get('*', (req, res) => {
        res.sendFile(path.join(CLIENT_DIR, 'index.html'));
    });
}

/* ---------- 启动服务 ---------- */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 服务实际监听端口: ${PORT}`);
    console.log(`[ai-proxy] 服务已启动`);
    console.log(`[ai-proxy] 上游端点: ${DEEPSEEK_BASE_URL}`);
    console.log(`[ai-proxy] 默认模型: ${MODEL_NAME}`);
    console.log(`[ai-proxy] 请求超时: ${TIMEOUT_MS}ms`);
    console.log(`[ai-proxy] API 密钥: ${DEEPSEEK_API_KEY ? '已配置 ✓' : '未配置 ✗'}`);
});
