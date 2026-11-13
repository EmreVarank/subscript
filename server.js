// ─── Config & .env Yükleyici ──────────────────────────────────────────────────
import { createServer } from "node:http";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { spawn } from "node:child_process";

// .env dosyasını oku ve process.env'e yükle (sadece set olmayan key'ler için)
(function loadEnv() {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  try {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.warn("[config] .env okunamadı:", e.message);
  }
})();

// PostgreSQL hazırlık notu: DATABASE_URL varsa pg paketi gerekir.
// import pg from 'pg'; // const { Pool } = pg;
// Şimdilik DATABASE_URL varsa uyarı ver, SQLite kullan.
if (process.env.DATABASE_URL) {
  console.warn(
    "[config] DATABASE_URL algılandı ancak pg paketi kurulmadığı için SQLite kullanılıyor.\n" +
    "         PostgreSQL entegrasyonu için: npm install pg"
  );
}

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8080);
const adminEmail = (process.env.ADMIN_EMAIL || "admin@subscript.local").toLowerCase();
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const dataDir = join(root, "data");
const usersFile = join(dataDir, "users.json");
const databaseFile = process.env.DATABASE_FILE
  ? resolve(root, process.env.DATABASE_FILE)
  : join(dataDir, "subscript.sqlite");

// ─── Veritabanı Kurulumu ──────────────────────────────────────────────────────
mkdirSync(dataDir, { recursive: true });
const database = new DatabaseSync(databaseFile);

database.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    level TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS email_verifications (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clip_id TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    first_try INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, clip_id, group_index)
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    window_start TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dictionary_cache (
    word TEXT PRIMARY KEY,
    meaning TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL
  );
`);

// users tablosuna email_verified, verified_at, plan, daily_clips_used sütunlarını ekle (zaten varsa yoksay)
try { database.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"); } catch {}
try { database.exec("ALTER TABLE users ADD COLUMN verified_at TEXT"); } catch {}
try { database.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'"); } catch {}
try { database.exec("ALTER TABLE users ADD COLUMN daily_clips_used INTEGER NOT NULL DEFAULT 0"); } catch {}
try { database.exec("ALTER TABLE users ADD COLUMN last_active_date TEXT"); } catch {}
try { database.exec("ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT 'violet'"); } catch {}

// ─── Yardımcı Fonksiyonlar ────────────────────────────────────────────────────
const json       = (file) => JSON.parse(readFileSync(file, "utf8"));
const send       = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
};
const readBody   = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
};
const publicUser = ({ password_hash, passwordHash, ...user }) => ({
  ...user,
  createdAt: user.created_at || user.createdAt,
  emailVerified: Boolean(user.email_verified),
  isAdmin: String(user.email || "").toLowerCase() === adminEmail,
  avatarColor: user.avatar_color || user.avatarColor || "violet",
  plan: user.plan || "free",
  dailyClipsUsed: user.daily_clips_used || 0
});
const hashPassword  = (password, salt = randomBytes(16).toString("hex")) =>
  `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const validPassword = (password, stored) => {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual         = scryptSync(password, salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer   = Buffer.from(actual,   "hex");
  return expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
};
const makeToken    = ()        => randomBytes(32).toString("hex");
const tokenHash    = (value)   => createHash("sha256").update(value).digest("hex");
const now          = ()        => new Date().toISOString();
const sessionExpiry = ()       => new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
const hourExpiry   = ()        => new Date(Date.now() + 3_600_000).toISOString();

// ─── Rate Limiter & Arka Plan İş Kuyruğu ───────────────────────────────────────
const rateLimitMap = new Map(); // key -> { count, windowStart }
const activeJobs   = new Map(); // jobId -> { id, status, logs, title, url, level }

function checkRateLimit(key, maxRequests = 10, windowMs = 60_000) {
  const nowMs = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, windowStart: nowMs };

  if (nowMs - entry.windowStart > windowMs) {
    rateLimitMap.set(key, { count: 1, windowStart: nowMs });
    return true;
  }

  if (entry.count >= maxRequests) return false;

  entry.count++;
  rateLimitMap.set(key, entry);
  return true;
}

function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0].trim();
}

