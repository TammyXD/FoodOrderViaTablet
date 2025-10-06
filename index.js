const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const PORT = process.env.PORT || 3000;
const app = express();
const db = new sqlite3.Database('./Shushi.db');

const listcount = 5; // จำนวนเมนูสูงสุดที่สั่งได้ต่อครั้ง

// ตั้งค่า view engine และ static files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ฟังก์ชันช่วยตั้งชื่อตารางตามหมายเลขโต๊ะ
function tableNameFor(tableNumber) {
  return `table_${tableNumber}`;
}

// สร้างตารางสำหรับโต๊ะนั้นถ้ายังไม่มี
function ensureTableExists(tableNumber, callback) {
  const tableName = tableNameFor(tableNumber);
  const createSQL = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      name TEXT,
      price REAL,
      quantity INTEGER,
      status TEXT DEFAULT 'กำลังเตรียม'
    )
  `;
  db.run(createSQL, callback);
}

// หน้าเมนูหลัก: แสดงหมวดหมู่ทั้งหมด
app.get('/', (req, res) => {
  const tableNumber = req.query.tableNumber || 1;
  db.all('SELECT * FROM categories', [], (err, categories) => {
    res.render('categories', { categories, tableNumber });
  });
});

// หน้าเมนูตามหมวดหมู่: แสดงเมนู + ตะกร้า
app.get('/category/:id', (req, res) => {
  const categoryId = req.params.id;
  const tableNumber = req.query.tableNumber || 1;

  db.get('SELECT * FROM categories WHERE id = ?', [categoryId], (err, category) => {
    if (err || !category) return res.status(404).send('ไม่พบหมวดหมู่');

    db.all('SELECT * FROM menu_items WHERE category_id = ?', [categoryId], (err, items) => {
      if (err) return res.status(500).send('เกิดข้อผิดพลาดในการโหลดเมนู');

      db.all('SELECT * FROM categories', [], (err, categories) => {
        if (err) return res.status(500).send('เกิดข้อผิดพลาดในการโหลดหมวดหมู่ทั้งหมด');

        res.render('menu_by_category', {
          category,
          items,
          categories,
          tableNumber,
          listcount
        });
      });
    });
  });
});

// เพิ่มเมนูลงตารางของโต๊ะ
app.post('/add-item', (req, res) => {
  const { tableNumber, itemId, name, price } = req.body;

  ensureTableExists(tableNumber, () => {
    const tableName = tableNameFor(tableNumber);
    db.get(`SELECT * FROM ${tableName} WHERE item_id = ?`, [itemId], (err, row) => {
      if (row) {
        // เมนูนี้มีอยู่แล้ว : เพิ่มจำนวนได้
        db.run(`UPDATE ${tableName} SET quantity = quantity + 1 WHERE item_id = ?`, [itemId]);
        return res.sendStatus(200);
      }
      // เมนูนี้ยังไม่มี : ตรวจสอบจำนวนชนิดเมนูที่มีอยู่
      db.all(`SELECT COUNT(*) AS count FROM ${tableName}`, [], (err, rows) => {
        const count = rows[0]?.count || 0;
        if (count >= (listcount + 1)) {
          return res.status(400).send(`คุณสั่งครบ ${listcount} เมนูแล้ว ไม่สามารถเพิ่มเมนูใหม่ได้ กรุณายืนยันรายการอาหารก่อนหน้าเพื่อสั่งเมนูใหม่`);
        }
        // ยังไม่เกิน : เพิ่มเมนูใหม่
        db.run(`INSERT INTO ${tableName} (item_id, name, price, quantity) VALUES (?, ?, ?, 1)`, [itemId, name, price]);
        res.sendStatus(200);
      });
    });
  });
});

// ดึงรายการอาหารจากโต๊ะนั้น
app.get('/orders/:tableNumber', (req, res) => {
  const tableNumber = req.params.tableNumber;
  ensureTableExists(tableNumber, () => {
    const tableName = tableNameFor(tableNumber);
    db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
      if (err) return res.json([]);
      res.json(rows);
    });
  });
});

// อัปเดตจำนวนรายการอาหาร
app.post('/update-item', (req, res) => {
  const { tableNumber, orderId, quantity } = req.body;
  const tableName = tableNameFor(tableNumber);

  if (quantity <= 0) {
    db.run(`DELETE FROM ${tableName} WHERE id = ?`, [orderId], () => res.sendStatus(200));
  } else {
    db.run(`UPDATE ${tableName} SET quantity = ? WHERE id = ?`, [quantity, orderId], () => res.sendStatus(200));
  }
});

// ลบรายการอาหาร
app.post('/delete-item', (req, res) => {
  const { tableNumber, orderId } = req.body;
  const tableName = tableNameFor(tableNumber);

  db.run(`DELETE FROM ${tableName} WHERE id = ?`, [orderId], () => res.sendStatus(200));
});

// ยืนยันคำสั่ง → ส่งข้อมูลไปยังครัว
app.post('/confirm-order/:tableNumber', (req, res) => {
  const tableNumber = req.params.tableNumber;
  const tableName = tableNameFor(tableNumber);
  const historyTable = `table_${tableNumber}_history`;

  // สร้างตาราง history ถ้ายังไม่มี
  db.run(`
    CREATE TABLE IF NOT EXISTS ${historyTable} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      name TEXT,
      price REAL,
      quantity INTEGER,
      served_at TEXT,
      status TEXT DEFAULT 'กำลังเตรียม'
    )
  `, () => {
    // ดึงรายการอาหารจากโต๊ะ
    db.all(`SELECT * FROM ${tableName}`, [], (err, items) => {
      if (err || !items.length) return res.send('ไม่มีรายการอาหาร');

      // เพิ่มลง kitchen_orders และ history
      let completed = 0;
      items.forEach(item => {
        // เพิ่มลง kitchen_orders
        db.run(`
          INSERT INTO kitchen_orders (table_number, item_id, name, price, quantity, status)
          VALUES (?, ?, ?, ?, ?, 'กำลังเตรียม')
        `, [tableNumber, item.item_id, item.name, item.price, item.quantity]);

        // เพิ่มลง history
        db.run(`
          INSERT INTO ${historyTable} (item_id, name, price, quantity, served_at, status)
          VALUES (?, ?, ?, ?, datetime('now'), 'กำลังเตรียม')
        `, [item.item_id, item.name, item.price, item.quantity], () => {
          completed++;
          // เมื่อเพิ่มครบทุกเมนู
          if (completed === items.length) {
            // ล้างรายการในโต๊ะ (optionally)
            db.run(`DELETE FROM ${tableName}`);
            res.send('ยืนยันรายการอาหารเรียบร้อย');
          }
        });
      });
    });
  });
});

// พ่อครัว : แสดงรายการในครัว
app.get('/kitchen', (req, res) => {
  db.all('SELECT * FROM kitchen_orders ORDER BY table_number', [], (err, orders) => {
    if (err) return res.status(500).send('ไม่สามารถโหลดรายการครัวได้');
    res.render('kitchen', { orders });
  });
});

// พ่อครัว : อัปเดตสถานะอาหาร
app.post('/update-status', (req, res) => {
  const { orderId, status } = req.body;

  db.get(`SELECT * FROM kitchen_orders WHERE id = ?`, [orderId], (err, order) => {
    if (err || !order) return res.status(404).send('ไม่พบรายการอาหาร');

    const tableNumber = order.table_number;
    const historyTable = `table_${tableNumber}_history`;

    if (status === 'ยกเลิกแล้ว') {
      db.run(`DELETE FROM kitchen_orders WHERE id = ?`, [orderId], (err) => {
        if (err) return res.status(500).send('ไม่สามารถลบรายการจากตารางได้');
        db.run(`DELETE FROM ${historyTable} WHERE item_id = ?`, [order.item_id]);
        return res.redirect('/kitchen');
      });
    } else if (status === 'ทำเสร็จแล้ว') {
      db.run(`UPDATE kitchen_orders SET status = ? WHERE id = ?`, [status, orderId], (err) => {
        if (err) return res.status(500).send('อัปเดตสถานะไม่สำเร็จ');
        db.run(`UPDATE ${historyTable} SET status = ? WHERE item_id = ?`, [status, order.item_id], (err) => {
          if (err) return res.status(500).send('อัปเดตสถานะในประวัติไม่สำเร็จ');
          // ลบรายการที่ทำเสร็จแล้วออกจาก kitchen_orders
          db.run(`DELETE FROM kitchen_orders WHERE id = ?`, [orderId], () => {
            return res.redirect('/kitchen');
          });
        });
      });
    } else {
      db.run(`UPDATE kitchen_orders SET status = ? WHERE id = ?`, [status, orderId], (err) => {
        if (err) return res.status(500).send('อัปเดตสถานะไม่สำเร็จ');
        db.run(`UPDATE ${historyTable} SET status = ? WHERE item_id = ?`, [status, order.item_id], (err) => {
          if (err) return res.status(500).send('อัปเดตสถานะในประวัติไม่สำเร็จ');
          return res.redirect('/kitchen');
        });
      });
    }
  });
});

// แสดงประวัติการสั่งอาหารของโต๊ะนั้นๆ
app.get('/history/:tableNumber', (req, res) => {
  const tableNumber = req.params.tableNumber;
  const historyTable = `table_${tableNumber}_history`;

  // ตรวจสอบว่าตารางมีอยู่และดึงข้อมูล
  db.all(`SELECT * FROM ${historyTable}`, [], (err, rows) => {
    if (err || !rows) {
      console.error('เกิดข้อผิดพลาดในการโหลดประวัติ:', err);
      return res.status(500).send('ไม่สามารถโหลดประวัติการสั่งซื้อได้');
    }

    if (rows.length === 0) {
      return res.send(`<script>alert('กรุณาสั่งอาหารก่อน'); window.location.href = '/';</script>`);
    }

    res.render('history', { tableNumber, items: rows });
  });
});

// ลูกค้า: แสดงรายการที่ต้องชำระเงิน
app.get('/checkout_customer/:tableNumber', (req, res) => {
  const tableNumber = req.params.tableNumber;
  const historyTable = `table_${tableNumber}_history`;

  db.all(`SELECT * FROM ${historyTable}`, [], (err, items) => {
    if (err || !items) return res.status(500).send('ไม่สามารถโหลดข้อมูลการชำระเงินได้');
    res.render('checkout_customer', { tableNumber, items });
  });
});

// ดำเนินการชำระเงินและล้างประวัติ
app.post('/checkout_customer/complete-payment', (req, res) => {
  const tableNumber = req.body.tableNumber;
  const method = req.body.method;
  const historyTable = `table_${tableNumber}_history`;

  db.all(`SELECT * FROM ${historyTable}`, [], (err, items) => {
    if (err || items.length === 0) {
      return res.status(400).send('ยังไม่มีรายการอาหารที่เสิร์ฟ ไม่สามารถชำระเงินได้');
    }

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const totalAmount = parseFloat((subtotal * 1.17).toFixed(2));
    const paidAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    db.run(`
      INSERT INTO sales_summary (table_number, total_amount, paid_at, payment_method)
      VALUES (?, ?, ?, ?)
    `, [tableNumber, totalAmount, paidAt, method], function(err) {
      if (err) return res.status(500).send('ไม่สามารถบันทึกยอดขายได้');
      const saleId = this.lastID; // foreign key
      const insertItem = db.prepare(`
        INSERT INTO sales_item (sale_id, item_id, item_name, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `);
      items.forEach(item => {
        insertItem.run(saleId, item.item_id, item.name, item.quantity, item.price);
      });
      insertItem.finalize();

      // ล้างข้อมูลโต๊ะ
      db.run(`DELETE FROM ${historyTable}`);
      db.run(`DELETE FROM payment_method_pending WHERE table_number = ?`, [tableNumber]);

      res.send(`<script>alert('บันทึกการชำระเงินเรียบร้อยแล้ว'); window.location.href = '/cashier_list';</script>`);
    });
  });
});


// แคชเชียร์: แสดงรายชื่อโต๊ะที่มีรายการต้องชำระเงิน
app.get('/cashier_list', (req, res) => {
  db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'table_%_history'`, [], (err, tables) => {
    if (err || !tables) return res.status(500).send('ไม่สามารถโหลดรายชื่อโต๊ะได้');

    const tableList = [];

   const checkTables = tables.map(t => {
    return new Promise(resolve => {
      db.get(`SELECT COUNT(*) AS count FROM ${t.name}`, [], (err, row) => {
        const tableNumber = t.name.split('_')[1];

      if (!err && row.count > 0) {
        // โต๊ะยังมีรายการ : ดูช่องทางที่ลูกค้าเลือกไว้
        db.get(
          `SELECT method FROM payment_method_pending WHERE table_number = ? ORDER BY selected_at DESC LIMIT 1`,
          [tableNumber],
          (err, pending) => {
            const method = pending?.method || 'ยังไม่พร้อมชำระเงิน';
            tableList.push({ tableNumber, method });
            resolve();
          }
        );
      } else {
        // โต๊ะไม่มีรายการ : ตรวจสอบว่าชำระเงินแล้วหรือยัง
        db.get(
          `SELECT payment_method FROM sales_summary WHERE table_number = ? ORDER BY paid_at DESC LIMIT 1`,
          [tableNumber],
          (err, summary) => {
            const method = summary?.payment_method;

            if (!method) {
              // ยังไม่เคยชำระ : แสดงโต๊ะ
              tableList.push({ tableNumber, method: 'ยังไม่ชำระเงิน' });
            }
            // ถ้าชำระแล้ว : ไม่ต้อง push โต๊ะนี้
            resolve();
          }
        );
      }
      });
    });
  });


    Promise.all(checkTables).then(() => {
      res.render('cashier_list', { tableList });
    });
  });
});
// ลูกค้า: เลือกช่องทางการชำระเงิน
app.post('/checkout_customer/select-method', (req, res) => {
  const tableNumber = req.body.tableNumber;
  const method = req.body.method;

  db.run(`
    INSERT INTO payment_method_pending (table_number, method, selected_at)
    VALUES (?, ?, datetime('now'))
  `, [tableNumber, method], (err) => {
    if (err) return res.status(500).send('ไม่สามารถบันทึกช่องทางการชำระเงินได้');

    if (method === 'QR Code') {
      res.redirect(`/checkout_customer/complete-payment?tableNumber=${tableNumber}&method=QR Code`);
    } else {
      res.send(`<script>alert('แจ้งพนักงานแล้ว พนักงานกำลังมาที่โต๊ะของท่านเร็วๆนี้'); window.location.href = '/?tableNumber=${tableNumber}';</script>`);
    }
  });
});


