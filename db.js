const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'supermarket.db');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    -- JSON数据存储表（直接存前端原始数据，无字段映射问题）
    CREATE TABLE IF NOT EXISTS data_store (
      key TEXT PRIMARY KEY,
      data TEXT DEFAULT '[]'
    );

    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      status TEXT DEFAULT '启用',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 商品表
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      supplier TEXT,
      purchase_price REAL DEFAULT 0,
      retail_price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      unit TEXT DEFAULT '个',
      status TEXT DEFAULT '上架',
      sales INTEGER DEFAULT 0,
      produce_date TEXT,
      expiry_date TEXT,
      description TEXT,
      image_url TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 商品分类
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort INTEGER DEFAULT 0,
      status TEXT DEFAULT '启用',
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 会员
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_no TEXT UNIQUE,
      name TEXT NOT NULL,
      gender TEXT,
      birthday TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      level TEXT DEFAULT '普通会员',
      points INTEGER DEFAULT 0,
      join_date TEXT,
      total_spent REAL DEFAULT 0,
      status TEXT DEFAULT '正常',
      last_consume_date TEXT,
      source TEXT DEFAULT '门店注册',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 会员等级
    CREATE TABLE IF NOT EXISTS member_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      min_spent REAL DEFAULT 0,
      discount REAL DEFAULT 100,
      points_rate REAL DEFAULT 1,
      card_color TEXT DEFAULT '#9e9e9e',
      benefits TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 会员积分记录
    CREATE TABLE IF NOT EXISTS member_points_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      member_name TEXT,
      type TEXT,
      points INTEGER DEFAULT 0,
      balance INTEGER DEFAULT 0,
      time TEXT,
      operator TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 供应商
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name TEXT NOT NULL,
      contact TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      products TEXT,
      level TEXT DEFAULT 'B级',
      status TEXT DEFAULT '合作中',
      cooperation_date TEXT,
      bank_account TEXT,
      tax_id TEXT,
      notes TEXT,
      supply_capacity TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 供应商合同
    CREATE TABLE IF NOT EXISTS supplier_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      supplier_name TEXT,
      contract_no TEXT UNIQUE,
      sign_date TEXT,
      expiry_date TEXT,
      amount REAL DEFAULT 0,
      status TEXT DEFAULT '生效中',
      type TEXT DEFAULT '年度框架合同',
      payment_terms TEXT,
      scope TEXT,
      attachment TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 供应商评价
    CREATE TABLE IF NOT EXISTS supplier_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      supplier_name TEXT,
      rating INTEGER DEFAULT 3,
      quality INTEGER DEFAULT 3,
      delivery INTEGER DEFAULT 3,
      price INTEGER DEFAULT 3,
      service INTEGER DEFAULT 3,
      comment TEXT,
      evaluator TEXT,
      date TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 员工
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      dept TEXT,
      position TEXT,
      phone TEXT,
      join_date TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 员工岗位
    CREATE TABLE IF NOT EXISTS employee_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      employee_ids TEXT DEFAULT '[]',
      employee_names TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 部门
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      manager TEXT,
      phone TEXT,
      status TEXT DEFAULT '正常',
      create_date TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 排班
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      employee_name TEXT,
      date TEXT NOT NULL,
      shift TEXT DEFAULT '早班',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 考勤
    CREATE TABLE IF NOT EXISTS attendances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      employee_name TEXT,
      date TEXT NOT NULL,
      status TEXT DEFAULT '正常',
      check_in TEXT,
      check_out TEXT,
      late_minutes INTEGER DEFAULT 0,
      early_minutes INTEGER DEFAULT 0,
      overtime_minutes INTEGER DEFAULT 0,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 工资
    CREATE TABLE IF NOT EXISTS salaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      employee_name TEXT,
      year INTEGER,
      month INTEGER,
      base_salary REAL DEFAULT 0,
      overtime_pay REAL DEFAULT 0,
      bonus REAL DEFAULT 0,
      deduction REAL DEFAULT 0,
      total REAL DEFAULT 0,
      status TEXT DEFAULT '待发放',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 销售订单
    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE,
      member_id INTEGER,
      member_name TEXT,
      member_phone TEXT,
      items TEXT DEFAULT '[]',
      total_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      final_amount REAL DEFAULT 0,
      coupon_id INTEGER,
      coupon_name TEXT,
      coupon_discount REAL DEFAULT 0,
      pay_method TEXT DEFAULT '现金',
      operator TEXT,
      order_date TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 采购订单
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE,
      supplier_id INTEGER,
      supplier_name TEXT,
      items TEXT DEFAULT '[]',
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT '待审核',
      order_date TEXT,
      received_date TEXT,
      operator TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 库存记录
    CREATE TABLE IF NOT EXISTS inventory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      product_name TEXT,
      type TEXT,
      qty INTEGER DEFAULT 0,
      before_stock INTEGER DEFAULT 0,
      after_stock INTEGER DEFAULT 0,
      operator TEXT,
      note TEXT,
      time TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 促销活动
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT '满减',
      product_ids TEXT DEFAULT '[]',
      categories TEXT DEFAULT '[]',
      rule_json TEXT DEFAULT '{}',
      start_date TEXT,
      end_date TEXT,
      status TEXT DEFAULT '进行中',
      description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 库存预警设置
    CREATE TABLE IF NOT EXISTS inventory_alert_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_category TEXT DEFAULT '全部',
      min_stock INTEGER DEFAULT 50,
      max_stock INTEGER DEFAULT 2000,
      expiry_days INTEGER DEFAULT 30,
      enabled INTEGER DEFAULT 1
    );

    -- 盘点任务
    CREATE TABLE IF NOT EXISTS inventory_check_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_no TEXT UNIQUE,
      name TEXT,
      warehouse_zone TEXT,
      status TEXT DEFAULT '待盘点',
      checker TEXT,
      check_date TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 盘点明细
    CREATE TABLE IF NOT EXISTS inventory_check_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      product_id INTEGER,
      product_name TEXT,
      system_stock INTEGER DEFAULT 0,
      actual_stock INTEGER DEFAULT 0,
      diff INTEGER DEFAULT 0,
      note TEXT
    );

    -- 仓库区域
    CREATE TABLE IF NOT EXISTS warehouse_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      location TEXT,
      capacity INTEGER DEFAULT 0,
      current INTEGER DEFAULT 0,
      manager TEXT,
      status TEXT DEFAULT '使用中'
    );

    -- 资金流水
    CREATE TABLE IF NOT EXISTS finance_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      type TEXT,
      category TEXT,
      amount REAL DEFAULT 0,
      account TEXT,
      summary TEXT,
      voucher_no TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 预算
    CREATE TABLE IF NOT EXISTS finance_budget (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER,
      month INTEGER,
      category TEXT,
      budget_amount REAL DEFAULT 0,
      actual_amount REAL DEFAULT 0,
      department TEXT
    );

    -- 税务
    CREATE TABLE IF NOT EXISTS finance_tax (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tax_name TEXT,
      tax_rate REAL DEFAULT 0,
      taxable_amount REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      period TEXT,
      status TEXT DEFAULT '待申报',
      due_date TEXT
    );

    -- 系统角色
    CREATE TABLE IF NOT EXISTS system_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      permissions TEXT,
      user_count INTEGER DEFAULT 0,
      status TEXT DEFAULT '启用',
      create_date TEXT,
      description TEXT
    );

    -- 系统菜单
    CREATE TABLE IF NOT EXISTS system_menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT,
      type TEXT DEFAULT '页面',
      parent TEXT DEFAULT '无',
      sort INTEGER DEFAULT 0,
      icon TEXT,
      visible INTEGER DEFAULT 1,
      status TEXT DEFAULT '启用'
    );

    -- 字典
    CREATE TABLE IF NOT EXISTS dict_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_name TEXT,
      dict_label TEXT,
      dict_value TEXT,
      sort INTEGER DEFAULT 0,
      status TEXT DEFAULT '启用',
      description TEXT
    );

    -- 系统参数
    CREATE TABLE IF NOT EXISTS system_params (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      code TEXT UNIQUE,
      value TEXT,
      description TEXT
    );

    -- 通知公告
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT,
      type TEXT DEFAULT '系统通知',
      publisher TEXT,
      publish_date TEXT,
      status TEXT DEFAULT '已发布',
      priority TEXT DEFAULT '中'
    );

    -- 监控配置
    CREATE TABLE IF NOT EXISTS monitor_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      target TEXT,
      check_interval INTEGER DEFAULT 60,
      status TEXT DEFAULT '正常',
      last_check_time TEXT,
      alert_threshold INTEGER DEFAULT 80,
      enabled INTEGER DEFAULT 1,
      current_value TEXT
    );

    -- 登录日志
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      real_name TEXT,
      ip TEXT,
      browser TEXT,
      os TEXT,
      login_time TEXT,
      status TEXT,
      message TEXT
    );

    -- 操作日志
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT,
      user TEXT,
      action TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 维护记录
    CREATE TABLE IF NOT EXISTS maintenance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT,
      type TEXT,
      content TEXT,
      operator TEXT,
      plan_date TEXT,
      execute_date TEXT,
      duration TEXT,
      status TEXT DEFAULT '计划中',
      result TEXT,
      rollback INTEGER DEFAULT 0
    );

    -- 积分兑换奖品
    CREATE TABLE IF NOT EXISTS exchange_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      points INTEGER DEFAULT 100,
      type TEXT DEFAULT 'coupon',
      enabled INTEGER DEFAULT 1
    );
  `);

  // Create indexes for performance
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_products_code ON products(code)',
    'CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)',
    'CREATE INDEX IF NOT EXISTS idx_members_card_no ON members(card_no)',
    'CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone)',
    'CREATE INDEX IF NOT EXISTS idx_sales_orders_order_no ON sales_orders(order_no)',
    'CREATE INDEX IF NOT EXISTS idx_sales_orders_order_date ON sales_orders(order_date)',
    'CREATE INDEX IF NOT EXISTS idx_purchase_orders_order_no ON purchase_orders(order_no)',
    'CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(date)',
    'CREATE INDEX IF NOT EXISTS idx_attendances_date ON attendances(date)',
    'CREATE INDEX IF NOT EXISTS idx_inventory_records_product_id ON inventory_records(product_id)',
    'CREATE INDEX IF NOT EXISTS idx_system_logs_time ON system_logs(time)',
    'CREATE INDEX IF NOT EXISTS idx_login_logs_login_time ON login_logs(login_time)',
  ];
  for (const idx of indexes) {
    try { db.exec(idx); } catch (e) { /* index may already exist */ }
  }
}

module.exports = { db, initDatabase };