// ─── E-posta Gönderimi (Yerleşik RFC SMTP & Dev Fallback) ──────────────────
async function sendEmail({ to, subject, html }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const from = process.env.SMTP_FROM || user || "noreply@subscript.local";

  if (!host) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`[DEV E-POSTA] Kime:    ${to}`);
    console.log(`[DEV E-POSTA] Konu:    ${subject}`);
    console.log(`[DEV E-POSTA] İçerik:\n${html}`);
    console.log(`${"─".repeat(60)}\n`);
    return { dev: true };
  }

  return new Promise((resolve) => {
    const isSecure = port === 465;
    const socket = isSecure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });

    let step = 0;
    let buffer = "";

    const write = (cmd) => socket.write(cmd + "\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop();

      for (const line of lines) {
        const code = line.slice(0, 3);
        if (line.charAt(3) === "-") continue;

        if (code === "220" && step === 0) {
          step++;
          write(`EHLO ${host}`);
        } else if (code === "250" && step === 1) {
          if (user && pass) {
            step++;
            write("AUTH LOGIN");
          } else {
            step = 5;
            write(`MAIL FROM:<${from}>`);
          }
        } else if (code === "334" && step === 2) {
          step++;
          write(Buffer.from(user).toString("base64"));
        } else if (code === "334" && step === 3) {
          step++;
          write(Buffer.from(pass).toString("base64"));
        } else if (code === "235" && step === 4) {
          step++;
          write(`MAIL FROM:<${from}>`);
        } else if (code === "250" && step === 5) {
          step++;
          write(`RCPT TO:<${to}>`);
        } else if (code === "250" && step === 6) {
          step++;
          write("DATA");
        } else if (code === "354" && step === 7) {
          step++;
          const emailData = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
            "MIME-Version: 1.0",
            "Content-Type: text/html; charset=UTF-8",
            "",
            html,
            "."
          ].join("\r\n");
          write(emailData);
        } else if (code === "250" && step === 8) {
          step++;
          write("QUIT");
          socket.end();
          console.log(`[SMTP] E-posta başarıyla iletildi ➔ ${to}`);
          resolve({ dev: false, success: true });
        } else if (parseInt(code) >= 400) {
          socket.destroy();
          console.error(`[SMTP HATASI] ${line}`);
          resolve({ dev: false, error: line });
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[SMTP BAĞLANTI HATASI]", err.message);
      resolve({ dev: false, error: err.message });
    });

    setTimeout(() => {
      socket.destroy();
      resolve({ dev: false, timeout: true });
    }, 10000);
  });
}

// ─── Veri Göçü (users.json → SQLite) ─────────────────────────────────────────
function migrateUsers() {
  const count = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0 || !existsSync(usersFile)) return;
  const users = json(usersFile);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password_hash, level, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const user of users) {
    insert.run(user.id, user.name, user.email, user.passwordHash, user.level || null, user.createdAt || now());
  }
}
migrateUsers();

// ─── Auth Yardımcıları ────────────────────────────────────────────────────────
function currentUser(req) {
  const value  = req.headers.authorization || "";
  const bearer = value.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return null;
  const session = database.prepare(`
    SELECT users.id, users.name, users.email, users.level, users.created_at,
           users.email_verified, users.verified_at, users.plan, users.daily_clips_used, users.last_active_date
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash(bearer), now());
  return session || null;
}

function createSession(userId) {
  const sessionToken = makeToken();
  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash(sessionToken), userId, sessionExpiry(), now());
  return sessionToken;
}

function findUserByEmail(email) {
  return database.prepare(`
    SELECT id, name, email, password_hash, level, created_at, email_verified, verified_at
    FROM users
    WHERE email = ?
  `).get(email);
}

function catalog() {
  return json(join(root, "clips.json"));
}

// ─── Sözlük Motoru ────────────────────────────────────────────────────────────
const BASE_DICTIONARY = {
  happens: "olmak, meydana gelmek",
  settle: "uzlaşmak, halletmek",
  irish: "İrlandalılar",
  bodies: "cesetler, bedenler",
  would: "istemek (-ecekti)",
  smart: "akıllı, zeki",
  amount: "miktar, tutar",
  relationship: "ilişki, bağ",
  history: "geçmiş, tarih",
  another: "bir diğeri, başka",
  privy: "haberdar, gizli ortak",
  unanimous: "oy birliğiyle",
  guess: "tahmin etmek",
  leads: "yol açmak, götürmek",
  three: "üç",
  always: "her zaman, daima",
  never: "asla, hiçbir zaman",
  sometimes: "bazen, ara sıra",
  because: "çünkü, zira",
  before: "önce, önceden",
  after: "sonra, ardından",
  believe: "inanmak, güvenmek",
  understand: "anlamak, kavramak",
  remember: "hatırlamak, anımsamak",
  forget: "unutmak",
  family: "aile",
  friend: "arkadaş, dost",
  business: "iş, ticaret, mesele",
  problem: "sorun, problem",
  reason: "sebep, neden, gerekçe",
  question: "soru, sorgulamak",
  answer: "cevap, yanıt vermek",
  decision: "karar",
  danger: "tehlike",
  secret: "sır, gizli",
  future: "gelecek",
  truth: "gerçek, hakikat",
  promise: "söz, söz vermek",
  people: "insanlar, halk",
  money: "para",
  power: "güç, iktidar",
  respect: "saygı, saygı duymak"
};

async function lookupWord(rawWord) {
  const word = String(rawWord || "").toLowerCase().replace(/[^a-z']/g, "").trim();
  if (!word) return null;

  // 1. Veritabanı önbelleği
  const cached = database.prepare("SELECT meaning FROM dictionary_cache WHERE word = ?").get(word);
  if (cached) return { word, meaning: cached.meaning, source: "cache" };

  // 2. Dahili temel sözlük
  if (BASE_DICTIONARY[word]) {
    const meaning = BASE_DICTIONARY[word];
    try {
      database.prepare("INSERT OR REPLACE INTO dictionary_cache (word, meaning, source, created_at) VALUES (?, ?, ?, ?)")
        .run(word, meaning, "builtin", now());
    } catch {}
    return { word, meaning, source: "builtin" };
  }

  // 3. Çevrimiçi çeviri API'si (MyMemory Fallback)
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|tr`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (res.ok) {
      const data = await res.json();
      const match = data?.responseData?.translatedText;
      if (match && match.toLowerCase() !== word) {
        try {
          database.prepare("INSERT OR REPLACE INTO dictionary_cache (word, meaning, source, created_at) VALUES (?, ?, ?, ?)")
            .run(word, match, "mymemory", now());
        } catch {}
        return { word, meaning: match, source: "mymemory" };
      }
    }
  } catch {}

  return { word, meaning: "bağlamdan çıkarınız", source: "fallback" };
}