// แคชเชียร์: แสดงรายการที่ต้องชำระเงิน
app.get('/checkout_cashier/:tableNumber', (req, res) => {
  const tableNumber = req.params.tableNumber;
  const historyTable = `table_${tableNumber}_history`;

  db.all(`SELECT * FROM ${historyTable}`, [], (err, items) => {
    if (err || !items) return res.status(500).send('ไม่สามารถโหลดข้อมูลการชำระเงินได้');
    res.render('checkout_cashier', { tableNumber, items });
  });
});

// ลูกค้า: ชำระเงินและล้างประวัติ
app.post('/checkout_customer/complete-payment', (req, res) => {
  const tableNumber = req.body.tableNumber;
  const method = req.body.method;
  const historyTable = `table_${tableNumber}_history`;

  db.all(`SELECT * FROM ${historyTable}`, [], (err, items) => {
    if (err || items.length === 0) {
      return res.status(400).send('ยังไม่มีรายการอาหารที่เสิร์ฟ ไม่สามารถชำระเงินได้');
    }

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const totalAmount = parseFloat((subtotal * 1.17).toFixed(2));
    const paidAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    db.run(`
      INSERT INTO sales_summary (table_number, total_amount, paid_at, payment_method)
      VALUES (?, ?, ?, ?)
    `, [tableNumber, totalAmount, paidAt, method], function(err) {
      if (err) return res.status(500).send('ไม่สามารถบันทึกยอดขายได้');
      const saleId = this.lastID;

      const insertItem = db.prepare(`
        INSERT INTO sales_item (sale_id, item_id, item_name, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `);
      items.forEach(item => {
        insertItem.run(saleId, item.item_id, item.name, item.quantity, item.price);
      });
      insertItem.finalize();

      // ล้างข้อมูลโต๊ะ
      db.run(`DELETE FROM ${historyTable}`);
      db.run(`DELETE FROM payment_method_pending WHERE table_number = ?`, [tableNumber]);
      res.send(`<script>alert('บันทึกการชำระเงินเรียบร้อยแล้ว'); window.location.href = '/cashier_list';</script>`);
    });
  });
});

