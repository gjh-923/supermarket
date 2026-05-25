// 生成 ER 图 drawio 文件
const fs = require('fs');

// 表定义：[名称, 字段列表(每行一个), x, y]
const groups = [
  {
    label: '系统管理 (System)',
    x: 30, y: 20,
    tables: [
      ['data_store', ['key TEXT PK', 'data TEXT'], 30, 55],
      ['users', ['id INTEGER PK', 'username TEXT UQ', 'password TEXT', 'name TEXT', 'role TEXT', 'status TEXT'], 30, 160],
      ['system_roles', ['id INTEGER PK', 'name TEXT', 'code TEXT UQ', 'permissions TEXT', 'status TEXT'], 30, 310],
      ['system_menus', ['id INTEGER PK', 'name TEXT', 'code TEXT', 'type TEXT', 'parent TEXT', 'sort INTEGER'], 30, 450],
      ['system_params', ['id INTEGER PK', 'name TEXT', 'code TEXT UQ', 'value TEXT'], 30, 580],
      ['dict_items', ['id INTEGER PK', 'type_name TEXT', 'dict_label TEXT', 'dict_value TEXT', 'sort INTEGER'], 260, 160],
      ['notices', ['id INTEGER PK', 'title TEXT', 'content TEXT', 'type TEXT', 'publisher TEXT', 'status TEXT'], 260, 310],
      ['login_logs', ['id INTEGER PK', 'username TEXT', 'real_name TEXT', 'ip TEXT', 'login_time TEXT', 'status TEXT'], 260, 450],
      ['system_logs', ['id INTEGER PK', 'time TEXT', 'user TEXT', 'action TEXT'], 260, 570],
      ['maintenance_records', ['id INTEGER PK', 'version TEXT', 'type TEXT', 'content TEXT', 'operator TEXT', 'status TEXT'], 500, 160],
      ['monitor_configs', ['id INTEGER PK', 'name TEXT', 'target TEXT', 'check_interval INT', 'status TEXT', 'enabled INT'], 500, 310],
    ]
  },
  {
    label: '人事管理 (HR)',
    x: 30, y: 740,
    tables: [
      ['departments', ['id INTEGER PK', 'name TEXT', 'code TEXT UQ', 'manager TEXT', 'status TEXT'], 30, 775],
      ['employee_positions', ['id INTEGER PK', 'name TEXT', 'category TEXT', 'employee_ids TEXT', 'employee_names TEXT'], 260, 775],
      ['employees', ['id INTEGER PK', 'name TEXT', 'code TEXT UQ', 'dept TEXT', 'position TEXT', 'phone TEXT'], 30, 910],
      ['schedules', ['id INTEGER PK', 'employee_id INT FK', 'employee_name TEXT', 'date TEXT', 'shift TEXT'], 260, 910],
      ['attendances', ['id INTEGER PK', 'employee_id INT FK', 'employee_name TEXT', 'date TEXT', 'status TEXT', 'check_in TEXT', 'check_out TEXT'], 500, 775],
      ['salaries', ['id INTEGER PK', 'employee_id INT FK', 'employee_name TEXT', 'year INT', 'month INT', 'base_salary REAL', 'total REAL', 'status TEXT'], 500, 940],
    ]
  },
  {
    label: '商品与库存 (Product & Inventory)',
    x: 800, y: 20,
    tables: [
      ['categories', ['id INTEGER PK', 'name TEXT UQ', 'sort INTEGER', 'status TEXT'], 800, 55],
      ['products', ['id INTEGER PK', 'code TEXT UQ', 'name TEXT', 'category TEXT FK', 'supplier TEXT', 'retail_price REAL', 'stock INT', 'status TEXT', 'image_url TEXT'], 800, 160],
      ['inventory_records', ['id INTEGER PK', 'product_id INT FK', 'product_name TEXT', 'type TEXT', 'qty INT', 'before_stock INT', 'after_stock INT', 'operator TEXT'], 800, 330],
      ['inventory_alert_settings', ['id INTEGER PK', 'product_category TEXT', 'min_stock INT', 'max_stock INT', 'expiry_days INT', 'enabled INT'], 800, 490],
      ['warehouse_zones', ['id INTEGER PK', 'name TEXT', 'location TEXT', 'capacity INT', 'current INT', 'manager TEXT', 'status TEXT'], 800, 620],
    ]
  },
  {
    label: '盘点 (Inventory Check)',
    x: 1080, y: 20,
    tables: [
      ['inventory_check_tasks', ['id INTEGER PK', 'task_no TEXT UQ', 'name TEXT', 'warehouse_zone TEXT', 'status TEXT', 'checker TEXT', 'check_date TEXT'], 1080, 55],
      ['inventory_check_items', ['id INTEGER PK', 'task_id INT FK', 'product_id INT FK', 'product_name TEXT', 'system_stock INT', 'actual_stock INT', 'diff INT', 'note TEXT'], 1080, 220],
      ['promotions', ['id INTEGER PK', 'name TEXT', 'type TEXT', 'product_ids TEXT FK', 'categories TEXT', 'rule_json TEXT', 'start_date TEXT', 'end_date TEXT', 'status TEXT'], 1080, 400],
    ]
  },
  {
    label: '会员管理 (Member)',
    x: 1360, y: 20,
    tables: [
      ['member_levels', ['id INTEGER PK', 'name TEXT UQ', 'min_spent REAL', 'discount REAL', 'points_rate REAL', 'benefits TEXT'], 1360, 55],
      ['members', ['id INTEGER PK', 'card_no TEXT UQ', 'name TEXT', 'phone TEXT', 'level TEXT FK', 'points INT', 'cumulative_points INT', 'total_spent REAL', 'status TEXT'], 1360, 190],
      ['member_points_records', ['id INTEGER PK', 'member_id INT FK', 'member_name TEXT', 'type TEXT', 'points INT', 'balance INT', 'operator TEXT'], 1360, 360],
      ['exchange_rewards', ['id INTEGER PK', 'name TEXT', 'points INT', 'type TEXT', 'enabled INT'], 1360, 500],
    ]
  },
  {
    label: '销售与采购 (Sales & Purchase)',
    x: 1360, y: 650,
    tables: [
      ['sales_orders', ['id INTEGER PK', 'order_no TEXT UQ', 'member_id INT FK', 'member_name TEXT', 'items TEXT', 'total_amount REAL', 'discount_amount REAL', 'final_amount REAL', 'coupon_discount REAL', 'pay_method TEXT', 'operator TEXT'], 1360, 685],
      ['purchase_orders', ['id INTEGER PK', 'order_no TEXT UQ', 'supplier_id INT FK', 'supplier_name TEXT', 'items TEXT', 'total_amount REAL', 'status TEXT', 'order_date TEXT', 'received_date TEXT', 'operator TEXT'], 1360, 860],
    ]
  },
  {
    label: '供应商 (Supplier)',
    x: 1660, y: 20,
    tables: [
      ['suppliers', ['id INTEGER PK', 'code TEXT UQ', 'name TEXT', 'contact TEXT', 'phone TEXT', 'level TEXT', 'status TEXT', 'bank_account TEXT', 'tax_id TEXT'], 1660, 55],
      ['supplier_contracts', ['id INTEGER PK', 'supplier_id INT FK', 'supplier_name TEXT', 'contract_no TEXT UQ', 'sign_date TEXT', 'expiry_date TEXT', 'amount REAL', 'status TEXT', 'type TEXT'], 1660, 240],
      ['supplier_evaluations', ['id INTEGER PK', 'supplier_id INT FK', 'supplier_name TEXT', 'rating INT', 'quality INT', 'delivery INT', 'price INT', 'service INT', 'evaluator TEXT'], 1660, 420],
    ]
  },
  {
    label: '财务管理 (Finance)',
    x: 1660, y: 620,
    tables: [
      ['finance_ledger', ['id INTEGER PK', 'date TEXT', 'type TEXT', 'category TEXT', 'amount REAL', 'account TEXT', 'summary TEXT', 'voucher_no TEXT'], 1660, 655],
      ['finance_budget', ['id INTEGER PK', 'year INT', 'month INT', 'category TEXT', 'budget_amount REAL', 'actual_amount REAL', 'department TEXT'], 1660, 810],
      ['finance_tax', ['id INTEGER PK', 'tax_name TEXT', 'tax_rate REAL', 'taxable_amount REAL', 'tax_amount REAL', 'period TEXT', 'status TEXT', 'due_date TEXT'], 1660, 950],
    ]
  },
];

