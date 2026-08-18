const jwt = require('jsonwebtoken');

// 优先读环境变量，本地兜底测试密钥
const JWT_SECRET = process.env.JWT_SECRET || "local-test-secret-key-123456";

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.json({ ok: false, msg: "未携带token，请登录" });
  }
  const token = authHeader.replace("Bearer ", "");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.json({ ok: false, msg: "token无效或已过期，请重新登录" });
  }
}

module.exports = {
  authMiddleware,
  JWT_SECRET
};