// แคชเชียร์: ชำระเงินและล้างประวัติ
app.post('/checkout_cashier/confirm-payment', (req, res) => {
  const tableNumber = req.body.tableNumber;
  const historyTable = `table_${tableNumber}_history`;

  db.all(`SELECT * FROM ${historyTable}`, [], (err, items) => {
    if (err || items.length === 0) return res.status(400).send('ไม่มีรายการอาหาร');

    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const totalAmount = parseFloat((subtotal * 1.17).toFixed(2));
    const paidAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    db.run(`
      INSERT INTO sales_summary (table_number, total_amount, paid_at, payment_method)
      VALUES (?, ?, ?, 'เงินสด')
    `, [tableNumber, totalAmount, paidAt], function(err) {
      if (err) return res.status(500).send('ไม่สามารถบันทึกยอดขายได้');
      const saleId = this.lastID;

      const insertItem = db.prepare(`
        INSERT INTO sales_item (sale_id, item_id, item_name, quantity, price)
        VALUES (?, ?, ?, ?, ?)
      `);
      items.forEach(item => {
        insertItem.run(saleId, item.item_id, item.name, item.quantity, item.price);
      });
      insertItem.finalize();

      db.run(`DELETE FROM ${historyTable}`);
      db.run(`DELETE FROM payment_method_pending WHERE table_number = ?`, [tableNumber]);
      res.send(`<script>alert('บันทึกการชำระเงินเรียบร้อยแล้ว'); window.location.href = '/cashier_list';</script>`);
    });
  });
});


// พนักงาน: จัดการเมนูอาหาร
app.get('/manage_menu', (req, res) => {
  db.all(`SELECT * FROM menu_items`, [], (err, items) => {
    if (err) return res.status(500).send('ไม่สามารถโหลดเมนูได้');
    res.render('manage_menu', { items });
  });
});

app.get('/sales_report', (req, res) => {
  db.all(`SELECT * FROM sales_summary ORDER BY paid_at DESC`, [], (err, sales) => {
    if (err) return res.status(500).send('ไม่สามารถโหลดรายงานยอดขายได้');
    res.render('sales_report', { sales });
  });
});

app.get('/receipt/:tableNumber', (req, res) => {
  const tableNumber = req.params.tableNumber;
  const historyTable = `table_${tableNumber}_history`;
  db.all(`SELECT * FROM ${historyTable}`, [], (err, items) => {
    if (err) return res.send('ไม่พบข้อมูล');
    res.render('receipt', { tableNumber, items });
  });
});

// เริ่มเซิร์ฟเวอร์
app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});