// 关系定义：[fromTable, toTable, label, fromField, toField]
const relationships = [
  // 商品相关
  ['products', 'categories', '', 'category', 'name'],
  ['inventory_records', 'products', '', 'product_id', 'id'],
  ['inventory_check_items', 'inventory_check_tasks', '', 'task_id', 'id'],
  ['inventory_check_items', 'products', '', 'product_id', 'id'],
  // 会员相关
  ['members', 'member_levels', '', 'level', 'name'],
  ['member_points_records', 'members', '', 'member_id', 'id'],
  ['sales_orders', 'members', '', 'member_id', 'id'],
  // 供应商相关
  ['supplier_contracts', 'suppliers', '', 'supplier_id', 'id'],
  ['supplier_evaluations', 'suppliers', '', 'supplier_id', 'id'],
  ['purchase_orders', 'suppliers', '', 'supplier_id', 'id'],
  // 人事相关
  ['schedules', 'employees', '', 'employee_id', 'id'],
  ['attendances', 'employees', '', 'employee_id', 'id'],
  ['salaries', 'employees', '', 'employee_id', 'id'],
  ['employees', 'departments', '', 'dept', 'name'],
  ['employees', 'employee_positions', '', 'position', 'name'],
  // 促销
  ['promotions', 'products', '(JSON)', 'product_ids', 'id'],
  // 销售
  ['sales_orders', 'members', '', 'member_id', 'id'],
  ['purchase_orders', 'suppliers', '', 'supplier_id', 'id'],
];

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }

