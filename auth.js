const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supermarket-system-secret-key-2024';
const JWT_EXPIRES = '24h';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Allow read access to public endpoints without auth
    if (req.method === 'GET' && (req.path === '/api/products' || req.path.startsWith('/api/products/'))) {
      return next();
    }
    return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, message: 'Token无效或已过期，请重新登录' });
  }
}

// Role-based access control
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ code: 403, message: '权限不足' });
    }
    next();
  };
}

module.exports = { generateToken, authMiddleware, requireRole, JWT_SECRET };