// ─── API Router ───────────────────────────────────────────────────────────────
async function api(req, res, url) {
  const ip = getClientIp(req);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // ── GET /api/clips ─────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/clips") {
    const user = currentUser(req);
    return send(res, 200, {
      clips: catalog(),
      user: user ? publicUser(user) : null
    });
  }

  // ── GET /api/clips/:id ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/clips/")) {
    const id   = decodeURIComponent(url.pathname.slice("/api/clips/".length));
    const item = catalog().find((clip) => clip.id === id);
    if (!item) return send(res, 404, { error: "Klip bulunamadı." });
    const file = resolve(root, item.dataFile);
    if (relative(root, file).startsWith("..")) return send(res, 400, { error: "Geçersiz klip yolu." });
    return send(res, 200, json(file));
  }

  // ── GET /api/me ────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = currentUser(req);
    return user
      ? send(res, 200, { user: publicUser(user) })
      : send(res, 401, { error: "Oturum bulunamadı." });
  }

  // ── DELETE /api/auth/session ───────────────────────────────────────────────
  if (req.method === "DELETE" && url.pathname === "/api/auth/session") {
    const value  = req.headers.authorization || "";
    const bearer = value.replace(/^Bearer\s+/i, "").trim();
    if (bearer) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(bearer));
    return send(res, 204, {});
  }

  // ── POST /api/auth/register ────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    // Rate limit: IP başına 10 istek/dakika
    if (!checkRateLimit(`register:${ip}`, 10, 60_000)) {
      return send(res, 429, { error: "Çok fazla istek. Lütfen 1 dakika bekleyiniz." });
    }

    const body     = await readBody(req);
    const email    = String(body.email    || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name     = String(body.name     || "").trim();

    if (!name || !email.includes("@") || password.length < 8) {
      return send(res, 400, { error: "Ad, geçerli e-posta ve en az 8 karakterli şifre gerekli." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return send(res, 400, { error: "Geçerli bir e-posta adresi gerekli." });
    }
    if (findUserByEmail(email)) {
      return send(res, 409, { error: "Bu e-posta zaten kayıtlı." });
    }

    const userId = randomBytes(12).toString("hex");
    const createdAt = now();
    database.prepare(`
      INSERT INTO users (id, name, email, password_hash, level, created_at, email_verified)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(userId, name, email, hashPassword(password), null, createdAt);

    // E-posta doğrulama token'ı oluştur
    const verifyToken = makeToken();
    database.prepare(`
      INSERT INTO email_verifications (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(verifyToken, userId, hourExpiry(), createdAt);

    await sendEmail({
      to: email,
      subject: "subscript. — E-posta adresini doğrula",
      html: `<p>Merhaba ${name},</p><p>E-posta adresini doğrulamak için tıkla: <a href="${appUrl}/api/auth/verify-email?token=${verifyToken}">Doğrula</a></p><p>Bu link 1 saat geçerlidir.</p>`
    });

    const sessionToken = createSession(userId);
    const newUser = database.prepare(
      "SELECT id, name, email, level, created_at, email_verified, verified_at FROM users WHERE id = ?"
    ).get(userId);
    return send(res, 201, { token: sessionToken, user: publicUser(newUser) });
  }

  // ── POST /api/auth/login ───────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    // Rate limit: IP başına 5 istek/dakika (login için daha sıkı)
    if (!checkRateLimit(`login:${ip}`, 5, 60_000)) {
      return send(res, 429, { error: "Çok fazla istek. Lütfen 1 dakika bekleyiniz." });
    }

    const body = await readBody(req);
    const user = findUserByEmail(String(body.email || "").trim().toLowerCase());
    if (!user || !validPassword(String(body.password || ""), user.password_hash)) {
      return send(res, 401, { error: "E-posta veya şifre hatalı." });
    }
    const sessionToken = createSession(user.id);
    return send(res, 200, { token: sessionToken, user: publicUser(user) });
  }

  // ── GET /api/auth/verify-email?token=... ──────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/auth/verify-email") {
    const verifyToken = url.searchParams.get("token") || "";
    if (!verifyToken) return send(res, 400, { error: "Token gerekli." });

    const record = database.prepare(
      "SELECT * FROM email_verifications WHERE token = ?"
    ).get(verifyToken);

    if (!record) return send(res, 400, { error: "Geçersiz doğrulama token'ı." });
    if (record.expires_at < now()) {
      return send(res, 400, { error: "Bu doğrulama bağlantısı süresi dolmuş." });
    }

    const verifiedAt = now();
    database.prepare(
      "UPDATE users SET email_verified = 1, verified_at = ? WHERE id = ?"
    ).run(verifiedAt, record.user_id);
    database.prepare("DELETE FROM email_verifications WHERE token = ?").run(verifyToken);

    return send(res, 200, { success: true, message: "E-posta doğrulandı." });
  }

  // ── POST /api/auth/forgot-password ────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/auth/forgot-password") {
    if (!checkRateLimit(`forgot:${ip}`, 5, 60_000)) {
      return send(res, 429, { error: "Çok fazla istek. Lütfen 1 dakika bekleyiniz." });
    }

    const body  = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();

    // Kullanıcı bulunsun ya da bulunmasın aynı yanıtı dön (user enumeration önleme)
    const user = findUserByEmail(email);
    if (user) {
      const resetToken = makeToken();
      database.prepare(`
        INSERT INTO password_resets (token, user_id, expires_at, used, created_at)
        VALUES (?, ?, ?, 0, ?)
      `).run(resetToken, user.id, hourExpiry(), now());

      await sendEmail({
        to: email,
        subject: "subscript. — Şifrenizi sıfırlayın",
        html: `<p>Merhaba ${user.name},</p><p>Şifrenizi sıfırlamak için tıklayın: <a href="${appUrl}/reset-password?token=${resetToken}">Şifreyi Sıfırla</a></p><p>Bu link 1 saat geçerlidir. Eğer bu isteği siz yapmadıysanız bu e-postayı görmezden gelebilirsiniz.</p>`
      });
    }

    return send(res, 200, {
      success: true,
      message: "Eğer bu e-posta kayıtlıysa, sıfırlama bağlantısı gönderildi."
    });
  }

  // ── POST /api/auth/reset-password ─────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/auth/reset-password") {
    if (!checkRateLimit(`reset:${ip}`, 5, 60_000)) {
      return send(res, 429, { error: "Çok fazla istek. Lütfen 1 dakika bekleyiniz." });
    }

    const body       = await readBody(req);
    const resetToken = String(body.token    || "").trim();
    const password   = String(body.password || "");

    if (!resetToken) return send(res, 400, { error: "Token gerekli." });
    if (password.length < 8) return send(res, 400, { error: "Şifre en az 8 karakter olmalı." });

    const record = database.prepare(
      "SELECT * FROM password_resets WHERE token = ?"
    ).get(resetToken);

    if (!record)         return send(res, 400, { error: "Geçersiz şifre sıfırlama token'ı." });
    if (record.used)     return send(res, 400, { error: "Bu token zaten kullanılmış." });
    if (record.expires_at < now()) return send(res, 400, { error: "Bu bağlantının süresi dolmuş." });

    // Şifreyi güncelle
    database.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(hashPassword(password), record.user_id);
    // Token'ı kullanıldı olarak işaretle
    database.prepare("UPDATE password_resets SET used = 1 WHERE token = ?")
      .run(resetToken);
    // Kullanıcının tüm oturumlarını sil (güvenlik)
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(record.user_id);

    return send(res, 200, { success: true });
  }

  // ── POST /api/progress ────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/progress") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });

    const body       = await readBody(req);
    const clipId     = String(body.clipId     || "").trim();
    const groupIndex = Number(body.groupIndex ?? -1);
    const completed  = body.completed  ? 1 : 0;
    const firstTry   = body.firstTry   ? 1 : 0;
    const attempts   = Number(body.attempts   || 1);

    if (!clipId || groupIndex < 0) {
      return send(res, 400, { error: "clipId ve groupIndex gerekli." });
    }

    const existing = database.prepare(
      "SELECT id FROM user_progress WHERE user_id = ? AND clip_id = ? AND group_index = ?"
    ).get(user.id, clipId, groupIndex);

    if (existing) {
      database.prepare(`
        UPDATE user_progress
        SET completed = ?, first_try = ?, attempts = ?, updated_at = ?
        WHERE user_id = ? AND clip_id = ? AND group_index = ?
      `).run(completed, firstTry, attempts, now(), user.id, clipId, groupIndex);
    } else {
      database.prepare(`
        INSERT INTO user_progress (id, user_id, clip_id, group_index, completed, first_try, attempts, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomBytes(8).toString("hex"), user.id, clipId, groupIndex, completed, firstTry, attempts, now());
    }

    return send(res, 200, { success: true });
  }

  // ── GET /api/progress/:clipId ──────────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/progress/")) {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });

    const clipId = decodeURIComponent(url.pathname.slice("/api/progress/".length));
    const rows   = database.prepare(`
      SELECT group_index, completed, first_try, attempts, updated_at
      FROM user_progress
      WHERE user_id = ? AND clip_id = ?
      ORDER BY group_index ASC
    `).all(user.id, clipId);

    return send(res, 200, { progress: rows });
  }

  // ── GET /api/stats ────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/stats") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });

    const rows = database.prepare(`
      SELECT completed, first_try, attempts, updated_at
      FROM user_progress
      WHERE user_id = ?
      ORDER BY updated_at ASC
    `).all(user.id);

    const totalCompleted = rows.filter((r) => r.completed).length;
    const totalAttempts  = rows.reduce((acc, r) => acc + (r.attempts || 1), 0);
    const firstTryCount  = rows.filter((r) => r.first_try).length;
    const accuracy       = totalCompleted > 0
      ? Math.round((firstTryCount / totalCompleted) * 100)
      : 0;

    // Her tamamlanan group yaklaşık 1.5 dakika = pratik tahmin
    const totalMinutes = +(totalCompleted * 1.5).toFixed(1);

    // Basit streak hesabı: ardışık günlerde tamamlanan bölüm var mı?
    let currentStreak = 0;
    const daySet = new Set(
      rows
        .filter((r) => r.completed)
        .map((r) => r.updated_at.slice(0, 10))
    );
    const today    = new Date();
    let checkDate  = new Date(today);
    while (daySet.has(checkDate.toISOString().slice(0, 10))) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    // Basit puan: tamamlanan her group 10 puan, ilk denemede 5 bonus
    const totalPoints = totalCompleted * 10 + firstTryCount * 5;

    return send(res, 200, {
      totalCompleted,
      accuracy,
      totalMinutes,
      currentStreak,
      totalPoints
    });
  }

  // ── POST /api/profile/level ───────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/profile/level") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const level = String((await readBody(req)).level || "").toUpperCase();
    if (!["A1", "A2", "B1", "B2", "C1"].includes(level)) {
      return send(res, 400, { error: "Geçersiz seviye." });
    }
    database.prepare("UPDATE users SET level = ? WHERE id = ?").run(level, user.id);
    const updatedUser = database.prepare(
      "SELECT id, name, email, level, created_at, email_verified, verified_at FROM users WHERE id = ?"
    ).get(user.id);
    return send(res, 200, { user: publicUser(updatedUser) });
  }

  // ── POST /api/profile/favorite-media ───────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/profile/favorite-media") {
    const body = await readBody(req);
    const media = String(body.media || "").trim();
    const user = currentUser(req);
    if (media) {
      const requestsFile = join(dataDir, "media_requests.json");
      let requests = [];
      try {
        if (existsSync(requestsFile)) requests = JSON.parse(readFileSync(requestsFile, "utf8"));
      } catch {}
      requests.push({
        media,
        userId: user?.id || null,
        userEmail: user?.email || null,
        date: new Date().toISOString()
      });
      writeFileSync(requestsFile, JSON.stringify(requests, null, 2), "utf8");
    }
    return send(res, 200, { ok: true, saved: media });
  }

  // ── POST /api/admin/clips ─────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/admin/clips") {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) {
      return send(res, 403, { error: "Bu işlem yalnızca admin içindir." });
    }
    const body     = await readBody(req);
    const required = ["id", "title", "level", "youtubeId", "dataFile"];
    if (required.some((key) => !body[key])) {
      return send(res, 400, { error: "id, title, level, youtubeId ve dataFile gerekli." });
    }
    const clips = catalog();
    if (clips.some((clip) => clip.id === body.id)) {
      return send(res, 409, { error: "Bu klip id'si zaten kullanılıyor." });
    }
    const item = {
      id:        String(body.id),
      title:     String(body.title),
      level:     String(body.level).toUpperCase(),
      youtubeId: String(body.youtubeId),
      dataFile:  String(body.dataFile)
    };
    writeFileSync(join(root, "clips.json"), JSON.stringify([...clips, item], null, 2) + "\n");
    return send(res, 201, { clip: item });
  }

  // ── DELETE /api/admin/clips/:id ───────────────────────────────────────────
  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/clips/")) {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) {
      return send(res, 403, { error: "Bu işlem yalnızca admin içindir." });
    }
    const id = decodeURIComponent(url.pathname.slice("/api/admin/clips/".length));
    const clips = catalog();
    const filtered = clips.filter((c) => c.id !== id);
    if (clips.length === filtered.length) {
      return send(res, 404, { error: "Klip bulunamadı." });
    }
    writeFileSync(join(root, "clips.json"), JSON.stringify(filtered, null, 2) + "\n");
    return send(res, 200, { success: true, remaining: filtered.length });
  }

  // ── PUT /api/admin/clips/:id (Cümle & Klip Düzenleme) ──────────────────────
  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/clips/")) {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) {
      return send(res, 403, { error: "Bu işlem yalnızca admin içindir." });
    }
    const id = decodeURIComponent(url.pathname.slice("/api/admin/clips/".length));
    const clips = catalog();
    const item = clips.find((clip) => clip.id === id);
    if (!item) return send(res, 404, { error: "Klip bulunamadı." });

    const file = resolve(root, item.dataFile);
    if (relative(root, file).startsWith("..")) return send(res, 400, { error: "Geçersiz dosya yolu." });
    if (!existsSync(file)) return send(res, 404, { error: "Klip veri dosyası bulunamadı." });

    const body = await readBody(req);
    const existingData = json(file);

    if (Array.isArray(body.groups)) {
      existingData.groups = body.groups;

      const totalSentences = body.groups.reduce((acc, g) => acc + (g.sentences ? g.sentences.length : 0), 0);
      const catIdx = clips.findIndex((c) => c.id === id);
      if (catIdx !== -1) {
        clips[catIdx].sentenceCount = totalSentences;
        clips[catIdx].groupCount = body.groups.length;
        if (body.title) clips[catIdx].title = String(body.title);
        if (body.level) clips[catIdx].level = String(body.level).toUpperCase();
        writeFileSync(join(root, "clips.json"), JSON.stringify(clips, null, 2) + "\n");
      }

      // TXT transkriptini de güncelle
      try {
        const txtFile = file.replace(/\.json$/, ".txt");
        const allSentenceTexts = [];
        for (const g of body.groups) {
          if (Array.isArray(g.sentences)) {
            for (const s of g.sentences) {
              if (s.text) allSentenceTexts.push(s.text);
            }
          }
        }
        writeFileSync(txtFile, allSentenceTexts.join("\n"), "utf8");
      } catch {}
    }

    if (body.title) existingData.title = String(body.title);
    if (body.level) existingData.level = String(body.level).toUpperCase();

    writeFileSync(file, JSON.stringify(existingData, null, 2) + "\n", "utf8");
    return send(res, 200, { success: true, message: "Klip başarıyla güncellendi.", clip: existingData });
  }

  // ── GET /api/admin/overview ───────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/admin/overview") {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) {
      return send(res, 403, { error: "Yetkisiz erişim." });
    }
    const totalUsers = database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const verifiedUsers = database.prepare("SELECT COUNT(*) AS count FROM users WHERE email_verified = 1").get().count;
    const totalProgress = database.prepare("SELECT COUNT(*) AS count FROM user_progress WHERE completed = 1").get().count;
    const clips = catalog();
    const recentUsers = database.prepare(
      "SELECT id, name, email, level, plan, email_verified, created_at FROM users ORDER BY created_at DESC LIMIT 8"
    ).all();

    return send(res, 200, {
      totalUsers,
      verifiedUsers,
      totalProgress,
      clipCount: clips.length,
      clips,
      recentUsers
    });
  }

  // ── GET /api/dictionary/:word ─────────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/dictionary/")) {
    const word = decodeURIComponent(url.pathname.slice("/api/dictionary/".length));
    const result = await lookupWord(word);
    if (!result) return send(res, 400, { error: "Kelime belirtilmedi." });
    return send(res, 200, result);
  }

  // ── GET /api/subscription/plans ───────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/subscription/plans") {
    return send(res, 200, {
      plans: [
        {
          id: "free",
          name: "Ücretsiz",
          price: "0₺",
          features: ["Günde 2 klip çalışma hakkı", "Temel ipucu desteği", "3 günlük streak takibi"],
          isCurrent: true
        },
        {
          id: "pro_monthly",
          name: "Pro Aylık",
          price: "99₺ / ay",
          features: ["Sınırsız klip & dizi sahnesi", "Gelişmiş AI ses dalgası & yavaşlatma", "Kişisel kelime bankası & SRS tekrarı", "Öncelikli yeni bölüm bildirimleri"],
          badge: "Popüler"
        },
        {
          id: "pro_yearly",
          name: "Pro Yıllık",
          price: "799₺ / yıl",
          discount: "%33 Tasarruf",
          features: ["Tüm Pro özellikleri", "2 ay ücretsiz", "İleri CEFR C1/C2 özel klipleri"]
        }
      ]
    });
  }

  // ── POST /api/subscription/upgrade ────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/subscription/upgrade") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const body = await readBody(req);
    const plan = body.plan || "pro";

    database.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, user.id);
    return send(res, 200, {
      success: true,
      message: "Tebrikler! Pro plana başarıyla geçiş yaptınız.",
      plan
    });
  }

  // ── POST /api/subscription/create-checkout-session ────────────────────────
  if (req.method === "POST" && url.pathname === "/api/subscription/create-checkout-session") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const body = await readBody(req);
    const plan = body.plan || "pro_monthly";
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (!stripeKey) {
      return send(res, 200, {
        simulated: true,
        message: "Stripe API anahtarı (.env STRIPE_SECRET_KEY) tanımlı değil."
      });
    }

    try {
      const priceAmount = plan === "pro_yearly" ? 79900 : 9900;
      const params = new URLSearchParams({
        "success_url": `${appUrl}/profil?payment=success`,
        "cancel_url": `${appUrl}/profil?payment=cancelled`,
        "payment_method_types[0]": "card",
        "mode": "payment",
        "customer_email": user.email,
        "line_items[0][price_data][currency]": "try",
        "line_items[0][price_data][unit_amount]": String(priceAmount),
        "line_items[0][price_data][product_data][name]": `subscript. ${plan === "pro_yearly" ? "Pro Yıllık" : "Pro Aylık"}`,
        "line_items[0][quantity]": "1"
      });

      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });

      const session = await stripeRes.json();
      if (!stripeRes.ok) {
        return send(res, 400, { error: session.error?.message || "Stripe oturumu oluşturulamadı." });
      }
      return send(res, 200, { url: session.url, simulated: false });
    } catch (e) {
      return send(res, 500, { error: "Stripe bağlantı hatası: " + e.message });
    }
  }

  // ── POST /api/profile/update ──────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/profile/update") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return send(res, 400, { error: "İsim boş bırakılamaz." });
    const avatarColors = new Set(["violet", "ocean", "sunset", "mint", "rose", "slate"]);
    const avatarColor = String(body.avatarColor || user.avatar_color || "violet");
    if (!avatarColors.has(avatarColor)) {
      return send(res, 400, { error: "Geçersiz avatar rengi." });
    }

    database.prepare("UPDATE users SET name = ?, avatar_color = ? WHERE id = ?").run(name, avatarColor, user.id);
    const updated = database.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    return send(res, 200, { success: true, user: publicUser(updated) });
  }

  // ── POST /api/profile/password ────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/profile/password") {
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: "Giriş yapmalısın." });
    const body = await readBody(req);
    const currentPass = String(body.currentPassword || "");
    const newPass = String(body.newPassword || "");

    if (newPass.length < 8) {
      return send(res, 400, { error: "Yeni şifre en az 8 karakter olmalıdır." });
    }

    const fullUser = database.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
    if (!validPassword(currentPass, fullUser.password_hash)) {
      return send(res, 400, { error: "Mevcut şifreniz hatalı." });
    }

    database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPass), user.id);
    return send(res, 200, { success: true, message: "Şifreniz başarıyla güncellendi." });
  }

  // ── POST /api/admin/transcribe ────────────────────────────────────────────
  if (req.method === "POST" && (path === "/api/admin/transcribe" || url.pathname === "/api/admin/transcribe")) {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) {
      return send(res, 403, {
        error: `Yalnızca admin (${adminEmail}) yetkisiyle video işlenebilir. Lütfen bu e-posta ile giriş yapınız.`
      });
    }
    const body = await readBody(req);
    const urlParam = String(body.url || "").trim();
    const title = String(body.title || "").trim();
    const level = String(body.level || "B1").toUpperCase();

    if (!urlParam.includes("youtube.com") && !urlParam.includes("youtu.be")) {
      return send(res, 400, { error: "Geçerli bir YouTube video bağlantısı giriniz." });
    }
    if (!title) {
      return send(res, 400, { error: "Klip başlığı gereklidir." });
    }

    const jobId = randomBytes(8).toString("hex");
    const job = { id: jobId, status: "processing", logs: [], title, url: urlParam, level, createdAt: now() };
    activeJobs.set(jobId, job);

    // Arka planda Python transcribe.py motorunu başlat
    const pythonCmd = process.env.PYTHON || "python";
    const py = spawn(pythonCmd, ["transcribe.py", "--url", urlParam, "--title", title], {
      cwd: root
    });

    py.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) job.logs.push(text);
    });

    py.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text && !text.includes("warning")) job.logs.push(text);
    });

    py.on("close", (code) => {
      if (code === 0) {
        job.status = "completed";
        // Eklenen klibin seviyesini güncelle
        try {
          const clips = catalog();
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const item = clips.find((c) => c.id === slug);
          if (item) {
            item.level = level;
            writeFileSync(join(root, "clips.json"), JSON.stringify(clips, null, 2) + "\n");
          }
        } catch {}
      } else {
        job.status = "failed";
        job.error = `İşlem hata koduyla kapandı: ${code}`;
      }
    });

    return send(res, 202, { jobId, status: "processing", message: "Yapay zeka transkripsiyonu başlatıldı." });
  }

  // ── GET /api/admin/jobs/:jobId ────────────────────────────────────────────
  if (req.method === "GET" && (path.startsWith("/api/admin/jobs/") || url.pathname.startsWith("/api/admin/jobs/"))) {
    const user = currentUser(req);
    if (!user || user.email !== adminEmail) {
      return send(res, 403, { error: "Yetkisiz erişim." });
    }
    const jobId = (path.startsWith("/api/admin/jobs/") ? path : url.pathname).slice("/api/admin/jobs/".length);
    const job = activeJobs.get(jobId);
    if (!job) return send(res, 404, { error: "İşlem bulunamadı." });
    return send(res, 200, job);
  }

  // ── GET /api/config/auth ──────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/config/auth") {
    return send(res, 200, {
      googleClientId: process.env.GOOGLE_CLIENT_ID || ""
    });
  }

  // ── POST /api/auth/google ─────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/auth/google") {
    const body = await readBody(req);
    const credential = String(body.credential || "").trim();

    if (!credential) {
      return send(res, 400, { error: "Google doğrulama belirteci eksik." });
    }

    let email = "";
    let name = "Google Kullanıcısı";

    // 1. Google tokeninfo API doğrulaması
    try {
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
        signal: AbortSignal.timeout(4000)
      });
      if (verifyRes.ok) {
        const payload = await verifyRes.json();
        email = String(payload.email || "").toLowerCase().trim();
        name = String(payload.name || payload.given_name || name).trim();
      }
    } catch (e) {
      console.warn("[google-auth] tokeninfo sorgu hatası:", e.message);
    }

    // 2. Fallback: JWT payload decode
    if (!email) {
      try {
        const parts = credential.split(".");
        if (parts.length === 3) {
          const decoded = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
          if (decoded.email) {
            email = String(decoded.email).toLowerCase().trim();
            name = String(decoded.name || name).trim();
          }
        }
      } catch {}
    }

    if (!email) {
      return send(res, 400, { error: "Google hesabından geçerli e-posta alınamadı." });
    }

    let user = findUserByEmail(email);
    if (!user) {
      const id = randomBytes(12).toString("hex");
      const dummyPass = randomBytes(16).toString("hex");
      database.prepare(`
        INSERT INTO users (id, name, email, password_hash, level, email_verified, verified_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, name, email, hashPassword(dummyPass), null, now(), now());
      user = database.prepare("SELECT * FROM users WHERE id = ?").get(id);
    }

    const sessionToken = createSession(user.id);
    return send(res, 200, { token: sessionToken, user: publicUser(user) });
  }

  // ── POST /api/auth/oauth ──────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/auth/oauth") {
    const body = await readBody(req);
    const provider = String(body.provider || "google").toLowerCase();
    const email = String(body.email || `user_${randomBytes(4).toString("hex")}@${provider}.local`).toLowerCase();
    const name = String(body.name || `${provider.toUpperCase()} Kullanıcısı`).trim();

    let user = findUserByEmail(email);
    if (!user) {
      const id = randomBytes(12).toString("hex");
      const dummyPass = randomBytes(16).toString("hex");
      database.prepare(`
        INSERT INTO users (id, name, email, password_hash, level, email_verified, verified_at, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, name, email, hashPassword(dummyPass), null, now(), now());
      user = database.prepare("SELECT * FROM users WHERE id = ?").get(id);
    }

    const sessionToken = createSession(user.id);
    return send(res, 200, { token: sessionToken, user: publicUser(user) });
  }

  return send(res, 404, { error: "API endpoint bulunamadı." });
}

// ─── Statik Dosya Sunucu ──────────────────────────────────────────────────────
function staticFile(req, res, url) {
  const requested = url.pathname === "/admin" ? "/index.html" : url.pathname === "/" ? "/landing.html" : url.pathname === "/ogren" ? "/index.html" : url.pathname;
  const file      = resolve(root, "." + normalize(requested));
  if (relative(root, file).startsWith("..")) return send(res, 403, { error: "Forbidden" });

  // Hassas dosyaların ve veritabanının doğrudan indirilmesini engelle
  const blocked = [".env", ".sqlite", ".db", ".py", "users.json"];
  if (blocked.some((b) => file.toLowerCase().includes(b))) {
    return send(res, 403, { error: "Forbidden" });
  }
  if (!existsSync(file)) {
    if (!extname(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(root, "index.html")));
    }
    return send(res, 404, { error: "Dosya bulunamadı." });
  }
  const types = {
    ".html": "text/html",
    ".js":   "text/javascript",
    ".css":  "text/css",
    ".json": "application/json"
  };
  res.writeHead(200, {
    "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`
  });
  res.end(readFileSync(file));
}

// ─── HTTP Sunucusu ────────────────────────────────────────────────────────────
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "Sunucu hatası." });
  }
}).listen(port, () => console.log(`subscript API: http://localhost:${port}`));