let cellId = 2;
function newId() { return String(cellId++); }

let xml = '';
xml += '<?xml version="1.0" encoding="UTF-8"?>\n';
xml += '<mxfile host="app.diagrams.net" modified="2026-05-26T00:00:00.000Z" agent="generated" version="24.0.0">\n';
xml += '  <diagram name="Supermarket ER Diagram" id="er-diagram">\n';
xml += '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="2000" pageHeight="1200" math="0" shadow="0" background="#FFFFFF">\n';
xml += '      <root>\n';
xml += '        <mxCell id="0"/>\n';
xml += '        <mxCell id="1" parent="0"/>\n';

const tableStyle = 'shape=table;startSize=28;container=1;collapsible=0;childLayout=tableLayout;fontStyle=1;fontSize=11;fillColor=none;strokeColor=#000000;align=left;verticalAlign=top;whiteSpace=wrap;html=1;';
const tableHeaderStyle = 'shape=tableRow;horizontal=0;startSize=22;fillColor=none;strokeColor=#000000;fontStyle=1;fontSize=11;';
const tableRowStyle = 'shape=tableRow;horizontal=0;startSize=18;fillColor=none;strokeColor=#000000;fontSize=10;align=left;';
const tableRowPkStyle = 'shape=tableRow;horizontal=0;startSize=18;fillColor=none;strokeColor=#000000;fontSize=10;align=left;fontStyle=1;';
const groupStyle = 'rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#000000;strokeWidth=2;dashed=1;fontSize=12;fontStyle=1;verticalAlign=top;align=left;spacingLeft=10;spacingTop=5;';
const edgeStyle = 'edgeStyle=entityRelationEdgeStyle;endArrow=ERone;startArrow=ERzeroToOne;html=1;strokeColor=#000000;fontSize=9;';

// Store table positions for relationship routing
const tablePositions = {};
const tableSizes = {};

