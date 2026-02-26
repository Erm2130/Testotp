'use strict';

const { chromium } = require('playwright');
const http = require('http');
const url = require('url');

// ─────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────
const CONFIG = {
  TARGET_URL:        'https://test-otptg.netlify.app/',
  SERVER_PORT:       process.env.PORT || 3000,
  HEADLESS:          process.env.NODE_ENV === 'production',
  SESSION_MAX_AGE_MS: 30 * 60 * 1000,   // 30 min  – hard limit per session
  OTP_TTL_MS:         5 * 60 * 1000,    //  5 min  – OTP ที่สร้างหมดอายุ
  CLEANUP_INTERVAL_MS: 5 * 60 * 1000,  //  5 min  – วิ่ง cleanup loop
  PAGE_TIMEOUT_MS:   10_000,
};

// ─────────────────────────────────────────────
//  Browser singleton – thread-safe promise cache
// ─────────────────────────────────────────────
let _browserPromise = null;

async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = chromium
      .launch({
        headless: CONFIG.HEADLESS,
        args: ['--start-maximized'],
      })
      .catch((err) => {
        // Reset so next call retries
        _browserPromise = null;
        throw err;
      });
    console.log(`🚀 กำลังเปิดเบราว์เซอร์ (headless=${CONFIG.HEADLESS})…`);
  }
  const b = await _browserPromise;
  console.log('✅ Browser พร้อมใช้งาน');
  return b;
}

async function resetBrowser() {
  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      await b.close();
    } catch (_) { /* ignore */ }
    _browserPromise = null;
    console.log('🔄 Browser ถูก reset');
  }
}

// ─────────────────────────────────────────────
//  Session store
//  { page, context, phone, otp, createdAt, otpExpiresAt, status }
// ─────────────────────────────────────────────
const userSessions = new Map();

