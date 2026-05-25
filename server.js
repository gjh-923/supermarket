const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, initDatabase } = require('./db');
const { generateToken, authMiddleware } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3457;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA-like behavior
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send('<h1>超市管理系统后端已启动</h1><p>请将前端HTML文件放在 public/ 目录下命名为 index.html。</p>');
  }
});

// Multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// Initialize database
initDatabase();

// ==================== HELPER ====================
function ok(data) { return { code: 0, data }; }
function okMsg(msg) { return { code: 0, message: msg }; }
function err(msg, code = 1) { return { code, message: msg }; }
function paginate(items, page = 1, pageSize = 10) {
  page = Math.max(1, parseInt(page) || 1);
  pageSize = Math.max(1, parseInt(pageSize) || 10);
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const list = items.slice(start, start + pageSize);
  return { list, total, page, pageSize, totalPages };
}

// Sync SQL tables to data_store JSON after mutations (checkout, purchase, inventory changes, etc.)
// 将 data_store 中同步的数据回写到对应的 SQL 表，防止 syncAffectedTablesToDataStore
// 因 SQL 表为空而覆盖 data_store 已同步的数据
function _syncToSqlTable(storeKey, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  if (storeKey === 'products') {
    const stmt = db.prepare(`INSERT OR REPLACE INTO products
      (id, code, name, category, supplier, purchase_price, retail_price, stock, unit, status, sales, produce_date, expiry_date, description, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMany = db.transaction((items) => {
      for (const p of items) {
        stmt.run(p.id, p.code || '', p.name || '', p.category || '', p.supplier || '',
          p.purchasePrice || p.purchase_price || 0, p.retailPrice || p.retail_price || 0,
          p.stock || 0, p.unit || '个', p.status || '上架', p.sales || 0,
          p.produceDate || p.produce_date || '', p.expiryDate || p.expiry_date || '',
          p.description || '', p.image || p.imageUrl || '');
      }
    });
    insertMany(rows);
  }

  if (storeKey === 'members') {
    const stmt = db.prepare(`INSERT OR REPLACE INTO members
      (id, card_no, name, gender, birthday, phone, email, address, level, points, cumulative_points, join_date, total_spent, status, last_consume_date, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMany = db.transaction((items) => {
      for (const m of items) {
        stmt.run(m.id, m.cardNo || '', m.name || '', m.gender || '', m.birthday || '',
          m.phone || '', m.email || '', m.address || '', m.level || '普通会员',
          m.points || 0, m.cumulativePoints || 0, m.joinDate || '',
          m.totalSpent || 0, m.status || '正常', m.lastConsumeDate || '', m.source || '门店注册');
      }
    });
    insertMany(rows);
  }

  if (storeKey === 'categories') {
    // categories 仅存 data_store，无对应 SQL 表结构需要同步
  }

  if (storeKey === 'schedules') {
    const delStmt = db.prepare('DELETE FROM schedules');
    const insStmt = db.prepare('INSERT INTO schedules (id, employee_id, employee_name, date, shift) VALUES (?, ?, ?, ?, ?)');
    const replaceAll = db.transaction((items) => {
      delStmt.run();
      for (const s of items) {
        insStmt.run(s.id, s.employee_id || s.employeeId || '', s.employee_name || s.employeeName || '', s.date || '', s.shift || '早班');
      }
    });
    replaceAll(rows);
  }

  if (storeKey === 'salesOrders') {
    const stmt = db.prepare(`INSERT OR REPLACE INTO sales_orders
      (id, order_no, member_id, member_name, member_phone, items, total_amount, discount_amount, final_amount, coupon_id, coupon_name, coupon_discount, pay_method, operator, order_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMany = db.transaction((items) => {
      for (const o of items) {
        stmt.run(
          o.id, o.orderNo || '', o.memberId || null, o.memberName || '', o.memberPhone || '',
          JSON.stringify(o.items || []), o.originalAmount || 0, o.discountAmount || 0,
          o.totalAmount || 0, o.couponId || null, o.couponName || '',
          o.couponDiscount || 0, o.paymentMethod || o.payMethod || '现金',
          o.cashier || o.operator || '', o.time || o.orderDate || ''
        );
      }
    });
    insertMany(rows);
  }
}

function syncAffectedTablesToDataStore() {
  const upsert = db.prepare('INSERT OR REPLACE INTO data_store (key, data) VALUES (?, ?)');

  // Products: convert snake_case SQL → camelCase JSON
  const products = db.prepare('SELECT * FROM products').all();
  upsert.run('products', JSON.stringify(products.map(p => ({
    id: p.id, code: p.code, name: p.name, category: p.category,
    supplier: p.supplier, purchasePrice: p.purchase_price, retailPrice: p.retail_price,
    stock: p.stock, unit: p.unit, status: p.status, sales: p.sales,
    produceDate: p.produce_date, expiryDate: p.expiry_date,
    description: p.description, image: p.image_url
  }))));

  // Categories
  const categories = db.prepare('SELECT * FROM categories').all();
  upsert.run('categories', JSON.stringify(categories.map(c => ({
    id: c.id, name: c.name, sortOrder: c.sort, status: c.status,
    image: c.image || '', notes: c.description || '', description: c.description || ''
  }))));

  // SalesOrders
  const salesOrders = db.prepare('SELECT * FROM sales_orders ORDER BY id DESC').all();
  upsert.run('salesOrders', JSON.stringify(salesOrders.map(o => ({
    id: o.id, orderNo: o.order_no, memberId: o.member_id, memberName: o.member_name,
    memberPhone: o.member_phone, items: typeof o.items === 'string' ? JSON.parse(o.items) : o.items,
    originalAmount: o.total_amount, totalAmount: o.final_amount, discountAmount: o.discount_amount,
    couponId: o.coupon_id, couponName: o.coupon_name, couponDiscount: o.coupon_discount,
    payMethod: o.pay_method, cashier: o.operator, time: o.order_date,
    paymentMethod: o.pay_method, orderDate: o.order_date, operator: o.operator
  }))));

  // Members
  const members = db.prepare('SELECT * FROM members').all();
  upsert.run('members', JSON.stringify(members.map(m => ({
    id: m.id, cardNo: m.card_no, name: m.name, gender: m.gender,
    birthday: m.birthday, phone: m.phone, email: m.email, address: m.address,
    level: m.level, points: m.points, cumulativePoints: m.cumulative_points || 0,
    joinDate: m.join_date, totalSpent: m.total_spent,
    status: m.status, lastConsumeDate: m.last_consume_date,
    source: m.source
  }))));

  // FinanceLedger
  const ledger = db.prepare('SELECT * FROM finance_ledger ORDER BY id DESC').all();
  upsert.run('financeLedger', JSON.stringify(ledger.map(l => ({
    id: l.id, date: l.date, type: l.type, category: l.category,
    amount: l.amount, account: l.account, summary: l.summary, voucherNo: l.voucher_no,
    createdAt: l.created_at
  }))));

  // InventoryRecords
  const inventoryRecords = db.prepare('SELECT * FROM inventory_records ORDER BY id DESC').all();
  upsert.run('inventoryRecords', JSON.stringify(inventoryRecords.map(r => ({
    id: r.id, productId: r.product_id, productName: r.product_name,
    type: r.type, qty: r.qty, beforeStock: r.before_stock, afterStock: r.after_stock,
    operator: r.operator, note: r.note, time: r.time, createdAt: r.created_at
  }))));

  // MemberLevels
  const memberLevels = db.prepare('SELECT * FROM member_levels ORDER BY min_spent DESC').all();
  upsert.run('memberLevels', JSON.stringify(memberLevels.map(l => ({
    id: l.id, name: l.name, minSpent: l.min_spent, discount: l.discount,
    pointsRate: l.points_rate, cardColor: l.card_color, benefits: l.benefits
  }))));

  // MemberPointsRecords
  const pointsRecords = db.prepare('SELECT * FROM member_points_records ORDER BY id DESC').all();
  upsert.run('memberPointsRecords', JSON.stringify(pointsRecords.map(r => ({
    id: r.id, memberId: r.member_id, memberName: r.member_name,
    type: r.type, points: r.points, balance: r.balance,
    time: r.time, operator: r.operator, note: r.note
  }))));

  // SystemLogs
  const logs = db.prepare('SELECT * FROM system_logs ORDER BY id DESC').all();
  upsert.run('systemLogs', JSON.stringify(logs.map(l => ({
    id: l.id, time: l.time, user: l.user, action: l.action
  }))));

  // Schedules
  const schedules = db.prepare('SELECT * FROM schedules ORDER BY date, id').all();
  upsert.run('schedules', JSON.stringify(schedules.map(s => ({
    id: s.id, employee_id: s.employee_id, employee_name: s.employee_name,
    date: s.date, shift: s.shift
  }))));
}

// ==================== AUTH ROUTES ====================

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json(err('请输入用户名和密码'));

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      // Record failed login
      db.prepare(`INSERT INTO login_logs (username, real_name, ip, browser, os, login_time, status, message)
        VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?)`)
        .run(username, '未知用户', req.ip || '127.0.0.1', req.headers['user-agent'] || '', '', '失败', '用户名不存在');
      return res.json(err('用户名不存在'));
    }

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) {
      db.prepare(`INSERT INTO login_logs (username, real_name, ip, browser, os, login_time, status, message)
        VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?)`)
        .run(username, user.name, req.ip || '127.0.0.1', req.headers['user-agent'] || '', '', '失败', '密码错误');
      return res.json(err('密码错误'));
    }

    const token = generateToken(user);
    db.prepare(`INSERT INTO login_logs (username, real_name, ip, browser, os, login_time, status, message)
      VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?)`)
      .run(username, user.name, req.ip || '127.0.0.1', req.headers['user-agent'] || '', '', '成功', '');

    // Also record in system logs
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, '登录成功')`)
      .run(user.name);

    res.json(ok({
      token,
      user: { id: user.id, username: user.username, role: user.role, name: user.name }
    }));
  } catch (e) {
    console.error('Login error:', e);
    res.json(err('登录失败: ' + e.message));
  }
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  if (req.user) {
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, '退出登录')`)
      .run(req.user.name);
  }
  res.json(okMsg('已退出'));
});

// ==================== PRODUCTS ====================

app.get('/api/products', (req, res) => {
  try {
    let products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    const { page, pageSize, search, category, status } = req.query;
    if (search) {
      const s = `%${search}%`;
      products = db.prepare(`SELECT * FROM products WHERE name LIKE ? OR code LIKE ? OR supplier LIKE ? ORDER BY id DESC`).all(s, s, s);
    } else if (category) {
      products = db.prepare('SELECT * FROM products WHERE category = ? ORDER BY id DESC').all(category);
    } else if (status) {
      products = db.prepare('SELECT * FROM products WHERE status = ? ORDER BY id DESC').all(status);
    }
    const result = paginate(products, page, pageSize);
    res.json(ok(result));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.get('/api/products/:id', (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.json(err('商品不存在'));
    res.json(ok(product));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.post('/api/products', authMiddleware, (req, res) => {
  try {
    const p = req.body;
    const stmt = db.prepare(`INSERT INTO products (code, name, category, supplier, purchase_price, retail_price, stock, unit, status, sales, produce_date, expiry_date, description, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(p.code || ('SP' + Date.now()), p.name, p.category || '', p.supplier || '',
      p.purchasePrice || 0, p.retailPrice || 0, p.stock || 0, p.unit || '个', p.status || '上架', p.sales || 0,
      p.produceDate || '', p.expiryDate || '', p.description || '', p.imageUrl || '');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `新增商品: ${p.name}`);
    syncAffectedTablesToDataStore();
    res.json(ok(product));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.put('/api/products/:id', authMiddleware, (req, res) => {
  try {
    const p = req.body;
    db.prepare(`UPDATE products SET code=?, name=?, category=?, supplier=?, purchase_price=?, retail_price=?, stock=?, unit=?, status=?, sales=?, produce_date=?, expiry_date=?, description=?, image_url=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(p.code, p.name, p.category || '', p.supplier || '', p.purchasePrice || 0, p.retailPrice || 0, p.stock || 0,
        p.unit || '个', p.status || '上架', p.sales || 0, p.produceDate || '', p.expiryDate || '', p.description || '', p.imageUrl || '', req.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `编辑商品: ${p.name}`);
    syncAffectedTablesToDataStore();
    res.json(ok(product));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.delete('/api/products/:id', authMiddleware, (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.json(err('商品不存在'));
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `删除商品: ${product.name}`);
    syncAffectedTablesToDataStore();
    res.json(okMsg('删除成功'));
  } catch (e) {
    res.json(err(e.message));
  }
});

// ==================== CATEGORIES ====================

app.get('/api/categories', (req, res) => {
  try {
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
    // Return as array of strings for backward compatibility
    const names = cats.map(c => c.name);
    res.json(ok(names));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.post('/api/categories', authMiddleware, (req, res) => {
  try {
    const { name, sort, description } = req.body;
    db.prepare('INSERT OR IGNORE INTO categories (name, sort, description) VALUES (?, ?, ?)').run(name, sort || 0, description || '');
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `新增分类: ${name}`);
    syncAffectedTablesToDataStore();
    res.json(okMsg('添加成功'));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.put('/api/categories/:name', authMiddleware, (req, res) => {
  try {
    const { name, sort, description } = req.body;
    db.prepare('UPDATE categories SET sort=?, description=? WHERE name=?').run(sort || 0, description || '', req.params.name);
    // Also update products that use this category
    if (name && name !== req.params.name) {
      db.prepare('UPDATE products SET category=? WHERE category=?').run(name, req.params.name);
    }
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `编辑分类: ${req.params.name}`);
    syncAffectedTablesToDataStore();
    res.json(okMsg('修改成功'));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.delete('/api/categories/:name', authMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM categories WHERE name = ?').run(req.params.name);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `删除分类: ${req.params.name}`);
    syncAffectedTablesToDataStore();
    res.json(okMsg('删除成功'));
  } catch (e) {
    res.json(err(e.message));
  }
});

// ==================== MEMBERS ====================

app.get('/api/members', (req, res) => {
  try {
    let members = db.prepare('SELECT * FROM members ORDER BY id DESC').all();
    const { page, pageSize, search, level, status } = req.query;
    if (search) {
      const s = `%${search}%`;
      members = db.prepare('SELECT * FROM members WHERE name LIKE ? OR card_no LIKE ? OR phone LIKE ? ORDER BY id DESC').all(s, s, s);
    } else if (level) {
      members = db.prepare('SELECT * FROM members WHERE level = ? ORDER BY id DESC').all(level);
    } else if (status) {
      members = db.prepare('SELECT * FROM members WHERE status = ? ORDER BY id DESC').all(status);
    }
    // Parse cardNo → lowercase for frontend compat
    members = members.map(m => ({ ...m, cardNo: m.card_no }));
    const result = paginate(members, page, pageSize);
    res.json(ok(result));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.post('/api/members', authMiddleware, (req, res) => {
  try {
    const m = req.body;
    const stmt = db.prepare(`INSERT INTO members (card_no, name, gender, birthday, phone, email, address, level, points, cumulative_points, join_date, total_spent, status, last_consume_date, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(m.cardNo || ('HY' + Date.now()), m.name, m.gender || '', m.birthday || '',
      m.phone || '', m.email || '', m.address || '', m.level || '普通会员', m.points || 0,
      m.cumulativePoints || 0,
      m.joinDate || new Date().toISOString().slice(0, 10), m.totalSpent || 0, m.status || '正常',
      m.lastConsumeDate || '', m.source || '门店注册');
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(result.lastInsertRowid);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `新增会员: ${m.name}`);
    syncAffectedTablesToDataStore();
    res.json(ok({ ...member, cardNo: member.card_no }));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.put('/api/members/:id', authMiddleware, (req, res) => {
  try {
    const m = req.body;
    db.prepare(`UPDATE members SET card_no=?, name=?, gender=?, birthday=?, phone=?, email=?, address=?, level=?, points=?, cumulative_points=?, join_date=?, total_spent=?, status=?, last_consume_date=?, source=? WHERE id=?`)
      .run(m.cardNo, m.name, m.gender || '', m.birthday || '', m.phone || '', m.email || '', m.address || '',
        m.level || '普通会员', m.points || 0, m.cumulativePoints || 0, m.joinDate || '', m.totalSpent || 0, m.status || '正常',
        m.lastConsumeDate || '', m.source || '门店注册', req.params.id);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `编辑会员: ${m.name}`);
    syncAffectedTablesToDataStore();
    res.json(ok({ ...member, cardNo: member.card_no }));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.delete('/api/members/:id', authMiddleware, (req, res) => {
  try {
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!member) return res.json(err('会员不存在'));
    db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `删除会员: ${member.name}`);
    syncAffectedTablesToDataStore();
    res.json(okMsg('删除成功'));
  } catch (e) {
    res.json(err(e.message));
  }
});

// ==================== MEMBER LEVELS ====================

app.get('/api/member-levels', (req, res) => {
  const levels = db.prepare('SELECT * FROM member_levels ORDER BY min_spent').all();
  res.json(ok(levels));
});

app.post('/api/member-levels', authMiddleware, (req, res) => {
  const l = req.body;
  db.prepare('INSERT INTO member_levels (name, min_spent, discount, points_rate, card_color, benefits) VALUES (?, ?, ?, ?, ?, ?)')
    .run(l.name, l.minSpent || 0, l.discount || 100, l.pointsRate || 1, l.cardColor || '#9e9e9e', l.benefits || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/member-levels/:id', authMiddleware, (req, res) => {
  const l = req.body;
  db.prepare('UPDATE member_levels SET name=?, min_spent=?, discount=?, points_rate=?, card_color=?, benefits=? WHERE id=?')
    .run(l.name, l.minSpent || 0, l.discount || 100, l.pointsRate || 1, l.cardColor || '#9e9e9e', l.benefits || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/member-levels/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM member_levels WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== MEMBER POINTS RECORDS ====================

app.get('/api/member-points-records', (req, res) => {
  let records = db.prepare('SELECT * FROM member_points_records ORDER BY id DESC').all();
  const { page, pageSize, memberId } = req.query;
  if (memberId) {
    records = db.prepare('SELECT * FROM member_points_records WHERE member_id = ? ORDER BY id DESC').all(memberId);
  }
  const result = paginate(records, page, pageSize);
  res.json(ok(result));
});

app.post('/api/member-points-records', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('INSERT INTO member_points_records (member_id, member_name, type, points, balance, time, operator, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.memberId, r.memberName, r.type, r.points || 0, r.balance || 0, r.time || new Date().toLocaleString(), r.operator || req.user.name, r.note || '');
  // Update member points
  if (r.memberId) {
    db.prepare('UPDATE members SET points = points + ? WHERE id = ?').run(r.points || 0, r.memberId);
    // For positive additions, also update cumulative_points
    if ((r.points || 0) > 0) {
      db.prepare('UPDATE members SET cumulative_points = cumulative_points + ? WHERE id = ?').run(r.points || 0, r.memberId);
    }
  }
  res.json(okMsg('添加成功'));
});

// ==================== SUPPLIERS ====================

app.get('/api/suppliers', (req, res) => {
  let suppliers = db.prepare('SELECT * FROM suppliers ORDER BY id DESC').all();
  const { page, pageSize, search } = req.query;
  if (search) {
    const s = `%${search}%`;
    suppliers = db.prepare('SELECT * FROM suppliers WHERE name LIKE ? OR code LIKE ? ORDER BY id DESC').all(s, s);
  }
  const result = paginate(suppliers, page, pageSize);
  res.json(ok(result));
});

app.post('/api/suppliers', authMiddleware, (req, res) => {
  const s = req.body;
  const stmt = db.prepare(`INSERT INTO suppliers (code, name, contact, phone, email, address, products, level, status, cooperation_date, bank_account, tax_id, notes, supply_capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(s.code || ('GYS' + Date.now()), s.name, s.contact || '', s.phone || '', s.email || '', s.address || '',
    s.products || '', s.level || 'B级', s.status || '合作中', s.cooperationDate || '', s.bankAccount || '', s.taxId || '',
    s.notes || '', s.supplyCapacity || '');
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `新增供应商: ${s.name}`);
  res.json(okMsg('添加成功'));
});

app.put('/api/suppliers/:id', authMiddleware, (req, res) => {
  const s = req.body;
  db.prepare(`UPDATE suppliers SET code=?, name=?, contact=?, phone=?, email=?, address=?, products=?, level=?, status=?, cooperation_date=?, bank_account=?, tax_id=?, notes=?, supply_capacity=? WHERE id=?`)
    .run(s.code, s.name, s.contact || '', s.phone || '', s.email || '', s.address || '', s.products || '',
      s.level || 'B级', s.status || '合作中', s.cooperationDate || '', s.bankAccount || '', s.taxId || '',
      s.notes || '', s.supplyCapacity || '', req.params.id);
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `编辑供应商: ${s.name}`);
  res.json(okMsg('修改成功'));
});

app.delete('/api/suppliers/:id', authMiddleware, (req, res) => {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!supplier) return res.json(err('供应商不存在'));
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `删除供应商: ${supplier.name}`);
  syncAffectedTablesToDataStore();
  res.json(okMsg('删除成功'));
});

// ==================== SUPPLIER CONTRACTS & EVALUATIONS ====================

app.get('/api/supplier-contracts', (req, res) => {
  const list = db.prepare('SELECT * FROM supplier_contracts ORDER BY id DESC').all();
  res.json(ok(list));
});

app.post('/api/supplier-contracts', authMiddleware, (req, res) => {
  const c = req.body;
  db.prepare(`INSERT INTO supplier_contracts (supplier_id, supplier_name, contract_no, sign_date, expiry_date, amount, status, type, payment_terms, scope, attachment, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.supplierId, c.supplierName, c.contractNo, c.signDate || '', c.expiryDate || '', c.amount || 0,
      c.status || '生效中', c.type || '', c.paymentTerms || '', c.scope || '', c.attachment || '', c.notes || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/supplier-contracts/:id', authMiddleware, (req, res) => {
  const c = req.body;
  db.prepare(`UPDATE supplier_contracts SET supplier_id=?, supplier_name=?, contract_no=?, sign_date=?, expiry_date=?, amount=?, status=?, type=?, payment_terms=?, scope=?, attachment=?, notes=? WHERE id=?`)
    .run(c.supplierId, c.supplierName, c.contractNo, c.signDate || '', c.expiryDate || '', c.amount || 0,
      c.status || '生效中', c.type || '', c.paymentTerms || '', c.scope || '', c.attachment || '', c.notes || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/supplier-contracts/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM supplier_contracts WHERE id = ?').run(req.params.id);
  syncAffectedTablesToDataStore();
  res.json(okMsg('删除成功'));
});

app.get('/api/supplier-evaluations', (req, res) => {
  const list = db.prepare('SELECT * FROM supplier_evaluations ORDER BY id DESC').all();
  res.json(ok(list));
});

app.post('/api/supplier-evaluations', authMiddleware, (req, res) => {
  const e = req.body;
  db.prepare(`INSERT INTO supplier_evaluations (supplier_id, supplier_name, rating, quality, delivery, price, service, comment, evaluator, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.supplierId, e.supplierName, e.rating || 3, e.quality || 3, e.delivery || 3, e.price || 3, e.service || 3,
      e.comment || '', e.evaluator || req.user.name, e.date || new Date().toISOString().slice(0, 10));
  res.json(okMsg('添加成功'));
});

app.delete('/api/supplier-evaluations/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM supplier_evaluations WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== EMPLOYEES ====================

app.get('/api/employees', (req, res) => {
  let emps = db.prepare('SELECT * FROM employees ORDER BY id DESC').all();
  const { page, pageSize, search } = req.query;
  if (search) {
    const s = `%${search}%`;
    emps = db.prepare('SELECT * FROM employees WHERE name LIKE ? OR code LIKE ? OR dept LIKE ? ORDER BY id DESC').all(s, s, s);
  }
  const result = paginate(emps, page, pageSize);
  res.json(ok(result));
});

app.post('/api/employees', authMiddleware, (req, res) => {
  const em = req.body;
  db.prepare('INSERT INTO employees (name, code, dept, position, phone, join_date) VALUES (?, ?, ?, ?, ?, ?)')
    .run(em.name, em.code || ('EMP' + Date.now().toString(36)), em.dept || '', em.position || '', em.phone || '', em.joinDate || '');
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `新增员工: ${em.name}`);
  res.json(okMsg('添加成功'));
});

app.put('/api/employees/:id', authMiddleware, (req, res) => {
  const em = req.body;
  db.prepare('UPDATE employees SET name=?, code=?, dept=?, position=?, phone=?, join_date=? WHERE id=?')
    .run(em.name, em.code, em.dept || '', em.position || '', em.phone || '', em.joinDate || '', req.params.id);
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `编辑员工: ${em.name}`);
  res.json(okMsg('修改成功'));
});

app.delete('/api/employees/:id', authMiddleware, (req, res) => {
  const empId = req.params.id;
  // 从 SQLite employees 表删除（可能不存在，因为是前端同步到 data_store 的数据）
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
  if (emp) {
    db.prepare('DELETE FROM employees WHERE id = ?').run(empId);
  }
  // 从 data_store 中移除（这是前端同步的权威数据源，必须清理）
  try {
    const dsRow = db.prepare('SELECT data FROM data_store WHERE key = ?').get('employees');
    if (dsRow && dsRow.data) {
      const list = JSON.parse(dsRow.data);
      const filtered = list.filter(r => String(r.id) !== String(empId));
      if (filtered.length < list.length) {
        db.prepare('INSERT OR REPLACE INTO data_store (key, data) VALUES (?, ?)')
          .run('employees', JSON.stringify(filtered));
      }
    }
  } catch(e) { console.error('data_store 清理失败:', e); }
  const name = emp ? emp.name : ('ID:' + empId);
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `删除员工: ${name}`);
  res.json(okMsg('删除成功'));
});

// ==================== EMPLOYEE POSITIONS ====================

app.get('/api/employee-positions', (req, res) => {
  const list = db.prepare('SELECT * FROM employee_positions ORDER BY id').all();
  res.json(ok(list));
});

app.post('/api/employee-positions', authMiddleware, (req, res) => {
  const p = req.body;
  db.prepare('INSERT INTO employee_positions (name, category, description, employee_ids, employee_names) VALUES (?, ?, ?, ?, ?)')
    .run(p.name, p.category || '', p.description || '', JSON.stringify(p.employeeIds || []), JSON.stringify(p.employeeNames || []));
  res.json(okMsg('添加成功'));
});

app.put('/api/employee-positions/:id', authMiddleware, (req, res) => {
  const p = req.body;
  db.prepare('UPDATE employee_positions SET name=?, category=?, description=?, employee_ids=?, employee_names=? WHERE id=?')
    .run(p.name, p.category || '', p.description || '', JSON.stringify(p.employeeIds || []), JSON.stringify(p.employeeNames || []), req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/employee-positions/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM employee_positions WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== DEPARTMENTS ====================

app.get('/api/departments', (req, res) => {
  const list = db.prepare('SELECT * FROM departments ORDER BY id').all();
  res.json(ok(list));
});

app.post('/api/departments', authMiddleware, (req, res) => {
  const d = req.body;
  db.prepare('INSERT INTO departments (name, code, manager, phone, status, create_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d.name, d.code || ('DEPT' + Date.now().toString(36)), d.manager || '', d.phone || '', d.status || '正常', d.createDate || new Date().toISOString().slice(0, 10), d.description || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/departments/:id', authMiddleware, (req, res) => {
  const d = req.body;
  db.prepare('UPDATE departments SET name=?, code=?, manager=?, phone=?, status=?, create_date=?, description=? WHERE id=?')
    .run(d.name, d.code, d.manager || '', d.phone || '', d.status || '正常', d.createDate || '', d.description || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/departments/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== SCHEDULES ====================

app.get('/api/schedules', (req, res) => {
  let schedules = db.prepare('SELECT * FROM schedules ORDER BY date, id').all();
  const { date, employeeId } = req.query;
  if (date) schedules = db.prepare('SELECT * FROM schedules WHERE date = ? ORDER BY id').all(date);
  if (employeeId) schedules = db.prepare('SELECT * FROM schedules WHERE employee_id = ? ORDER BY date').all(employeeId);
  res.json(ok(schedules));
});

app.post('/api/schedules/batch', authMiddleware, (req, res) => {
  const { dateStr, shifts } = req.body;
  if (!dateStr || !shifts || !Array.isArray(shifts)) return res.json(err('参数错误'));
  // Delete existing schedules for this date
  db.prepare('DELETE FROM schedules WHERE date = ?').run(dateStr);
  // Insert new shifts
  const stmt = db.prepare('INSERT INTO schedules (id, employee_id, employee_name, date, shift) VALUES (?, ?, ?, ?, ?)');
  const insertMany = db.transaction((items) => {
    for (const s of items) {
      stmt.run(s.id, s.employeeId ?? s.employee_id, s.employeeName || s.employee_name || '', dateStr, s.shift || '早班');
    }
  });
  insertMany(shifts);
  syncAffectedTablesToDataStore();
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `排班: ${dateStr}`);
  res.json(okMsg('排班保存成功'));
});

app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  syncAffectedTablesToDataStore();
  res.json(okMsg('删除成功'));
});

// ==================== ATTENDANCES ====================

app.get('/api/attendances', (req, res) => {
  let records = db.prepare('SELECT * FROM attendances ORDER BY date DESC, id').all();
  const { date, employeeId } = req.query;
  if (date) records = db.prepare('SELECT * FROM attendances WHERE date = ? ORDER BY id').all(date);
  if (employeeId) records = db.prepare('SELECT * FROM attendances WHERE employee_id = ? ORDER BY date DESC').all(employeeId);
  res.json(ok(records));
});

app.post('/api/attendances/batch', authMiddleware, (req, res) => {
  const { date, records: recs } = req.body;
  if (!date || !recs || !Array.isArray(recs)) return res.json(err('参数错误'));
  // Delete existing records for this date
  db.prepare('DELETE FROM attendances WHERE date = ?').run(date);
  const stmt = db.prepare('INSERT INTO attendances (id, employee_id, employee_name, date, status, check_in, check_out, late_minutes, early_minutes, overtime_minutes, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertMany = db.transaction((items) => {
    for (const r of items) {
      stmt.run(r.id, r.employeeId ?? r.employee_id, r.employeeName || r.employee_name || '', date, r.status || '正常', r.checkIn || r.check_in || '', r.checkOut || r.check_out || '',
        r.lateMinutes || 0, r.earlyMinutes || 0, r.overtimeMinutes || 0, r.note || '');
    }
  });
  insertMany(recs);
  res.json(okMsg('考勤保存成功'));
});

// ==================== SALARIES ====================

app.get('/api/salaries', (req, res) => {
  let salaries = db.prepare('SELECT * FROM salaries ORDER BY year DESC, month DESC, id').all();
  const { year, month, employeeId } = req.query;
  if (year && month) salaries = db.prepare('SELECT * FROM salaries WHERE year = ? AND month = ? ORDER BY id').all(year, month);
  if (employeeId) salaries = db.prepare('SELECT * FROM salaries WHERE employee_id = ? ORDER BY year DESC, month DESC').all(employeeId);
  res.json(ok(salaries));
});

app.post('/api/salaries', authMiddleware, (req, res) => {
  const s = req.body;
  const total = (s.baseSalary || 0) + (s.overtimePay || 0) + (s.bonus || 0) - (s.deduction || 0);
  db.prepare('INSERT INTO salaries (employee_id, employee_name, year, month, base_salary, overtime_pay, bonus, deduction, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.employeeId, s.employeeName, s.year, s.month, s.baseSalary || 0, s.overtimePay || 0, s.bonus || 0, s.deduction || 0, total, s.status || '待发放');
  res.json(okMsg('工资记录添加成功'));
});

app.put('/api/salaries/:id', authMiddleware, (req, res) => {
  const s = req.body;
  const total = (s.baseSalary || 0) + (s.overtimePay || 0) + (s.bonus || 0) - (s.deduction || 0);
  db.prepare('UPDATE salaries SET base_salary=?, overtime_pay=?, bonus=?, deduction=?, total=?, status=? WHERE id=?')
    .run(s.baseSalary || 0, s.overtimePay || 0, s.bonus || 0, s.deduction || 0, total, s.status || '待发放', req.params.id);
  res.json(okMsg('修改成功'));
});

// ==================== SALES / CHECKOUT ====================

app.get('/api/sales-orders', (req, res) => {
  let orders = db.prepare('SELECT * FROM sales_orders ORDER BY id DESC').all();
  const { page, pageSize, search } = req.query;
  if (search) {
    const s = `%${search}%`;
    orders = db.prepare('SELECT * FROM sales_orders WHERE order_no LIKE ? OR member_name LIKE ? OR member_phone LIKE ? ORDER BY id DESC').all(s, s, s);
  }
  // Parse items JSON for frontend
  orders = orders.map(o => {
    try { o.items = JSON.parse(o.items || '[]'); } catch (e) { o.items = []; }
    return o;
  });
  const result = paginate(orders, page, pageSize);
  res.json(ok(result));
});

app.post('/api/sales/checkout', authMiddleware, (req, res) => {
  try {
    const { cart, memberId, useCoupon, selectedCoupon, payMethod } = req.body;
    if (!cart || !Array.isArray(cart) || cart.length === 0) return res.json(err('购物车为空'));

    let totalAmount = 0;
    const items = [];

    // Process each cart item
    const updateStock = db.prepare('UPDATE products SET stock = stock - ?, sales = sales + ? WHERE id = ?');
    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const checkStock = db.transaction(() => {
      for (const item of cart) {
        const product = getProduct.get(item.productId || item.id);
        if (!product) throw new Error(`商品 ${item.name} 不存在`);
        if (product.stock < (item.qty || 1)) throw new Error(`商品 ${product.name} 库存不足 (当前: ${product.stock})`);

        const price = item.price || product.retail_price;
        const qty = item.qty || 1;
        const subtotal = price * qty;
        totalAmount += subtotal;

        items.push({
          productId: product.id,
          name: product.name,
          code: product.code,
          price: price,
          qty: qty,
          subtotal: subtotal
        });

        updateStock.run(qty, qty, product.id);
      }
    });

    try {
      checkStock();
    } catch (e) {
      return res.json(err(e.message));
    }

    // Record inventory movements for each cart item
    const insertInvRecord = db.prepare(`INSERT INTO inventory_records (product_id, product_name, type, qty, before_stock, after_stock, operator, note, time)
      VALUES (?, ?, '出库', ?, ?, ?, ?, ?, datetime('now','localtime'))`);
    for (const item of items) {
      const product = getProduct.get(item.productId);
      if (product) {
        insertInvRecord.run(item.productId, item.name, -item.qty, product.stock + item.qty, product.stock, req.user.name, 'POS销售');
      }
    }

    // Handle member & coupon
    let discountAmount = 0;
    let couponDiscount = 0;
    let couponName = '';
    let memberName = '';
    let memberPhone = '';

    if (memberId) {
      const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
      if (member) {
        memberName = member.name;
        memberPhone = member.phone;
        // Apply member discount
        const level = db.prepare('SELECT * FROM member_levels WHERE name = ?').get(member.level);
        if (level && level.discount < 100) {
          discountAmount = totalAmount * (1 - level.discount / 100);
        }
        // Apply coupon
        if (useCoupon && selectedCoupon && selectedCoupon.name) {
          couponName = selectedCoupon.name;
          couponDiscount = selectedCoupon.discount || selectedCoupon.points / 100 || 0;
          // Deduct points from member
          if (selectedCoupon.points) {
            db.prepare('UPDATE members SET points = MAX(0, points - ?) WHERE id = ?').run(selectedCoupon.points, memberId);
          }
        }
        // Give points for the purchase
        const pointsEarned = Math.floor(totalAmount);
        if (pointsEarned > 0) {
          db.prepare('UPDATE members SET points = points + ?, total_spent = total_spent + ?, cumulative_points = cumulative_points + ? WHERE id = ?')
            .run(pointsEarned, totalAmount, totalAmount, memberId);
          db.prepare(`INSERT INTO member_points_records (member_id, member_name, type, points, balance, time, operator, note)
            VALUES (?, ?, '消费获取', ?, (SELECT points FROM members WHERE id=?), datetime('now','localtime'), ?, ?)`)
            .run(memberId, memberName, pointsEarned, memberId, req.user.name, `消费¥${totalAmount.toFixed(2)}奖励积分`);
        }
        // Update member last consume date
        db.prepare('UPDATE members SET last_consume_date = ? WHERE id = ?').run(new Date().toISOString().slice(0, 10), memberId);
      }
    }

    // Auto-upgrade member level based on total spent
    if (memberId) {
      const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
      if (member) {
        const levels = db.prepare('SELECT * FROM member_levels ORDER BY min_spent DESC').all();
        for (const lv of levels) {
          if ((member.total_spent || 0) >= lv.min_spent && member.level !== lv.name) {
            db.prepare('UPDATE members SET level = ? WHERE id = ?').run(lv.name, memberId);
            db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
              .run(req.user.name, `会员 ${member.name} 升级为 ${lv.name}（累计消费: ¥${member.total_spent || 0}）`);
            break;
          }
        }
      }
    }

    const finalAmount = Math.max(0, totalAmount - discountAmount - couponDiscount);
    const orderNo = 'SO' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();

    db.prepare(`INSERT INTO sales_orders (order_no, member_id, member_name, member_phone, items, total_amount, discount_amount, final_amount, coupon_name, coupon_discount, pay_method, operator, order_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
      .run(orderNo, memberId || null, memberName, memberPhone, JSON.stringify(items), totalAmount, discountAmount, finalAmount,
        couponName, couponDiscount, payMethod || '现金', req.user.name);

    // Record in finance ledger
    db.prepare(`INSERT INTO finance_ledger (date, type, category, amount, account, summary, voucher_no)
      VALUES (date('now','localtime'), '销售收入', '主营业务收入', ?, '库存现金', ?, ?)`)
      .run(finalAmount, `销售订单 ${orderNo}`, 'XJ-' + orderNo);

    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `收银: ${orderNo} ¥${finalAmount.toFixed(2)}`);

    // Sync affected tables to data_store for multi-user data consistency
    syncAffectedTablesToDataStore();

    res.json(ok({ orderNo, totalAmount, discountAmount, couponDiscount, finalAmount, items }));
  } catch (e) {
    console.error('Checkout error:', e);
    res.json(err(e.message));
  }
});

app.put('/api/sales-orders/:id', authMiddleware, (req, res) => {
  const o = req.body;
  db.prepare('UPDATE sales_orders SET items=?, total_amount=?, discount_amount=?, final_amount=?, coupon_name=?, coupon_discount=?, pay_method=? WHERE id=?')
    .run(JSON.stringify(o.items || []), o.totalAmount || 0, o.discountAmount || 0, o.finalAmount || 0,
      o.couponName || '', o.couponDiscount || 0, o.payMethod || '现金', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/sales-orders/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM sales_orders WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== PURCHASE ORDERS ====================

app.get('/api/purchase-orders', (req, res) => {
  let orders = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').all();
  const { page, pageSize, search } = req.query;
  if (search) {
    const s = `%${search}%`;
    orders = db.prepare('SELECT * FROM purchase_orders WHERE order_no LIKE ? OR supplier_name LIKE ? ORDER BY id DESC').all(s, s);
  }
  orders = orders.map(o => {
    try { o.items = JSON.parse(o.items || '[]'); } catch (e) { o.items = []; }
    return o;
  });
  const result = paginate(orders, page, pageSize);
  res.json(ok(result));
});

app.post('/api/purchase-orders', authMiddleware, (req, res) => {
  const o = req.body;
  const orderNo = 'PO' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
  db.prepare(`INSERT INTO purchase_orders (order_no, supplier_id, supplier_name, items, total_amount, status, order_date, operator, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(orderNo, o.supplierId, o.supplierName || '', JSON.stringify(o.items || []), o.totalAmount || 0,
      o.status || '待审核', o.orderDate || new Date().toISOString().slice(0, 10), req.user.name, o.note || '');
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `创建采购订单: ${orderNo}`);
  res.json(okMsg('创建成功'));
});

app.put('/api/purchase-orders/:id', authMiddleware, (req, res) => {
  const o = req.body;
  db.prepare('UPDATE purchase_orders SET supplier_id=?, supplier_name=?, items=?, total_amount=?, status=?, note=? WHERE id=?')
    .run(o.supplierId, o.supplierName || '', JSON.stringify(o.items || []), o.totalAmount || 0, o.status || '待审核', o.note || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/purchase-orders/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== INVENTORY RECORDS ====================

app.get('/api/inventory-records', (req, res) => {
  let records = db.prepare('SELECT * FROM inventory_records ORDER BY id DESC').all();
  const { page, pageSize, productId, type } = req.query;
  if (productId) records = db.prepare('SELECT * FROM inventory_records WHERE product_id = ? ORDER BY id DESC').all(productId);
  if (type) records = db.prepare('SELECT * FROM inventory_records WHERE type = ? ORDER BY id DESC').all(type);
  const result = paginate(records, page, pageSize);
  res.json(ok(result));
});

app.post('/api/inventory-records', authMiddleware, (req, res) => {
  const r = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(r.productId);
  if (!product) return res.json(err('商品不存在'));
  const beforeStock = product.stock;
  let afterStock = beforeStock;
  if (r.type === '入库' || r.type === '上架') {
    afterStock = beforeStock + (r.qty || 0);
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(r.qty || 0, r.productId);
  } else if (r.type === '出库' || r.type === '核销' || r.type === '下架') {
    afterStock = Math.max(0, beforeStock - (r.qty || 0));
    db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(r.qty || 0, r.productId);
  }
  db.prepare(`INSERT INTO inventory_records (product_id, product_name, type, qty, before_stock, after_stock, operator, note, time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
    .run(r.productId, product.name, r.type || '入库', r.qty || 0, beforeStock, afterStock, r.operator || req.user.name, r.note || '');
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `${r.type || '库存操作'}: ${product.name} x${r.qty || 0}`);
  res.json(okMsg('记录添加成功'));
});

// ==================== PROMOTIONS ====================

app.get('/api/promotions', (req, res) => {
  let promos = db.prepare('SELECT * FROM promotions ORDER BY id DESC').all();
  const { page, pageSize } = req.query;
  promos = promos.map(p => {
    try { p.product_ids = JSON.parse(p.product_ids || '[]'); } catch (e) { p.product_ids = []; }
    try { p.categories = JSON.parse(p.categories || '[]'); } catch (e) { p.categories = []; }
    try { p.rule_json = JSON.parse(p.rule_json || '{}'); } catch (e) { p.rule_json = {}; }
    return p;
  });
  const result = paginate(promos, page, pageSize);
  res.json(ok(result));
});

app.post('/api/promotions', authMiddleware, (req, res) => {
  const p = req.body;
  db.prepare(`INSERT INTO promotions (name, type, product_ids, categories, rule_json, start_date, end_date, status, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.type || '满减', JSON.stringify(p.productIds || []), JSON.stringify(p.categories || []),
      JSON.stringify(p.ruleJson || {}), p.startDate || '', p.endDate || '', p.status || '进行中', p.description || '');
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `新增促销: ${p.name}`);
  res.json(okMsg('添加成功'));
});

app.put('/api/promotions/:id', authMiddleware, (req, res) => {
  const p = req.body;
  db.prepare(`UPDATE promotions SET name=?, type=?, product_ids=?, categories=?, rule_json=?, start_date=?, end_date=?, status=?, description=? WHERE id=?`)
    .run(p.name, p.type || '满减', JSON.stringify(p.productIds || []), JSON.stringify(p.categories || []),
      JSON.stringify(p.ruleJson || {}), p.startDate || '', p.endDate || '', p.status || '进行中', p.description || '', req.params.id);
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `编辑促销: ${p.name}`);
  res.json(okMsg('修改成功'));
});

app.delete('/api/promotions/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM promotions WHERE id = ?').run(req.params.id);
  syncAffectedTablesToDataStore();
  res.json(okMsg('删除成功'));
});

// ==================== INVENTORY ALERT SETTINGS ====================

app.get('/api/inventory-alert-settings', (req, res) => {
  const list = db.prepare('SELECT * FROM inventory_alert_settings').all();
  res.json(ok(list));
});

app.post('/api/inventory-alert-settings', authMiddleware, (req, res) => {
  const s = req.body;
  db.prepare('INSERT INTO inventory_alert_settings (product_category, min_stock, max_stock, expiry_days, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(s.productCategory || '全部', s.minStock || 50, s.maxStock || 2000, s.expiryDays || 30, s.enabled ? 1 : 0);
  res.json(okMsg('添加成功'));
});

app.put('/api/inventory-alert-settings/:id', authMiddleware, (req, res) => {
  const s = req.body;
  db.prepare('UPDATE inventory_alert_settings SET product_category=?, min_stock=?, max_stock=?, expiry_days=?, enabled=? WHERE id=?')
    .run(s.productCategory, s.minStock || 50, s.maxStock || 2000, s.expiryDays || 30, s.enabled ? 1 : 0, req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/inventory-alert-settings/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM inventory_alert_settings WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== INVENTORY CHECK ====================

app.get('/api/inventory-check-tasks', (req, res) => {
  const list = db.prepare('SELECT * FROM inventory_check_tasks ORDER BY id DESC').all();
  res.json(ok(list));
});

app.post('/api/inventory-check-tasks', authMiddleware, (req, res) => {
  const t = req.body;
  db.prepare('INSERT INTO inventory_check_tasks (task_no, name, warehouse_zone, status, checker, check_date) VALUES (?, ?, ?, ?, ?, ?)')
    .run(t.taskNo || ('PD' + Date.now()), t.name, t.warehouseZone || '', t.status || '待盘点', t.checker || req.user.name, t.checkDate || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/inventory-check-tasks/:id', authMiddleware, (req, res) => {
  const t = req.body;
  db.prepare('UPDATE inventory_check_tasks SET name=?, warehouse_zone=?, status=?, checker=?, check_date=? WHERE id=?')
    .run(t.name, t.warehouseZone || '', t.status || '待盘点', t.checker, t.checkDate || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/inventory-check-tasks/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM inventory_check_tasks WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

app.get('/api/inventory-check-items', (req, res) => {
  let items = db.prepare('SELECT * FROM inventory_check_items ORDER BY id').all();
  const { taskId } = req.query;
  if (taskId) items = db.prepare('SELECT * FROM inventory_check_items WHERE task_id = ? ORDER BY id').all(taskId);
  res.json(ok(items));
});

app.post('/api/inventory-check-items', authMiddleware, (req, res) => {
  const i = req.body;
  db.prepare('INSERT INTO inventory_check_items (task_id, product_id, product_name, system_stock, actual_stock, diff, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(i.taskId, i.productId, i.productName, i.systemStock || 0, i.actualStock || 0, (i.actualStock || 0) - (i.systemStock || 0), i.note || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/inventory-check-items/:id', authMiddleware, (req, res) => {
  const i = req.body;
  db.prepare('UPDATE inventory_check_items SET actual_stock=?, diff=?, note=? WHERE id=?')
    .run(i.actualStock || 0, (i.actualStock || 0) - (i.systemStock || 0), i.note || '', req.params.id);
  res.json(okMsg('修改成功'));
});

// ==================== WAREHOUSE ZONES ====================

app.get('/api/warehouse-zones', (req, res) => {
  const list = db.prepare('SELECT * FROM warehouse_zones ORDER BY id').all();
  res.json(ok(list));
});

app.post('/api/warehouse-zones', authMiddleware, (req, res) => {
  const z = req.body;
  db.prepare('INSERT INTO warehouse_zones (name, location, capacity, current, manager, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(z.name, z.location || '', z.capacity || 0, z.current || 0, z.manager || '', z.status || '使用中');
  res.json(okMsg('添加成功'));
});

app.put('/api/warehouse-zones/:id', authMiddleware, (req, res) => {
  const z = req.body;
  db.prepare('UPDATE warehouse_zones SET name=?, location=?, capacity=?, current=?, manager=?, status=? WHERE id=?')
    .run(z.name, z.location || '', z.capacity || 0, z.current || 0, z.manager || '', z.status || '使用中', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/warehouse-zones/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM warehouse_zones WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== FINANCE ====================

app.get('/api/finance-ledger', (req, res) => {
  let records = db.prepare('SELECT * FROM finance_ledger ORDER BY date DESC, id DESC').all();
  const { page, pageSize } = req.query;
  const result = paginate(records, page, pageSize);
  res.json(ok(result));
});

app.post('/api/finance-ledger', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('INSERT INTO finance_ledger (date, type, category, amount, account, summary, voucher_no) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.date || new Date().toISOString().slice(0, 10), r.type, r.category, r.amount || 0, r.account, r.summary || '', r.voucherNo || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/finance-ledger/:id', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('UPDATE finance_ledger SET date=?, type=?, category=?, amount=?, account=?, summary=?, voucher_no=? WHERE id=?')
    .run(r.date, r.type, r.category, r.amount || 0, r.account, r.summary || '', r.voucherNo || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/finance-ledger/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM finance_ledger WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

app.get('/api/finance-budget', (req, res) => {
  let budgets = db.prepare('SELECT * FROM finance_budget ORDER BY year DESC, month DESC').all();
  const { year, month } = req.query;
  if (year && month) budgets = db.prepare('SELECT * FROM finance_budget WHERE year = ? AND month = ?').all(year, month);
  res.json(ok(budgets));
});

app.post('/api/finance-budget', authMiddleware, (req, res) => {
  const b = req.body;
  db.prepare('INSERT INTO finance_budget (year, month, category, budget_amount, actual_amount, department) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.year, b.month, b.category, b.budgetAmount || 0, b.actualAmount || 0, b.department || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/finance-budget/:id', authMiddleware, (req, res) => {
  const b = req.body;
  db.prepare('UPDATE finance_budget SET year=?, month=?, category=?, budget_amount=?, actual_amount=?, department=? WHERE id=?')
    .run(b.year, b.month, b.category, b.budgetAmount || 0, b.actualAmount || 0, b.department || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/finance-budget/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM finance_budget WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

app.get('/api/finance-tax', (req, res) => {
  const list = db.prepare('SELECT * FROM finance_tax ORDER BY id DESC').all();
  res.json(ok(list));
});

app.post('/api/finance-tax', authMiddleware, (req, res) => {
  const t = req.body;
  db.prepare('INSERT INTO finance_tax (tax_name, tax_rate, taxable_amount, tax_amount, period, status, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t.taxName, t.taxRate || 0, t.taxableAmount || 0, t.taxAmount || 0, t.period || '', t.status || '待申报', t.dueDate || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/finance-tax/:id', authMiddleware, (req, res) => {
  const t = req.body;
  db.prepare('UPDATE finance_tax SET tax_name=?, tax_rate=?, taxable_amount=?, tax_amount=?, period=?, status=?, due_date=? WHERE id=?')
    .run(t.taxName, t.taxRate || 0, t.taxableAmount || 0, t.taxAmount || 0, t.period || '', t.status || '待申报', t.dueDate || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/finance-tax/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM finance_tax WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== SYSTEM MANAGEMENT ====================

// Users
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, status, created_at FROM users ORDER BY id').all();
  res.json(ok(users));
});

app.post('/api/users', authMiddleware, (req, res) => {
  const u = req.body;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
  if (existing) return res.json(err('用户名已存在'));
  const hash = bcrypt.hashSync(u.password || '123456', 10);
  db.prepare('INSERT INTO users (username, password, name, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(u.username, hash, u.name, u.role || 'cashier', u.status || '启用');
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `新增用户: ${u.username}`);
  res.json(okMsg('添加成功'));
});

app.put('/api/users/:id', authMiddleware, (req, res) => {
  const u = req.body;
  if (u.password) {
    const hash = bcrypt.hashSync(u.password, 10);
    db.prepare('UPDATE users SET username=?, name=?, role=?, status=?, password=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(u.username, u.name, u.role || 'cashier', u.status || '启用', hash, req.params.id);
  } else {
    db.prepare('UPDATE users SET username=?, name=?, role=?, status=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(u.username, u.name, u.role || 'cashier', u.status || '启用', req.params.id);
  }
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `编辑用户: ${u.username}`);
  res.json(okMsg('修改成功'));
});

app.delete('/api/users/:id', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json(err('用户不存在'));
  if (user.username === 'admin') return res.json(err('不能删除超级管理员'));
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
    .run(req.user.name, `删除用户: ${user.username}`);
  res.json(okMsg('删除成功'));
});

// System Roles
app.get('/api/system-roles', (req, res) => {
  const list = db.prepare('SELECT * FROM system_roles ORDER BY id').all();
  res.json(ok(list));
});

app.post('/api/system-roles', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('INSERT INTO system_roles (name, code, permissions, user_count, status, create_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.name, r.code || ('ROLE_' + Date.now().toString(36)), r.permissions || '', r.userCount || 0, r.status || '启用', r.createDate || new Date().toISOString().slice(0, 10), r.description || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/system-roles/:id', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('UPDATE system_roles SET name=?, code=?, permissions=?, user_count=?, status=?, description=? WHERE id=?')
    .run(r.name, r.code, r.permissions || '', r.userCount || 0, r.status || '启用', r.description || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/system-roles/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM system_roles WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// System Menus
app.get('/api/system-menus', (req, res) => {
  const list = db.prepare('SELECT * FROM system_menus ORDER BY sort, id').all();
  res.json(ok(list));
});

app.post('/api/system-menus', authMiddleware, (req, res) => {
  const m = req.body;
  db.prepare('INSERT INTO system_menus (name, code, type, parent, sort, icon, visible, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.name, m.code || '', m.type || '页面', m.parent || '无', m.sort || 0, m.icon || '', m.visible !== false ? 1 : 0, m.status || '启用');
  res.json(okMsg('添加成功'));
});

app.put('/api/system-menus/:id', authMiddleware, (req, res) => {
  const m = req.body;
  db.prepare('UPDATE system_menus SET name=?, code=?, type=?, parent=?, sort=?, icon=?, visible=?, status=? WHERE id=?')
    .run(m.name, m.code || '', m.type || '页面', m.parent || '无', m.sort || 0, m.icon || '', m.visible !== false ? 1 : 0, m.status || '启用', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/system-menus/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM system_menus WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// Dictionary Items
app.get('/api/dict-items', (req, res) => {
  let items = db.prepare('SELECT * FROM dict_items ORDER BY sort').all();
  const { typeName } = req.query;
  if (typeName) items = db.prepare('SELECT * FROM dict_items WHERE type_name = ? ORDER BY sort').all(typeName);
  res.json(ok(items));
});

app.post('/api/dict-items', authMiddleware, (req, res) => {
  const d = req.body;
  db.prepare('INSERT INTO dict_items (type_name, dict_label, dict_value, sort, status, description) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.typeName, d.dictLabel, d.dictValue, d.sort || 0, d.status || '启用', d.description || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/dict-items/:id', authMiddleware, (req, res) => {
  const d = req.body;
  db.prepare('UPDATE dict_items SET type_name=?, dict_label=?, dict_value=?, sort=?, status=?, description=? WHERE id=?')
    .run(d.typeName, d.dictLabel, d.dictValue, d.sort || 0, d.status || '启用', d.description || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/dict-items/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM dict_items WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// System Params
app.get('/api/system-params', (req, res) => {
  const list = db.prepare('SELECT * FROM system_params ORDER BY id').all();
  res.json(ok(list));
});

app.post('/api/system-params', authMiddleware, (req, res) => {
  const p = req.body;
  db.prepare('INSERT INTO system_params (name, code, value, description) VALUES (?, ?, ?, ?)')
    .run(p.name, p.code, p.value || '', p.description || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/system-params/:id', authMiddleware, (req, res) => {
  const p = req.body;
  db.prepare('UPDATE system_params SET name=?, code=?, value=?, description=? WHERE id=?')
    .run(p.name, p.code, p.value || '', p.description || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/system-params/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM system_params WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// Notices
app.get('/api/notices', (req, res) => {
  const list = db.prepare('SELECT * FROM notices ORDER BY id DESC').all();
  res.json(ok(list));
});

app.post('/api/notices', authMiddleware, (req, res) => {
  const n = req.body;
  db.prepare('INSERT INTO notices (title, content, type, publisher, publish_date, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(n.title, n.content || '', n.type || '系统通知', n.publisher || req.user.name, n.publishDate || new Date().toISOString().slice(0, 10), n.status || '已发布', n.priority || '中');
  res.json(okMsg('发布成功'));
});

app.put('/api/notices/:id', authMiddleware, (req, res) => {
  const n = req.body;
  db.prepare('UPDATE notices SET title=?, content=?, type=?, publisher=?, publish_date=?, status=?, priority=? WHERE id=?')
    .run(n.title, n.content || '', n.type || '系统通知', n.publisher || '', n.publishDate || '', n.status || '已发布', n.priority || '中', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/notices/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// Monitor Configs
app.get('/api/monitor-configs', (req, res) => {
  const list = db.prepare('SELECT * FROM monitor_configs ORDER BY id').all();
  res.json(ok(list));
});

app.post('/api/monitor-configs', authMiddleware, (req, res) => {
  const m = req.body;
  db.prepare('INSERT INTO monitor_configs (name, target, check_interval, status, last_check_time, alert_threshold, enabled, current_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.name, m.target, m.checkInterval || 60, m.status || '正常', m.lastCheckTime || '', m.alertThreshold || 80, m.enabled ? 1 : 0, m.currentValue || '');
  res.json(okMsg('添加成功'));
});

app.put('/api/monitor-configs/:id', authMiddleware, (req, res) => {
  const m = req.body;
  db.prepare('UPDATE monitor_configs SET name=?, target=?, check_interval=?, status=?, last_check_time=?, alert_threshold=?, enabled=?, current_value=? WHERE id=?')
    .run(m.name, m.target, m.checkInterval || 60, m.status || '正常', m.lastCheckTime || '', m.alertThreshold || 80, m.enabled ? 1 : 0, m.currentValue || '', req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/monitor-configs/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM monitor_configs WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// Login Logs
app.get('/api/login-logs', (req, res) => {
  let logs = db.prepare('SELECT * FROM login_logs ORDER BY id DESC').all();
  const { page, pageSize } = req.query;
  const result = paginate(logs, page, pageSize);
  res.json(ok(result));
});

// System Logs (operation logs)
app.get('/api/system-logs', (req, res) => {
  let logs = db.prepare('SELECT * FROM system_logs ORDER BY id DESC').all();
  const { page, pageSize } = req.query;
  const result = paginate(logs, page, pageSize);
  res.json(ok(result));
});

// Maintenance Records
app.get('/api/maintenance-records', (req, res) => {
  const list = db.prepare('SELECT * FROM maintenance_records ORDER BY id DESC').all();
  res.json(ok(list));
});

app.post('/api/maintenance-records', authMiddleware, (req, res) => {
  const m = req.body;
  db.prepare('INSERT INTO maintenance_records (version, type, content, operator, plan_date, execute_date, duration, status, result, rollback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.version, m.type, m.content || '', m.operator || req.user.name, m.planDate || '', m.executeDate || '', m.duration || '',
      m.status || '计划中', m.result || '', m.rollback ? 1 : 0);
  res.json(okMsg('添加成功'));
});

app.put('/api/maintenance-records/:id', authMiddleware, (req, res) => {
  const m = req.body;
  db.prepare('UPDATE maintenance_records SET version=?, type=?, content=?, operator=?, plan_date=?, execute_date=?, duration=?, status=?, result=?, rollback=? WHERE id=?')
    .run(m.version, m.type, m.content || '', m.operator || '', m.planDate || '', m.executeDate || '', m.duration || '',
      m.status || '计划中', m.result || '', m.rollback ? 1 : 0, req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/maintenance-records/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM maintenance_records WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// Exchange Rewards
app.get('/api/exchange-rewards', (req, res) => {
  const list = db.prepare('SELECT * FROM exchange_rewards ORDER BY points').all();
  res.json(ok(list));
});

app.post('/api/exchange-rewards', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('INSERT INTO exchange_rewards (name, points, type, enabled) VALUES (?, ?, ?, ?)')
    .run(r.name, r.points || 100, r.type || 'coupon', r.enabled !== false ? 1 : 0);
  res.json(okMsg('添加成功'));
});

app.put('/api/exchange-rewards/:id', authMiddleware, (req, res) => {
  const r = req.body;
  db.prepare('UPDATE exchange_rewards SET name=?, points=?, type=?, enabled=? WHERE id=?')
    .run(r.name, r.points || 100, r.type || 'coupon', r.enabled !== false ? 1 : 0, req.params.id);
  res.json(okMsg('修改成功'));
});

app.delete('/api/exchange-rewards/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM exchange_rewards WHERE id = ?').run(req.params.id);
  res.json(okMsg('删除成功'));
});

// ==================== STATS / DASHBOARD ====================

app.get('/api/stats/dashboard', (req, res) => {
  try {
    const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
    const todaySales = db.prepare("SELECT COALESCE(SUM(final_amount), 0) as total FROM sales_orders WHERE date(order_date) = date('now','localtime')").get().total;
    const memberCount = db.prepare('SELECT COUNT(*) as count FROM members').get().count;
    const lowStockCount = db.prepare('SELECT COUNT(*) as count FROM products WHERE stock < 50 AND status = ?').get('上架').count;
    const todayOrders = db.prepare("SELECT COUNT(*) as count FROM sales_orders WHERE date(order_date) = date('now','localtime')").get().count;

    // Top selling products
    const topProducts = db.prepare('SELECT id, name, category, sales, retail_price FROM products ORDER BY sales DESC LIMIT 10').all();

    // Sales trend (last 7 days)
    const salesTrend = [];
    for (let i = 6; i >= 0; i--) {
      const day = db.prepare("SELECT COALESCE(SUM(final_amount), 0) as total FROM sales_orders WHERE date(order_date) = date('now','localtime', ?)").get(`-${i} days`).total;
      const d = new Date();
      d.setDate(d.getDate() - i);
      salesTrend.push({ date: d.toISOString().slice(0, 10), amount: day });
    }

    // Category distribution
    const categoryDist = db.prepare('SELECT category, COUNT(*) as count, SUM(stock) as total_stock FROM products GROUP BY category').all();

    res.json(ok({
      productCount, todaySales, memberCount, lowStockCount, todayOrders,
      topProducts, salesTrend, categoryDist
    }));
  } catch (e) {
    res.json(err(e.message));
  }
});

app.get('/api/stats/sales', (req, res) => {
  try {
    const totalRevenue = db.prepare('SELECT COALESCE(SUM(final_amount), 0) as total FROM sales_orders').get().total;
    const todayRevenue = db.prepare("SELECT COALESCE(SUM(final_amount), 0) as total FROM sales_orders WHERE date(order_date) = date('now','localtime')").get().total;
    const orderCount = db.prepare('SELECT COUNT(*) as count FROM sales_orders').get().count;

    // Monthly sales
    const monthlySales = db.prepare("SELECT strftime('%Y-%m', order_date) as month, SUM(final_amount) as amount, COUNT(*) as orders FROM sales_orders GROUP BY month ORDER BY month DESC LIMIT 12").all();

    // Payment method breakdown
    const payMethods = db.prepare('SELECT pay_method, COUNT(*) as count, SUM(final_amount) as total FROM sales_orders GROUP BY pay_method').all();

    res.json(ok({ totalRevenue, todayRevenue, orderCount, monthlySales, payMethods }));
  } catch (e) {
    res.json(err(e.message));
  }
});

// ==================== EXPORT ALL DATA ====================

// 批量同步：前端推送完整表数据到服务器（JSON直存，无字段映射问题）
// 允许同步的数据表（前端localStorage的key名，camelCase）
const ALLOWED_SYNC_KEYS = new Set([
  'products', 'categories', 'members', 'memberLevels', 'memberPointsRecords',
  'suppliers', 'supplierContracts', 'supplierEvaluations',
  'employees', 'employeePositions', 'departments',
  'schedules', 'attendances', 'salaries',
  'salesOrders', 'purchaseOrders', 'inventoryRecords',
  'categories',
  'promotions', 'inventoryAlertSettings', 'inventoryCheckTasks', 'inventoryCheckItems',
  'warehouseZones', 'financeLedger', 'financeBudget', 'financeTax',
  'systemRoles', 'systemMenus', 'dictItems', 'systemParams', 'notices', 'monitorConfigs',
  'loginLogs', 'systemLogs', 'maintenanceRecords', 'exchangeRewards'
]);

app.post('/api/sync/:key', authMiddleware, (req, res) => {
  try {
    const storeKey = req.params.key;
    if (!ALLOWED_SYNC_KEYS.has(storeKey)) return res.json(err('非法数据表: ' + storeKey));
    const rows = req.body.data;
    if (!Array.isArray(rows)) return res.json(err('数据格式错误，需为数组'));

    // 保护：客户端传入空数组时，若服务端已有非空数据则拒绝覆盖
    if (rows.length === 0) {
      const existing = db.prepare('SELECT data FROM data_store WHERE key = ?').get(storeKey);
      if (existing && existing.data) {
        try {
          const existingRows = JSON.parse(existing.data);
          if (Array.isArray(existingRows) && existingRows.length > 0) {
            return res.json(okMsg('跳过空数据同步，保留服务端现有数据'));
          }
        } catch(e) {}
      }
    }

    // ID-based merge: client data is the source of truth (deletions are honored)
    // Client records as base, then add server-only records that client doesn't have
    const existing = db.prepare('SELECT data FROM data_store WHERE key = ?').get(storeKey);
    let merged = rows;
    if (existing && existing.data) {
      try {
        const existingRows = JSON.parse(existing.data);
        if (Array.isArray(existingRows) && existingRows.length > 0 && rows.length > 0
            && typeof rows[0] === 'object' && rows[0] !== null && 'id' in rows[0]
            && typeof existingRows[0] === 'object' && existingRows[0] !== null && 'id' in existingRows[0]) {
          const mergedMap = new Map(rows.map(r => [r.id, r]));
          for (const row of existingRows) {
            if (!mergedMap.has(row.id)) {
              mergedMap.set(row.id, row); // retain server-only records from other clients
            }
          }
          merged = Array.from(mergedMap.values());
          merged.sort((a, b) => (b.id || 0) - (a.id || 0));
        }
      } catch(e) { /* merge failed, use client data as-is */ }
    }

    // Deduplicate salaries by (employee_id, salary_month)
    if (storeKey === 'salaries' && merged.length > 0) {
      const seen = new Map();
      const deduped = [];
      merged.forEach(s => {
        const empId = s.employee_id || s.employeeId || '';
        const month = s.salary_month || s.salaryMonth || '';
        const uk = empId + '||' + month;
        const existing = seen.get(uk);
        if (!existing) {
          seen.set(uk, s);
          deduped.push(s);
        } else {
          const sTime = s.created_at || s.createdAt || '';
          const eTime = existing.created_at || existing.createdAt || '';
          if (sTime > eTime) {
            const idx = deduped.indexOf(existing);
            if (idx !== -1) deduped[idx] = s;
            seen.set(uk, s);
          }
        }
      });
      merged = deduped;
    }

    db.prepare('INSERT OR REPLACE INTO data_store (key, data) VALUES (?, ?)')
      .run(storeKey, JSON.stringify(merged));

    // 同步到对应的 SQL 表，防止 syncAffectedTablesToDataStore 用空表覆盖 data_store
    try { _syncToSqlTable(storeKey, merged); } catch(e) { console.warn('SQL表同步失败:', storeKey, e.message); }

    db.prepare(`INSERT INTO system_logs (time, user, action) VALUES (datetime('now','localtime'), ?, ?)`)
      .run(req.user.name, `同步数据: ${storeKey} (${rows.length}条)`);

    res.json(okMsg('同步成功'));
  } catch (e) {
    console.error('Sync error:', e);
    res.json(err(e.message));
  }
});

app.get('/api/export/all', (req, res) => {
  try {
    // 前端localStorage使用的camelCase键名
    const frontendKeys = [
      'products', 'categories', 'members', 'memberLevels', 'memberPointsRecords',
      'suppliers', 'supplierContracts', 'supplierEvaluations',
      'employees', 'employeePositions', 'departments',
      'schedules', 'attendances', 'salaries',
      'salesOrders', 'purchaseOrders', 'inventoryRecords',
      'promotions', 'inventoryAlertSettings', 'inventoryCheckTasks', 'inventoryCheckItems',
      'warehouseZones', 'financeLedger', 'financeBudget', 'financeTax',
      'systemRoles', 'systemMenus', 'dictItems', 'systemParams', 'notices', 'monitorConfigs',
      'loginLogs', 'systemLogs', 'maintenanceRecords', 'exchangeRewards'
    ];

    const allData = {};
    for (const key of frontendKeys) {
      try {
        // 先从JSON存储读取（前端同步的数据）
        const row = db.prepare('SELECT data FROM data_store WHERE key = ?').get(key);
        if (row && row.data) {
          try {
            allData[key] = JSON.parse(row.data);
          } catch(e) {
            allData[key] = [];
          }
        } else {
          allData[key] = [];
        }
      } catch (e) {
        allData[key] = [];
      }
    }
    res.json(ok(allData));
  } catch (e) {
    res.json(err(e.message));
  }
});

// ==================== UPLOAD ====================

app.post('/api/upload/product-image', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.json(err('请选择图片文件'));
  const url = '/uploads/' + req.file.filename;
  res.json(ok({ url }));
});

// ==================== POSITION MANAGEMENT (legacy positions table) ====================

app.get('/api/positions', (req, res) => {
  const list = db.prepare('SELECT * FROM employee_positions ORDER BY id').all();
  res.json(ok(list));
});

// ==================== START SERVER ====================

// Seed default data if empty
function seedDefaultData() {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    console.log('Seeding default data...');
    const hash = bcrypt.hashSync('123456', 10);

    // Default users
    const users = [
      { username: 'admin', name: '系统管理员', role: 'system_admin' },
      { username: 'ops', name: '运维人员', role: 'ops' },
      { username: 'hr', name: '人事管理员', role: 'hr' },
      { username: 'product', name: '商品管理员', role: 'product_admin' },
      { username: 'member', name: '会员管理员', role: 'member_admin' },
      { username: 'cashier', name: '收银员', role: 'cashier' },
      { username: 'purchase', name: '采购员', role: 'purchaser' },
      { username: 'warehouse', name: '仓管员', role: 'warehouse' },
      { username: 'finance', name: '财务', role: 'finance' }
    ];
    const userStmt = db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)');
    for (const u of users) {
      userStmt.run(u.username, hash, u.name, u.role);
    }

    const getToday = (d = 0) => { const t = new Date(); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };

    // Default categories
    const categories = ['蔬菜水果', '饼干糕点', '肉干零食', '糖果', '酒水饮料', '粮油调味', '乳品烘焙', '日用百货', '休闲食品', '冷冻食品', '调味品', '个人护理'];
    const catStmt = db.prepare('INSERT OR IGNORE INTO categories (name, sort) VALUES (?, ?)');
    categories.forEach((c, i) => catStmt.run(c, i + 1));

    // Default products
    const products = [
      { code: 'SP20240101', name: '松软蛋糕', category: '饼干糕点', supplier: '美味园', purchasePrice: 12, retailPrice: 23, stock: 1000, unit: '盒', status: '上架', sales: 120, produceDate: getToday(-30), expiryDate: getToday(90), description: '松软绵密' },
      { code: 'SP20240102', name: '鲜奶棒', category: '肉干零食', supplier: '鲜源食品', purchasePrice: 4.5, retailPrice: 7.9, stock: 1000, unit: '根', status: '上架', sales: 58, produceDate: getToday(-20), expiryDate: getToday(60), description: '奶香浓郁' },
      { code: 'SP20240103', name: '小饼干', category: '饼干糕点', supplier: '麦香坊', purchasePrice: 9, retailPrice: 16.9, stock: 1000, unit: '克', status: '上架', sales: 148, produceDate: getToday(-25), expiryDate: getToday(120), description: '酥脆可口' },
      { code: 'SP20240104', name: '巧克力', category: '糖果', supplier: '甜蜜工坊', purchasePrice: 38, retailPrice: 62, stock: 999, unit: '粒', status: '上架', sales: 399, produceDate: getToday(-15), expiryDate: getToday(180), description: '香脆夹心' },
      { code: 'SP20240105', name: '生菜', category: '蔬菜水果', supplier: '绿野农场', purchasePrice: 2.8, retailPrice: 5.5, stock: 320, unit: '份', status: '上架', sales: 212, produceDate: getToday(-5), expiryDate: getToday(5), description: '新鲜脆嫩' },
      { code: 'SP20240106', name: '脐橙', category: '蔬菜水果', supplier: '果源达', purchasePrice: 7.5, retailPrice: 12.9, stock: 560, unit: '斤', status: '上架', sales: 388, produceDate: getToday(-8), expiryDate: getToday(12), description: '汁水丰富' },
      { code: 'SP20240107', name: '吐司', category: '乳品烘焙', supplier: '麦香园', purchasePrice: 7.2, retailPrice: 12.5, stock: 450, unit: '袋', status: '上架', sales: 275, produceDate: getToday(-3), expiryDate: getToday(8), description: '全麦健康' },
      { code: 'SP20240108', name: '牛奶', category: '乳品烘焙', supplier: '伊利牧场', purchasePrice: 30, retailPrice: 39.9, stock: 200, unit: '箱', status: '上架', sales: 590, produceDate: getToday(-12), expiryDate: getToday(15), description: '高钙纯牛奶' },
      { code: 'SP20240109', name: '薯片', category: '休闲食品', supplier: '乐事食品', purchasePrice: 18, retailPrice: 29.9, stock: 800, unit: '包', status: '上架', sales: 1024, produceDate: getToday(-40), expiryDate: getToday(100), description: '多种口味' },
      { code: 'SP20240110', name: '五常大米', category: '粮油调味', supplier: '北大荒', purchasePrice: 52, retailPrice: 68, stock: 300, unit: '袋', status: '上架', sales: 312, produceDate: getToday(-60), expiryDate: getToday(330), description: '稻花香2号' },
      { code: 'SP20240111', name: '苹果', category: '蔬菜水果', supplier: '源兴果业', purchasePrice: 5.5, retailPrice: 9.9, stock: 1200, unit: '斤', status: '上架', sales: 890, produceDate: getToday(-6), expiryDate: getToday(10), description: '红富士冰糖心' },
      { code: 'SP20240112', name: '香蕉', category: '蔬菜水果', supplier: '南方果园', purchasePrice: 3.8, retailPrice: 6.5, stock: 800, unit: '斤', status: '上架', sales: 1230, produceDate: getToday(-4), expiryDate: getToday(7), description: '香甜软糯' }
    ];
    const prodStmt = db.prepare(`INSERT INTO products (code, name, category, supplier, purchase_price, retail_price, stock, unit, status, sales, produce_date, expiry_date, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of products) {
      prodStmt.run(p.code, p.name, p.category, p.supplier, p.purchasePrice, p.retailPrice, p.stock, p.unit, p.status, p.sales, p.produceDate, p.expiryDate, p.description);
    }

    // Default members
    const members = [
      { cardNo: 'HY20240001', name: '张三', gender: '男', birthday: '1990-05-15', phone: '13800001001', email: 'zhangsan@email.com', address: '北京市朝阳区建国路88号', level: '黄金会员', points: 2580, joinDate: '2024-01-15', totalSpent: 25800, status: '正常', lastConsumeDate: '2024-05-20', source: '门店注册' },
      { cardNo: 'HY20240002', name: '李四', gender: '女', birthday: '1995-08-22', phone: '13800001002', email: 'lisi@email.com', address: '北京市海淀区中关村1号', level: '白银会员', points: 890, joinDate: '2024-03-20', totalSpent: 8900, status: '正常', lastConsumeDate: '2024-05-18', source: '小程序注册' },
      { cardNo: 'HY20230001', name: '王五', gender: '男', birthday: '1988-12-03', phone: '13800001003', email: 'wangwu@email.com', address: '北京市西城区金融街15号', level: '钻石会员', points: 5600, joinDate: '2023-06-10', totalSpent: 56000, status: '正常', lastConsumeDate: '2024-05-21', source: '门店注册' },
      { cardNo: 'HY20240003', name: '赵六', gender: '女', birthday: '1992-03-18', phone: '13800001004', email: 'zhaoliu@email.com', address: '北京市丰台区南三环16号', level: '普通会员', points: 120, joinDate: '2024-05-01', totalSpent: 1200, status: '冻结', lastConsumeDate: '2024-05-10', source: '活动推广' }
    ];
    const memStmt = db.prepare(`INSERT INTO members (card_no, name, gender, birthday, phone, email, address, level, points, join_date, total_spent, status, last_consume_date, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of members) {
      memStmt.run(m.cardNo, m.name, m.gender, m.birthday, m.phone, m.email, m.address, m.level, m.points, m.joinDate, m.totalSpent, m.status, m.lastConsumeDate, m.source);
    }

    // Default member levels
    const levels = [
      { name: '普通会员', minSpent: 0, discount: 100, pointsRate: 1, cardColor: '#9e9e9e', benefits: '消费1元积1分 | 新人专享优惠券 | 每周三会员特价' },
      { name: '白银会员', minSpent: 5000, discount: 97, pointsRate: 1.2, cardColor: '#c0c0c0', benefits: '9.7折优惠 | 1.2倍积分加速 | 每月8号会员日双倍积分 | 生日当月赠200积分' },
      { name: '黄金会员', minSpent: 20000, discount: 95, pointsRate: 1.5, cardColor: '#ffd700', benefits: '9.5折优惠 | 1.5倍积分加速 | 每月8号双倍积分 | 生日当月赠500积分 | 专属客服通道 | 新品优先体验' },
      { name: '钻石会员', minSpent: 50000, discount: 90, pointsRate: 2, cardColor: '#b9f2ff', benefits: '9折优惠 | 2倍积分加速 | 每月8号双倍积分 | 生日月赠1000积分+蛋糕券 | 专属客服经理 | 免费停车3小时 | 48小时无忧退换 | 企业团购优惠' }
    ];
    const lvStmt = db.prepare('INSERT INTO member_levels (name, min_spent, discount, points_rate, card_color, benefits) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of levels) lvStmt.run(l.name, l.minSpent, l.discount, l.pointsRate, l.cardColor, l.benefits);

    // Default suppliers
    const suppliers = [
      { code: 'GYS20240001', name: '美味园', contact: '张经理', phone: '13900001001', email: 'meiweiyuan@supplier.com', address: '北京市朝阳区食品工业园A区', products: '糕点类', level: 'A级', status: '合作中', cooperationDate: '2023-01-10', bankAccount: '6222021234567890', taxId: '91110108MA01XXXX1X', notes: '品质稳定，供货及时，长期合作伙伴', supplyCapacity: '月供5000件' },
      { code: 'GYS20240002', name: '绿野农场', contact: '李场长', phone: '13900001002', email: 'lvye@supplier.com', address: '河北省石家庄市新华区农业示范区', products: '蔬菜水果', level: 'A级', status: '合作中', cooperationDate: '2023-03-15', bankAccount: '6222021234567891', taxId: '91130108MA01XXXX2X', notes: '有机蔬菜基地，绿色认证', supplyCapacity: '月供10000斤' },
      { code: 'GYS20240003', name: '伊利牧场', contact: '王经理', phone: '13900001003', email: 'yili@supplier.com', address: '内蒙古呼和浩特市赛罕区乳业路58号', products: '乳制品', level: 'B级', status: '合作中', cooperationDate: '2023-06-20', bankAccount: '6222021234567892', taxId: '91150108MA01XXXX3X', notes: '大型乳企，品牌知名度高，但交货周期较长', supplyCapacity: '月供3000箱' },
      { code: 'GYS20240004', name: '麦香坊', contact: '陈主管', phone: '13900001005', email: 'maixiang@supplier.com', address: '上海市浦东新区食品加工区', products: '饼干糕点', level: 'C级', status: '暂停', cooperationDate: '2024-02-01', bankAccount: '6222021234567893', taxId: '91310108MA01XXXX4X', notes: '小型加工作坊，近期质量问题较多，暂停合作', supplyCapacity: '月供2000件' }
    ];
    const supStmt = db.prepare(`INSERT INTO suppliers (code, name, contact, phone, email, address, products, level, status, cooperation_date, bank_account, tax_id, notes, supply_capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of suppliers) supStmt.run(s.code, s.name, s.contact, s.phone, s.email, s.address, s.products, s.level, s.status, s.cooperationDate, s.bankAccount, s.taxId, s.notes, s.supplyCapacity);

    // Default employees
    const employees = [
      { name: '赵颖', code: 'EMP001', dept: '商品管理部', position: '商品管理员', phone: '13800002001', joinDate: '2024-01-01' },
      { name: '王亚菲', code: 'EMP002', dept: '会员服务部', position: '会员管理员', phone: '13800002002', joinDate: '2024-02-01' },
      { name: '郭佳慧', code: 'EMP003', dept: '技术运维部', position: '系统管理员', phone: '13800002003', joinDate: '2024-03-01' },
      { name: '孙丽华', code: 'EMP004', dept: '人力资源部', position: '人事管理员', phone: '13800002006', joinDate: '2024-04-01' }
    ];
    const empStmt = db.prepare('INSERT INTO employees (name, code, dept, position, phone, join_date) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of employees) empStmt.run(e.name, e.code, e.dept, e.position, e.phone, e.joinDate);

    // Default employee positions
    const positions = [
      { name: '收银员', category: '收银客服部', desc: '负责商品扫码收银、现金管理、顾客引导及会员卡办理' },
      { name: '理货员', category: '采购仓储部', desc: '负责商品上架陈列、货架整理、价签更新及商品保质期检查' },
      { name: '采购员', category: '采购仓储部', desc: '执行采购计划、跟进采购订单、协调供应商交货及质量验收' },
      { name: '仓管员', category: '采购仓储部', desc: '负责仓库日常管理、商品出入库登记、库存盘点及仓储环境维护' },
      { name: '财务', category: '行政财务部', desc: '负责日常记账、凭证审核、财务报表编制及往来账款核对' },
      { name: '店长', category: '管理部', desc: '全面负责超市日常运营管理，制定经营策略，监督各部门工作执行' }
    ];
    const posStmt = db.prepare('INSERT INTO employee_positions (name, category, description, employee_ids, employee_names) VALUES (?, ?, ?, ?, ?)');
    for (const p of positions) posStmt.run(p.name, p.category, p.desc, '[]', '[]');

    // Default departments
    const departments = [
      { name: '商品管理部', code: 'DEPT001', manager: '赵颖', phone: '13800002001', status: '正常', createDate: '2024-01-01', desc: '负责商品信息录入、分类、价格及促销管理' },
      { name: '会员服务部', code: 'DEPT002', manager: '王亚菲', phone: '13800002002', status: '正常', createDate: '2024-02-01', desc: '负责会员信息维护、等级及积分管理' },
      { name: '技术运维部', code: 'DEPT003', manager: '郭佳慧', phone: '13800002003', status: '正常', createDate: '2024-03-01', desc: '负责系统维护、数据备份及安全监控' },
      { name: '财务部', code: 'DEPT004', manager: '陈明', phone: '13800002004', status: '正常', createDate: '2024-01-15', desc: '负责财务核算、报表及预算管理' },
      { name: '仓储物流部', code: 'DEPT005', manager: '李强', phone: '13800002005', status: '正常', createDate: '2024-02-20', desc: '负责仓库管理、商品出入库及盘点' },
      { name: '人力资源部', code: 'DEPT006', manager: '孙丽华', phone: '13800002006', status: '正常', createDate: '2024-04-01', desc: '负责员工信息管理、招聘、排班、考勤及薪酬管理' }
    ];
    const deptStmt = db.prepare('INSERT INTO departments (name, code, manager, phone, status, create_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of departments) deptStmt.run(d.name, d.code, d.manager, d.phone, d.status, d.createDate, d.desc);

    // Default system roles
    const sysRoles = [
      { name: '系统管理员', code: 'ROLE_ADMIN', permissions: '全部权限', userCount: 1, status: '启用', createDate: '2024-01-01', desc: '拥有系统所有功能模块的管理权限，负责系统整体运维和配置' },
      { name: '运维人员', code: 'ROLE_OPS', permissions: '系统日志、数据备份、数据监控、角色管理、菜单管理、系统维护', userCount: 1, status: '启用', createDate: '2024-01-01', desc: '负责系统日常运维、日志审计、数据备份与恢复、系统监控' },
      { name: '商品管理员', code: 'ROLE_PRODUCT', permissions: '商品信息、分类管理、库存管理、价格管理、促销活动', userCount: 1, status: '启用', createDate: '2024-01-01', desc: '负责商品信息录入维护、分类、价格及促销活动管理' },
      { name: '会员管理员', code: 'ROLE_MEMBER', permissions: '会员信息、会员等级、积分管理', userCount: 1, status: '启用', createDate: '2024-02-01', desc: '负责会员信息维护、等级晋升及积分管理' },
      { name: '收银员', code: 'ROLE_CASHIER', permissions: '销售收银、销售订单、商品退货、会员积分', userCount: 1, status: '启用', createDate: '2024-01-01', desc: '负责前台收银、订单处理及退货操作' },
      { name: '人事管理员', code: 'ROLE_HR', permissions: '员工信息、排班管理、考勤管理、工资管理', userCount: 1, status: '启用', createDate: '2024-04-01', desc: '负责员工档案管理、排班、考勤统计及薪酬核算' }
    ];
    const roleStmt = db.prepare('INSERT INTO system_roles (name, code, permissions, user_count, status, create_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of sysRoles) roleStmt.run(r.name, r.code, r.permissions, r.userCount, r.status, r.createDate, r.desc);

    // Default warehouse zones
    const zones = [
      { name: 'A区-食品区', location: '一楼东侧', capacity: 5000, current: 3200, manager: '王库管', status: '使用中' },
      { name: 'B区-日用品区', location: '一楼西侧', capacity: 3000, current: 1800, manager: '李库管', status: '使用中' },
      { name: 'C区-冷链区', location: '负一层', capacity: 2000, current: 800, manager: '王库管', status: '使用中' }
    ];
    const zoneStmt = db.prepare('INSERT INTO warehouse_zones (name, location, capacity, current, manager, status) VALUES (?, ?, ?, ?, ?, ?)');
    for (const z of zones) zoneStmt.run(z.name, z.location, z.capacity, z.current, z.manager, z.status);

    // Default exchange rewards
    const rewards = [
      { name: '1元代金券', points: 100 },
      { name: '5元代金券', points: 500 },
      { name: '10元代金券', points: 1000 },
      { name: '20元购物券', points: 2000 },
      { name: '50元购物券', points: 5000 },
      { name: '100元大礼包', points: 10000 }
    ];
    const rewardStmt = db.prepare('INSERT INTO exchange_rewards (name, points) VALUES (?, ?)');
    for (const r of rewards) rewardStmt.run(r.name, r.points);

    // Default system params
    const params = [
      { name: '系统名称', code: 'sys.name', value: '超市管理系统', desc: '系统显示名称' },
      { name: '每页显示数量', code: 'sys.pageSize', value: '10', desc: '表格每页默认显示行数' },
      { name: '低库存预警阈值', code: 'sys.lowStockThreshold', value: '50', desc: '库存低于此值触发预警' },
      { name: '临期商品预警天数', code: 'sys.expiryWarningDays', value: '7', desc: '到期前多少天触发临期预警' }
    ];
    const paramStmt = db.prepare('INSERT INTO system_params (name, code, value, description) VALUES (?, ?, ?, ?)');
    for (const p of params) paramStmt.run(p.name, p.code, p.value, p.desc);

    // Default inventory alert settings
    const alertSettings = [
      { category: '全部', minStock: 50, maxStock: 2000, expiryDays: 30, enabled: 1 },
      { category: '蔬菜水果', minStock: 100, maxStock: 1500, expiryDays: 7, enabled: 1 },
      { category: '乳品烘焙', minStock: 80, maxStock: 1000, expiryDays: 10, enabled: 1 }
    ];
    const alertStmt = db.prepare('INSERT INTO inventory_alert_settings (product_category, min_stock, max_stock, expiry_days, enabled) VALUES (?, ?, ?, ?, ?)');
    for (const a of alertSettings) alertStmt.run(a.category, a.minStock, a.maxStock, a.expiryDays, a.enabled);

    // Default notices
    const notices = [
      { title: '系统升级通知', content: '系统将于本周六凌晨2:00-4:00进行例行维护升级，届时系统将暂停使用，请各部门提前做好工作安排。', type: '系统通知', publisher: '系统管理员', publishDate: getToday(-4), status: '已发布', priority: '高' },
      { title: '关于规范商品信息录入的通知', content: '为了提升商品管理质量，请各商品管理员在录入商品信息时，严格按照规范填写商品编码、分类、价格等信息。', type: '部门通知', publisher: '系统管理员', publishDate: getToday(-6), status: '已发布', priority: '中' }
    ];
    const noticeStmt = db.prepare('INSERT INTO notices (title, content, type, publisher, publish_date, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const n of notices) noticeStmt.run(n.title, n.content, n.type, n.publisher, n.publishDate, n.status, n.priority);

    // Default maintenance records
    const maintenances = [
      { version: 'V3.2.1', type: '安全更新', content: '修复SQL注入漏洞；更新用户密码加密算法；加强登录失败锁定机制', operator: '运维人员', planDate: getToday(-9), executeDate: getToday(-9) + ' 02:00', duration: '2小时', status: '已完成', result: '更新成功，系统运行正常', rollback: 0 },
      { version: 'V3.2.0', type: '功能更新', content: '新增商品批量导入功能；优化库存预警算法；新增数据监控看板', operator: '运维人员', planDate: getToday(-23), executeDate: getToday(-23) + ' 01:30', duration: '3小时', status: '已完成', result: '更新成功，新功能测试通过', rollback: 0 }
    ];
    const maintStmt = db.prepare('INSERT INTO maintenance_records (version, type, content, operator, plan_date, execute_date, duration, status, result, rollback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const m of maintenances) maintStmt.run(m.version, m.type, m.content, m.operator, m.planDate, m.executeDate, m.duration, m.status, m.result, m.rollback);

    console.log('Default data seeded successfully!');
  }
}

seedDefaultData();

// Migrate: rename old 青铜会员 to 普通会员 in SQL tables and data_store
try {
  db.prepare(`UPDATE member_levels SET name = '普通会员' WHERE name = '青铜会员'`).run();
  db.prepare(`UPDATE members SET level = '普通会员' WHERE level = '青铜会员'`).run();
  const row = db.prepare(`SELECT data FROM data_store WHERE key = 'memberLevels'`).get();
  if (row && row.data) {
    const levels = JSON.parse(row.data);
    let changed = false;
    levels.forEach(l => { if (l.name === '青铜会员') { l.name = '普通会员'; changed = true; } });
    if (changed) db.prepare(`UPDATE data_store SET data = ? WHERE key = 'memberLevels'`).run(JSON.stringify(levels));
  }
  const memRow = db.prepare(`SELECT data FROM data_store WHERE key = 'members'`).get();
  if (memRow && memRow.data) {
    const members = JSON.parse(memRow.data);
    let changed = false;
    members.forEach(m => { if (m.level === '青铜会员') { m.level = '普通会员'; changed = true; } });
    if (changed) db.prepare(`UPDATE data_store SET data = ? WHERE key = 'members'`).run(JSON.stringify(members));
  }
} catch(e) { /* migration may fail if tables don't exist yet */ }

app.listen(PORT, '0.0.0.0', () => {
  console.log(`超市管理系统后端已启动: http://localhost:${PORT}`);
  console.log(`默认账号: admin / 123456`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  db.close();
  process.exit(0);
});