// Generate tables
for (const group of groups) {
  // Group boundary
  const gx = group.x - 15;
  const gy = group.y - 5;
  // Calculate group dimensions
  let maxRight = 0;
  let maxBottom = 0;
  for (const t of group.tables) {
    const tx = t[2];
    const ty = t[3];
    const fieldCount = t[1].length;
    const tableHeight = 28 + fieldCount * 18 + 2;
    const maxFieldLen = Math.max(...t[1].map(f => f.length));
    const tableWidth = Math.max(maxFieldLen * 7 + 20, t[0].length * 7 + 20, 160);
    if (tx + tableWidth > maxRight) maxRight = tx + tableWidth;
    if (ty + tableHeight > maxBottom) maxBottom = ty + tableHeight;
  }
  const gw = maxRight - gx + 20;
  const gh = maxBottom - gy + 20;

  const gid = newId();
  xml += `        <mxCell id="${gid}" value="${esc(group.label)}" style="${groupStyle}" vertex="1" parent="1">\n`;
  xml += `          <mxGeometry x="${gx}" y="${gy}" width="${gw}" height="${gh}" as="geometry"/>\n`;
  xml += `        </mxCell>\n`;

  for (const t of group.tables) {
    const tname = t[0];
    const fields = t[1];
    const tx = t[2];
    const ty = t[3];
    const fieldCount = fields.length;
    const maxFieldLen = Math.max(...fields.map(f => f.length));
    const tableWidth = Math.max(maxFieldLen * 7 + 20, tname.length * 8 + 20, 160);
    const tableHeight = 28 + fieldCount * 18 + 2;

    tablePositions[tname] = { x: tx, y: ty, w: tableWidth, h: tableHeight };
    tableSizes[tname] = { w: tableWidth, h: tableHeight };

    const tid = newId();
    xml += `        <mxCell id="${tid}" value="${esc(tname)}" style="${tableStyle}" vertex="1" parent="1">\n`;
    xml += `          <mxGeometry x="${tx}" y="${ty}" width="${tableWidth}" height="${tableHeight}" as="geometry"/>\n`;
    xml += `        </mxCell>\n`;

    for (let fi = 0; fi < fields.length; fi++) {
      const f = fields[fi];
      const isPk = f.includes('PK') || f.includes('UQ');
      const rid = newId();
      xml += `        <mxCell id="${rid}" value="${esc(f)}" style="${isPk ? tableRowPkStyle : tableRowStyle}" vertex="1" parent="${tid}">\n`;
      xml += `          <mxGeometry y="${28 + fi * 18}" width="${tableWidth}" height="18" as="geometry"/>\n`;
      xml += `        </mxCell>\n`;
    }
  }
}

// Generate relationships
for (const rel of relationships) {
  const from = rel[0];
  const to = rel[1];
  const label = rel[2];
  const fromPos = tablePositions[from];
  const toPos = tablePositions[to];

  if (!fromPos || !toPos) continue;

  // Calculate edge points based on relative positions
  let exitX, exitY, entryX, entryY;

  const fromCX = fromPos.x + fromPos.w / 2;
  const fromCY = fromPos.y + fromPos.h / 2;
  const toCX = toPos.x + toPos.w / 2;
  const toCY = toPos.y + toPos.h / 2;

  // Determine best connection points
  if (Math.abs(fromCX - toCX) > Math.abs(fromCY - toCY)) {
    // Horizontal connection
    if (fromCX < toCX) {
      exitX = fromPos.x + fromPos.w;
      exitY = fromCY;
      entryX = toPos.x;
      entryY = toCY;
    } else {
      exitX = fromPos.x;
      exitY = fromCY;
      entryX = toPos.x + toPos.w;
      entryY = toCY;
    }
  } else {
    // Vertical connection
    if (fromCY < toCY) {
      exitX = fromCX;
      exitY = fromPos.y + fromPos.h;
      entryX = toCX;
      entryY = toPos.y;
    } else {
      exitX = fromCX;
      exitY = fromPos.y;
      entryX = toCX;
      entryY = toPos.y + toPos.h;
    }
  }

  const eid = newId();
  const edgeGeom = `<mxGeometry relative="1" as="geometry"><mxPoint x="${Math.round(exitX)}" y="${Math.round(exitY)}" as="sourcePoint"/><mxPoint x="${Math.round(entryX)}" y="${Math.round(entryY)}" as="targetPoint"/></mxGeometry>`;

  xml += `        <mxCell id="${eid}" value="${esc(label)}" style="${edgeStyle}" edge="1" parent="1">\n`;
  xml += `          ${edgeGeom}\n`;
  xml += `        </mxCell>\n`;
}

xml += '      </root>\n';
xml += '    </mxGraphModel>\n';
xml += '  </diagram>\n';
xml += '</mxfile>\n';

fs.writeFileSync('supermarket-er.drawio', xml, 'utf8');
console.log('Generated supermarket-er.drawio with', cellId - 2, 'cells');
