const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'awareness_competition';
const COLLECTION_NAME = 'entries';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

let dbPromise;
const submissionWindows = new Map();

function getDb() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (!dbPromise) {
    dbPromise = (async () => {
      const client = new MongoClient(MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
      });
      await client.connect();
      const db = client.db(DB_NAME);
      await db.collection(COLLECTION_NAME).createIndex({ createdAt: -1 });
      return db;
    })().catch((error) => {
      dbPromise = undefined;
      throw error;
    });
  }

  return dbPromise;
}

function entries(db) {
  return db.collection(COLLECTION_NAME);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  const visibleLocal = local.length <= 2 ? `${local[0] || ''}*` : `${local.slice(0, 2)}***`;
  const domainParts = domain.split('.');
  const host = domainParts.shift() || '';
  const visibleHost = host.length <= 2 ? `${host[0] || ''}*` : `${host.slice(0, 2)}***`;
  return `${visibleLocal}@${visibleHost}.${domainParts.join('.')}`;
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '');
  const expectedBuffer = Buffer.from(expected || '');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function adminGuard(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      success: false,
      message: 'لوحة الإدارة غير مهيأة. أضف ADMIN_KEY إلى متغيرات البيئة.',
    });
  }

  if (!safeEqual(req.get('x-admin-key'), ADMIN_KEY)) {
    return res.status(401).json({ success: false, message: 'مفتاح الإدارة غير صحيح.' });
  }

  next();
}

function submissionRateLimit(req, res, next) {
  const key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (submissionWindows.get(key) || []).filter((time) => now - time < windowMs);

  if (recent.length >= 10) {
    return res.status(429).json({
      success: false,
      message: 'تم تجاوز عدد المحاولات المسموح. حاول لاحقًا.',
    });
  }

  recent.push(now);
  submissionWindows.set(key, recent);
  next();
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/health', async (req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', database: 'connected', storage: 'persistent' });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      database: 'disconnected',
      storage: 'unavailable',
      message: 'التخزين الدائم غير متاح حاليًا.',
    });
  }
});

app.post('/api/entries', submissionRateLimit, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  const email = normalizeEmail(req.body.email);
  const answer = String(req.body.answer || '').trim();
  const consent = req.body.consent === true;

  if (displayName.length < 2 || displayName.length > 50) {
    return res.status(400).json({ success: false, message: 'أدخل اسمًا أو اسمًا مستعارًا من حرفين إلى 50 حرفًا.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'أدخل بريدًا إلكترونيًا صالحًا.' });
  }
  if (!['verify-link', 'share-code', 'strong-password'].includes(answer)) {
    return res.status(400).json({ success: false, message: 'اختر إجابة السؤال التوعوي.' });
  }
  if (!consent) {
    return res.status(400).json({ success: false, message: 'الموافقة مطلوبة للمشاركة في التجربة التوعوية.' });
  }

  const id = uuidv4();
  const record = {
    _id: id,
    id,
    displayName,
    maskedEmail: maskEmail(email),
    answer,
    consentVersion: '2026-09',
    status: 'waiting',
    createdAt: new Date(),
  };

  try {
    const db = await getDb();
    await entries(db).insertOne(record);
    res.status(201).json({ success: true, sessionId: id });
  } catch (error) {
    console.error('[database] entry creation failed:', error.message);
    res.status(503).json({ success: false, message: 'تعذر حفظ المشاركة بشكل دائم. حاول بعد تهيئة قاعدة البيانات.' });
  }
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const db = await getDb();
    const record = await entries(db).findOne(
      { id: req.params.id },
      { projection: { _id: 0, status: 1 } },
    );
    if (!record) {
      return res.status(404).json({ success: false, message: 'المشاركة غير موجودة.' });
    }
    res.json({ success: true, status: record.status, triggered: record.status === 'triggered' });
  } catch (error) {
    res.status(503).json({ success: false, message: 'تعذر الوصول إلى قاعدة البيانات.' });
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    const db = await getDb();
    const result = await entries(db).deleteOne({ id: req.params.id });
    res.json({ success: result.deletedCount === 1 });
  } catch (error) {
    res.status(503).json({ success: false, message: 'تعذر حذف المشاركة.' });
  }
});

app.use('/api/admin', adminGuard);

app.get('/api/admin/records', async (req, res) => {
  try {
    const db = await getDb();
    const records = await entries(db)
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    res.json({
      success: true,
      records,
      total: records.length,
      waitingCount: records.filter((record) => record.status === 'waiting').length,
      triggeredCount: records.filter((record) => record.status === 'triggered').length,
    });
  } catch (error) {
    res.status(503).json({ success: false, message: 'تعذر قراءة قاعدة البيانات.' });
  }
});

app.post('/api/admin/trigger/:id', async (req, res) => {
  try {
    const db = await getDb();
    const result = await entries(db).updateOne(
      { id: req.params.id, status: 'waiting' },
      { $set: { status: 'triggered', triggeredAt: new Date() } },
    );
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: 'لا توجد مشاركة منتظرة بهذا المعرّف.' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(503).json({ success: false, message: 'تعذر تحديث المشاركة.' });
  }
});

app.post('/api/admin/trigger-all', async (req, res) => {
  try {
    const db = await getDb();
    const result = await entries(db).updateMany(
      { status: 'waiting' },
      { $set: { status: 'triggered', triggeredAt: new Date() } },
    );
    res.json({ success: true, count: result.modifiedCount });
  } catch (error) {
    res.status(503).json({ success: false, message: 'تعذر تحديث المشاركات.' });
  }
});

app.delete('/api/admin/records/:id', async (req, res) => {
  try {
    const db = await getDb();
    const result = await entries(db).deleteOne({ id: req.params.id });
    res.json({ success: result.deletedCount === 1 });
  } catch (error) {
    res.status(503).json({ success: false, message: 'تعذر حذف المشاركة.' });
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Awareness competition is running on http://localhost:${PORT}`);
  });
}