// ─────────────────────────────────────────────
//  createSession  – สร้าง/แทนที่ session ของ user
// ─────────────────────────────────────────────
async function createSession(sessionId, phoneNumber) {
  console.log(`\n📱 createSession  id=${sessionId}  phone=${phoneNumber}`);

  // ปิด session เก่าก่อน (ป้องกัน context leak)
  if (userSessions.has(sessionId)) {
    console.log(`   ↩  พบ session เก่า – ปิดก่อน`);
    await closeSession(sessionId);
  }

  const browser = await getBrowser();
  let context = null;
  let page    = null;

  try {
    context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page    = await context.newPage();

    await page.goto(CONFIG.TARGET_URL, { timeout: CONFIG.PAGE_TIMEOUT_MS });
    await page.waitForSelector('#phoneInput', { timeout: CONFIG.PAGE_TIMEOUT_MS });

    console.log(`📝 กรอกเบอร์: ${phoneNumber}`);
    await page.fill('#phoneInput', phoneNumber);
    await page.click('#sendBtn');

    console.log('⏳ รอ OTP…');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#mockSmsText');
        return el && el.innerText !== '------' && el.innerText.trim().length === 6;
      },
      { timeout: CONFIG.PAGE_TIMEOUT_MS }
    );

    const generatedOtp = (await page.innerText('#mockSmsText')).trim();
    console.log(`✅ OTP สำหรับ ${sessionId}: ${generatedOtp}`);

    const now = Date.now();
    userSessions.set(sessionId, {
      page,
      context,
      phone:        phoneNumber,
      otp:          generatedOtp,
      createdAt:    now,
      otpExpiresAt: now + CONFIG.OTP_TTL_MS,
      status:       'awaiting_verification',
    });

    return {
      success:    true,
      session_id: sessionId,
      otp:        generatedOtp,
      phone:      phoneNumber,
      expires_in_seconds: CONFIG.OTP_TTL_MS / 1000,
      message:    'Session สร้างสำเร็จ รอการยืนยัน',
    };

  } catch (err) {
    console.error('❌ createSession error:', err.message);
    // cleanup ทันทีถ้าเกิด error
    if (page    && !page.isClosed())  await page.close().catch(() => {});
    if (context)                       await context.close().catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────
//  verifySessionOTP
// ─────────────────────────────────────────────
async function verifySessionOTP(sessionId, otpFromUser, threadId = null) {
  console.log(`\n🔐 verifyOTP  id=${sessionId}  otp=${otpFromUser}`);

  const session = userSessions.get(sessionId);

  if (!session) {
    return { success: false, verified: false, otp_matched: false, thread_id: threadId,
             error: 'Session ไม่พบ กรุณาขอ OTP ใหม่' };
  }

  // ตรวจ OTP หมดอายุ
  if (Date.now() > session.otpExpiresAt) {
    await closeSession(sessionId);
    return { success: false, verified: false, otp_matched: false, thread_id: threadId,
             error: 'OTP หมดอายุ กรุณาขอ OTP ใหม่', status: 'expired' };
  }

  // ตรวจ page ยังใช้ได้
  if (!session.page || session.page.isClosed()) {
    await closeSession(sessionId);
    return { success: false, verified: false, otp_matched: false, thread_id: threadId,
             error: 'Session หมดอายุ กรุณาขอ OTP ใหม่', status: 'expired' };
  }

  try {
    const { page } = session;

    // รอ input ถ้ายังไม่มี
    await page.waitForSelector('#otpInput', { timeout: CONFIG.PAGE_TIMEOUT_MS });
    await page.fill('#otpInput', otpFromUser);
    await page.click('#verifyBtn');

    await page.waitForTimeout(1500);

    const step3Visible = await page
      .$eval('#step3', (el) => !el.classList.contains('hidden'))
      .catch(() => false);

    if (step3Visible) {
      console.log(`🎉 ยืนยันสำเร็จ: ${sessionId}`);
      session.status = 'verified';
      await closeSession(sessionId);
      return { success: true, verified: true, otp_matched: true, thread_id: threadId,
               message: 'ยืนยัน OTP สำเร็จ!', status: 'success' };
    }

    console.log(`❌ OTP ไม่ถูกต้อง: ${sessionId}`);
    session.status = 'awaiting_verification';
    return { success: true, verified: false, otp_matched: false, thread_id: threadId,
             message: 'รหัส OTP ไม่ถูกต้อง กรุณาลองใหม่', status: 'failed', retry: true };

  } catch (err) {
    console.error('❌ verifyOTP error:', err.message);
    await closeSession(sessionId);
    return { success: false, verified: false, otp_matched: false, thread_id: threadId,
             error: err.message, status: 'error' };
  }
}

// ─────────────────────────────────────────────
//  Session helpers
// ─────────────────────────────────────────────
function getSession(sessionId) {
  const s = userSessions.get(sessionId);
  if (!s) return { success: false, error: 'Session ไม่พบ' };
  return {
    success:    true,
    session_id: sessionId,
    phone:      s.phone,
    otp:        s.otp,
    status:     s.status,
    created_at: new Date(s.createdAt).toISOString(),
    otp_expires_at: new Date(s.otpExpiresAt).toISOString(),
    otp_expired: Date.now() > s.otpExpiresAt,
  };
}

function getAllSessions() {
  const sessions = [...userSessions.entries()].map(([id, s]) => ({
    session_id: id,
    phone:      s.phone,
    status:     s.status,
    created_at: new Date(s.createdAt).toISOString(),
    otp_expired: Date.now() > s.otpExpiresAt,
  }));
  return { success: true, total: sessions.length, sessions };
}

async function closeSession(sessionId) {
  const s = userSessions.get(sessionId);
  if (!s) return { success: false, error: 'Session ไม่พบ' };
  try {
    if (s.page && !s.page.isClosed()) await s.page.close();
    if (s.context)                     await s.context.close();
  } catch (e) {
    console.error('closeSession error:', e.message);
  }
  userSessions.delete(sessionId);
  console.log(`🗑  Session ปิดแล้ว: ${sessionId}`);
  return { success: true, message: `Session ${sessionId} ถูกปิด` };
}

async function cleanupOldSessions() {
  const now = Date.now();
  let count = 0;
  for (const [id, s] of userSessions) {
    if (now - s.createdAt > CONFIG.SESSION_MAX_AGE_MS) {
      console.log(`🧹 cleanup session เก่า: ${id}`);
      await closeSession(id);
      count++;
    }
  }
  if (count) console.log(`🧹 ลบทั้งหมด ${count} session`);
}

// ─────────────────────────────────────────────
//  HTTP helper utilities
// ─────────────────────────────────────────────
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
//  Router
// ─────────────────────────────────────────────
const ROUTES = {
  // POST /request-otp  (legacy alias)
  'POST /request-otp': async (req, res) => {
    const data = await readBody(req);
    const sessionId = data.session_id || data.chat_id || data.thread_id;
    const phone     = data.phone;
    if (!sessionId || !phone)
      return sendJSON(res, 400, { success: false, error: 'กรุณาระบุ session_id และ phone' });
    sendJSON(res, 200, await createSession(sessionId, phone));
  },

  // POST /create-session
  'POST /create-session': async (req, res) => {
    const data = await readBody(req);
    const sessionId = data.session_id || data.chat_id || data.thread_id;
    const phone     = data.phone;
    if (!sessionId || !phone)
      return sendJSON(res, 400, { success: false, error: 'กรุณาระบุ session_id และ phone' });
    sendJSON(res, 200, await createSession(sessionId, phone));
  },

  // POST /verify-otp
  'POST /verify-otp': async (req, res) => {
    const data = await readBody(req);
    const sessionId = data.session_id || data.thread_id || data.chat_id;
    const otp       = data.otp;
    const threadId  = data.thread_id || data.message_thread_id || sessionId;
    if (!sessionId || !otp)
      return sendJSON(res, 400, { success: false, error: 'กรุณาระบุ session_id และ otp' });
    sendJSON(res, 200, await verifySessionOTP(sessionId, otp, threadId));
  },

  // GET /get-session?session_id=xxx
  'GET /get-session': (req, res, query) => {
    const sessionId = query.session_id || query.chat_id || query.thread_id;
    if (!sessionId)
      return sendJSON(res, 400, { success: false, error: 'กรุณาระบุ session_id' });
    sendJSON(res, 200, getSession(sessionId));
  },

  // GET /sessions
  'GET /sessions': (_req, res) => sendJSON(res, 200, getAllSessions()),

  // POST /close-session
  'POST /close-session': async (req, res) => {
    const data = await readBody(req);
    const sessionId = data.session_id || data.chat_id || data.thread_id;
    if (!sessionId)
      return sendJSON(res, 400, { success: false, error: 'กรุณาระบุ session_id' });
    sendJSON(res, 200, await closeSession(sessionId));
  },

  // GET /health
  'GET /health': async (_req, res) => {
    let browserAlive = false;
    try {
      if (_browserPromise) {
        const b = await _browserPromise;
        browserAlive = b.isConnected();
      }
    } catch (_) {}
    sendJSON(res, 200, {
      status:   'ok',
      browser:  browserAlive,
      sessions: userSessions.size,
      uptime_s: Math.floor(process.uptime()),
    });
  },

  // POST /cleanup
  'POST /cleanup': async (_req, res) => {
    await cleanupOldSessions();
    sendJSON(res, 200, { success: true, sessions_remaining: userSessions.size });
  },

  // POST /close  – ปิดทุกอย่าง
  'POST /close': async (_req, res) => {
    for (const [id] of userSessions) await closeSession(id);
    await resetBrowser();
    sendJSON(res, 200, { success: true, message: 'Browser และทุก session ถูกปิด' });
  },
};

// ─────────────────────────────────────────────
//  HTTP Server
// ─────────────────────────────────────────────
function startServer() {
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const parsed   = url.parse(req.url, true);
    const routeKey = `${req.method} ${parsed.pathname}`;
    console.log(`📥 ${routeKey}`);

    const handler = ROUTES[routeKey];
    if (!handler) {
      return sendJSON(res, 404, {
        error: 'Not found',
        available_endpoints: Object.keys(ROUTES),
      });
    }

    try {
      await handler(req, res, parsed.query);
    } catch (err) {
      console.error('❌ Handler error:', err.message);
      sendJSON(res, 500, { success: false, error: err.message });
    }
  });

  // Auto cleanup
  const cleanupTimer = setInterval(cleanupOldSessions, CONFIG.CLEANUP_INTERVAL_MS);

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n🛑 ${signal} – กำลังปิดระบบ…`);
    clearInterval(cleanupTimer);
    for (const [id] of userSessions) await closeSession(id);
    await resetBrowser();
    server.close(() => {
      console.log('✅ Server ปิดแล้ว');
      process.exit(0);
    });
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(CONFIG.SERVER_PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  🎯  OTP Playwright Server – Multi User              ║
║  ────────────────────────────────────────────────    ║
║  Port    : ${String(CONFIG.SERVER_PORT).padEnd(43)}║
║  Headless: ${String(CONFIG.HEADLESS).padEnd(43)}║
║  OTP TTL : ${String(CONFIG.OTP_TTL_MS / 1000 + 's').padEnd(43)}║
║                                                      ║
║  POST /request-otp    – ขอ OTP (legacy)              ║
║  POST /create-session – สร้าง session ใหม่           ║
║  POST /verify-otp     – ยืนยัน OTP                   ║
║  GET  /get-session    – ดู session                   ║
║  GET  /sessions       – ดูทุก session                ║
║  POST /close-session  – ปิด session                  ║
║  GET  /health         – สถานะ server                 ║
║  POST /cleanup        – ลบ session เก่า              ║
║  POST /close          – ปิด server + browser         ║
╚══════════════════════════════════════════════════════╝
    `);
  });
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────
async function main() {
  // Parse CLI args  node otp_playwright.js --action sessions
  const args   = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      params[args[i].slice(2)] = args[i + 1] || true;
      i++;
    }
  }

  const { action } = params;

  if (!action) {
    console.log('📡 เริ่มต้น HTTP Server…');
    startServer();
    return;
  }

  // CLI helpers
  if (action === 'sessions') {
    console.log(JSON.stringify(getAllSessions(), null, 2));
  } else if (action === 'cleanup') {
    await cleanupOldSessions();
    console.log('✅ Cleaned up');
  } else {
    console.log('Usage: node otp_playwright.js  (default: start server)');
    console.log('       node otp_playwright.js --action sessions');
    console.log('       node otp_playwright.js --action cleanup');
  }
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
