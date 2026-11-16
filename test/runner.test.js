import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8089;
const BASE_URL = `http://localhost:${PORT}`;
const testDatabaseFile = join(tmpdir(), `subscript.test.${Date.now()}.${process.pid}.sqlite`);

let serverProcess = null;

// Test ortamı başlatma
test.before(async () => {
  await new Promise((resolve, reject) => {
    serverProcess = spawn("node", ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        ADMIN_EMAIL: "admin@subscript.local",
        APP_URL: BASE_URL,
        DATABASE_FILE: testDatabaseFile,
        STRIPE_WEBHOOK_SECRET: "whsec_test_only",
        NODE_ENV: "test"
      },
      stdio: "pipe"
    });

    serverProcess.stdout.on("data", (data) => {
      if (data.toString().includes(`http://localhost:${PORT}`)) {
        resolve();
      }
    });

    serverProcess.stderr.on("data", (err) => {
      // warningleri yut
    });

    serverProcess.on("error", reject);
    setTimeout(resolve, 3000); // fallback timeout
  });
});

test.after(async () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

// Yardımcı İstek Fonksiyonu
async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

function sessionCookie(response) {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "Başarılı oturum yanıtı HttpOnly cookie göndermeli.");
  assert.match(header, /HttpOnly/);
  return header.match(/subscript_token=([^;]+)/)[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// BÖLÜM 1: REGRESYON TESTLERİ (Mevcut Temel Özellikler)
// ─────────────────────────────────────────────────────────────────────────────
test("REGRESYON: Statik sayfalar ve SPA fallback doğru servis edilmeli", async () => {
  const index = await fetch(`${BASE_URL}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /subscript\./);
  assert.equal(index.headers.get("x-content-type-options"), "nosniff");
  assert.match(index.headers.get("x-request-id") || "", /^[a-f0-9]{16}$/);
  assert.equal(index.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(index.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(index.headers.get("x-frame-options"), "DENY");
  assert.equal(index.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");

  const health = await req("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.data.status, "ok");

  const admin = await fetch(`${BASE_URL}/admin.html`, { redirect: "manual" });
  assert.equal(admin.status, 302);
  assert.equal(admin.headers.get("location"), "/");
  const adminRoute = await fetch(`${BASE_URL}/admin`, { redirect: "manual" });
  assert.equal(adminRoute.status, 302);
  assert.equal(adminRoute.headers.get("location"), "/");

  // Hassas dosyalara doğrudan erişim engellenmeli (403 Forbidden)
  const forbidden = await fetch(`${BASE_URL}/data/subscript.sqlite`);
  assert.equal(forbidden.status, 403);

  const envForbidden = await fetch(`${BASE_URL}/.env`);
  assert.equal(envForbidden.status, 403);

  const adminSource = readFileSync(join(root, "admin.html"), "utf8");
  assert.doesNotMatch(adminSource, /localStorage\.getItem\("subscript_token"/);
});

test("REGRESYON: Klip kataloğu ve klip veri dosyaları eksiksiz dönmeli", async () => {
  const res = await req("/api/clips");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.clips));
  assert.ok(res.data.clips.length >= 5);

  const firstClip = res.data.clips[0];
  const clipDetail = await req(`/api/clips/${firstClip.id}`);
  assert.equal(clipDetail.status, 200);
  assert.equal(clipDetail.data.title, firstClip.title);
  assert.ok(Array.isArray(clipDetail.data.groups));
  assert.ok(clipDetail.data.groups.length > 0);

  // Varolmayan klip 404
  const notFound = await req("/api/clips/olmayan-klip-999");
  assert.equal(notFound.status, 404);
});

test("REGRESYON: Kullanıcı Kaydı & Giriş Validasyonları", async () => {
  // Bozuk JSON gövdesi 500 yerine açıklayıcı 400 dönmeli
  const malformedJson = await req("/api/auth/register", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.10" },
    body: "{\"name\":\"Ali\","
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.data.error, "Geçersiz JSON gövdesi.");

  // Geçersiz e-posta
  const badEmail = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ali", email: "gecersiz", password: "password123" })
  });
  assert.equal(badEmail.status, 400);

  // Kısa şifre (<8)
  const shortPass = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ali", email: "ali@test.com", password: "123" })
  });
  assert.equal(shortPass.status, 400);

  // Başarılı kayıt
  const randomEmail = `user_${Date.now()}@test.com`;
  const registerRes = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ali Test", email: randomEmail, password: "password123" })
  });
  assert.equal(registerRes.status, 201);
  assert.equal(registerRes.data.token, undefined);
  assert.ok(sessionCookie(registerRes));
  assert.equal(registerRes.data.user.email, randomEmail);

  // Mükerrer e-posta ile kayıt (409 Conflict)
  const duplicate = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ali Test", email: randomEmail, password: "password123" })
  });
  assert.equal(duplicate.status, 409);

  // Hatalı şifre ile giriş (401)
  const wrongLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ name: "Ali Test", password: "wrong_password" })
  });
  assert.equal(wrongLogin.status, 401);

  // Doğru şifre ile giriş (200)
  const validLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ name: "Ali Test", password: "password123" })
  });
  assert.equal(validLogin.status, 200);
  const loginCookie = sessionCookie(validLogin);

  // /api/me oturum kontrolü
  const meRes = await req("/api/me", {
    headers: { Cookie: `subscript_token=${loginCookie}` }
  });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.data.user.email, randomEmail);

  // Oturumu kapatma
  const logoutRes = await req("/api/auth/session", {
    method: "DELETE",
    headers: { Cookie: `subscript_token=${loginCookie}`, Origin: BASE_URL }
  });
  assert.equal(logoutRes.status, 204);

  // Kapatılan oturumla /api/me (401)
  const meAfterLogout = await req("/api/me", {
    headers: { Cookie: `subscript_token=${loginCookie}` }
  });
  assert.equal(meAfterLogout.status, 401);
});

test("REGRESYON: Cookie oturumları CSRF ve büyük gövdelere karşı korunmalı", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "CSRF User", email: `csrf_${Date.now()}@test.com`, password: "password123" })
  });
  const token = sessionCookie(reg);

  const crossSiteUpdate = await req("/api/profile/level", {
    method: "POST",
    headers: { Cookie: `subscript_token=${token}`, Origin: "https://attacker.example" },
    body: JSON.stringify({ level: "B2" })
  });
  assert.equal(crossSiteUpdate.status, 403);

  const sameOriginUpdate = await req("/api/profile/level", {
    method: "POST",
    headers: { Cookie: `subscript_token=${token}`, Origin: BASE_URL },
    body: JSON.stringify({ level: "B2" })
  });
  assert.equal(sameOriginUpdate.status, 200);

  const oversized = await req("/api/auth/register", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.77" },
    body: JSON.stringify({ name: "x".repeat(1_000_001), email: "large@test.com", password: "password123" })
  });
  assert.equal(oversized.status, 413);
});

test("SPRINT 1: Kimlik doğrulama endpoint'leri rate limit uygulamalı", async () => {
  const ip = "198.51.100.88";
  for (let index = 0; index < 5; index += 1) {
    const login = await req("/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": ip },
      body: JSON.stringify({ name: "Olmayan Kullanıcı", password: "wrong_password" })
    });
    assert.equal(login.status, 401);
  }
  const blockedLogin = await req("/api/auth/login", {
    method: "POST",
    headers: { "X-Forwarded-For": ip },
    body: JSON.stringify({ name: "Olmayan Kullanıcı", password: "wrong_password" })
  });
  assert.equal(blockedLogin.status, 429);

  const resetIp = "198.51.100.89";
  for (let index = 0; index < 5; index += 1) {
    const forgot = await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "X-Forwarded-For": resetIp },
      body: JSON.stringify({ email: `unknown_${index}@test.com` })
    });
    assert.equal(forgot.status, 200);
  }
  const blockedReset = await req("/api/auth/forgot-password", {
    method: "POST",
    headers: { "X-Forwarded-For": resetIp },
    body: JSON.stringify({ email: "unknown_blocked@test.com" })
  });
  assert.equal(blockedReset.status, 429);

  const registrationIp = "198.51.100.90";
  for (let index = 0; index < 10; index += 1) {
    const register = await req("/api/auth/register", {
      method: "POST",
      headers: { "X-Forwarded-For": registrationIp },
      body: JSON.stringify({
        name: `Limit User ${index}`,
        email: `limit_${Date.now()}_${index}@test.com`,
        password: "password123"
      })
    });
    assert.equal(register.status, 201);
  }
  const blockedRegistration = await req("/api/auth/register", {
    method: "POST",
    headers: { "X-Forwarded-For": registrationIp },
    body: JSON.stringify({ name: "Limit User Blocked", email: `limit_blocked_${Date.now()}@test.com`, password: "password123" })
  });
  assert.equal(blockedRegistration.status, 429);
});

test("SPRINT 1: Şifre değişikliği eski oturumları geçersiz kılmalı", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.91" },
    body: JSON.stringify({ name: "Password Session User", email: `password_session_${Date.now()}@test.com`, password: "old_password123" })
  });
  const oldToken = sessionCookie(reg);

  const update = await req("/api/profile/password", {
    method: "POST",
    headers: { Authorization: `Bearer ${oldToken}` },
    body: JSON.stringify({ currentPassword: "old_password123", newPassword: "new_password123" })
  });
  assert.equal(update.status, 200);
  const newToken = sessionCookie(update);
  assert.notEqual(newToken, oldToken);

  const oldSession = await req("/api/me", { headers: { Authorization: `Bearer ${oldToken}` } });
  assert.equal(oldSession.status, 401);
  const newSession = await req("/api/me", { headers: { Cookie: `subscript_token=${newToken}` } });
  assert.equal(newSession.status, 200);
});

test("REGRESYON: Profil CEFR seviyesi güncelleme", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Seviye Testi", email: `level_${Date.now()}@test.com`, password: "password123" })
  });
  const token = sessionCookie(reg);

  // Geçersiz seviye (400)
  const badLevel = await req("/api/profile/level", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ level: "Z9" })
  });
  assert.equal(badLevel.status, 400);

  // Geçerli seviye B2
  const validLevel = await req("/api/profile/level", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ level: "B2" })
  });
  assert.equal(validLevel.status, 200);
  assert.equal(validLevel.data.user.level, "B2");

  const avatarUpdate = await req("/api/profile/update", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: JSON.stringify({ name: "Seviye Testi", avatarColor: "ocean" })
  });
  assert.equal(avatarUpdate.status, 200);
  assert.equal(avatarUpdate.data.user.avatarColor, "ocean");

  const invalidAvatar = await req("/api/profile/update", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: JSON.stringify({ name: "Seviye Testi", avatarColor: "not-a-color" })
  });
  assert.equal(invalidAvatar.status, 400);

  const invalidName = await req("/api/profile/update", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: JSON.stringify({ name: "x".repeat(81), avatarColor: "ocean" })
  });
  assert.equal(invalidName.status, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// BÖLÜM 2: SPRINT 1 TESTLERİ (Kritik Yeni Özellikler)
// ─────────────────────────────────────────────────────────────────────────────
test("SPRINT 1: Kullanıcı ilerlemesi (Progress) kaydetme ve İstatistik (Stats) hesaplama", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Progress User", email: `prog_${Date.now()}@test.com`, password: "password123" })
  });
  const token = sessionCookie(reg);

  // 1. Parça Tamamlama (İlk denemede doğru)
  const p1 = await req("/api/progress", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clipId: "the-office", groupIndex: 0, completed: true, firstTry: true, attempts: 1 })
  });
  assert.equal(p1.status, 200);
  assert.equal(p1.data.success, true);

  // 2. Parça Tamamlama (İkinci denemede doğru)
  const p2 = await req("/api/progress", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clipId: "the-office", groupIndex: 1, completed: true, firstTry: false, attempts: 2 })
  });
  assert.equal(p2.status, 200);

  const invalidClipProgress = await req("/api/progress", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clipId: "unknown-clip", groupIndex: 0, completed: true, firstTry: true, attempts: 1 })
  });
  assert.equal(invalidClipProgress.status, 400);

  const invalidAttemptProgress = await req("/api/progress", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clipId: "the-office", groupIndex: 0, completed: true, firstTry: true, attempts: 101 })
  });
  assert.equal(invalidAttemptProgress.status, 400);

  // İlerleme listesini çekme
  const clipProg = await req("/api/progress/the-office", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(clipProg.status, 200);
  assert.equal(clipProg.data.progress.length, 2);

  // İstatistikleri hesaplama
  const stats = await req("/api/stats", {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.totalCompleted, 2);
  assert.equal(stats.data.accuracy, 50); // 1 tanesi firstTry
  assert.equal(stats.data.currentStreak, 1);
  assert.equal(stats.data.totalPoints, 25); // 2*10 + 1*5 = 25 puan
  assert.equal(stats.data.lastProgress.clipId, "the-office");
  assert.equal(stats.data.lastProgress.groupIndex, 1);
  assert.match(stats.data.lastProgress.clipTitle, /office/i);
});

test("SPRINT 1: Ücretsiz plan günlük iki farklı kliple sınırlandırılmalı", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Kota User", email: `quota_${Date.now()}@test.com`, password: "password123" })
  });
  const token = sessionCookie(reg);
  const progress = (clipId) => req("/api/progress", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clipId, groupIndex: 0, completed: true, firstTry: true, attempts: 1 })
  });

  assert.equal((await progress("the-office")).status, 200);
  assert.equal((await progress("breaking-bad")).status, 200);
  const overQuota = await progress("sons-of-anarchy");
  assert.equal(overQuota.status, 403);
  assert.match(overQuota.data.error, /günlük 2 klip/i);
});

test("SPRINT 1: Şifre Sıfırlama (Forgot & Reset Password) Tam Akışı", async () => {
  const email = `reset_${Date.now()}@test.com`;
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Reset User", email, password: "old_password123" })
  });

  // Şifre sıfırlama linki talebi
  const forgot = await req("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email })
  });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.data.success, true);

  // Production yanıtında token verilmez; test ortamı akışı doğrulamak için verir.
  assert.ok(forgot.data.resetToken);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(testDatabaseFile);
  const resetRow = db.prepare("SELECT token FROM password_resets ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(resetRow && resetRow.token);
  assert.notEqual(resetRow.token, forgot.data.resetToken);

  // Yeni şifreyi belirleme
  const resetRes = await req("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token: forgot.data.resetToken, password: "new_password999" })
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.success, true);

  // Eski şifreyle giriş başarısız olmalı
  const oldLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ name: "Reset User", password: "old_password123" })
  });
  assert.equal(oldLogin.status, 401);

  // Yeni şifreyle giriş başarılı olmalı
  const newLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ name: "Reset User", password: "new_password999" })
  });
  assert.equal(newLogin.status, 200);
  assert.ok(sessionCookie(newLogin));
});

// ─────────────────────────────────────────────────────────────────────────────
// BÖLÜM 3: SPRINT 2 TESTLERİ (Yüksek Öncelikli Özellikler)
// ─────────────────────────────────────────────────────────────────────────────
test("SPRINT 2: Dinamik Sözlük API ve Önbellek Doğrulaması", async () => {
  // 1. Yerleşik kelime sorgusu
  const res1 = await req("/api/dictionary/smart");
  assert.equal(res1.status, 200);
  assert.equal(res1.data.word, "smart");
  assert.match(res1.data.meaning, /akıllı|zeki/);

  // 2. Çevrimiçi/Harici kelime sorgusu
  const res2 = await req("/api/dictionary/extraordinary");
  assert.equal(res2.status, 200);
  assert.equal(res2.data.word, "extraordinary");
  assert.ok(res2.data.meaning.length > 0);

  // 3. Tekrar sorgulandığında cache'den gelmeli
  const res3 = await req("/api/dictionary/smart");
  assert.equal(res3.status, 200);
  assert.equal(res3.data.source, "cache");
});

test("SPRINT 2: Abonelik Planları ödeme doğrulaması olmadan değişmemeli", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Sub User", email: `sub_${Date.now()}@test.com`, password: "password123" })
  });
  const token = sessionCookie(reg);

  // Plan listesi
  const plans = await req("/api/subscription/plans");
  assert.equal(plans.status, 200);
  assert.equal(plans.data.plans.length, 3);
  assert.equal(plans.data.plans[0].id, "free");

  // Kullanıcı başlangıçta 'free' planda olmalı
  const me = await req("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.data.user.plan, "free");

  // Eski doğrudan yükseltme endpoint'i kapalı olmalı.
  const upgrade = await req("/api/subscription/upgrade", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan: "pro" })
  });
  assert.equal(upgrade.status, 404);

  const invalidCheckout = await req("/api/subscription/create-checkout-session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan: "free" })
  });
  assert.equal(invalidCheckout.status, 400);

  // Kullanıcı, doğrulanmış Stripe webhook'u olmadan ücretsiz kalmalı.
  const meAfterRejectedUpgrade = await req("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(meAfterRejectedUpgrade.data.user.plan, "free");

  const timestamp = Math.floor(Date.now() / 1000);
  const webhookPayload = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { payment_status: "paid", metadata: { user_id: me.data.user.id, plan: "pro_monthly" } } }
  });
  const signature = createHmac("sha256", "whsec_test_only")
    .update(`${timestamp}.${webhookPayload}`)
    .digest("hex");
  const webhook = await req("/api/subscription/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
    body: webhookPayload
  });
  assert.equal(webhook.status, 200);

  const mePro = await req("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(mePro.data.user.plan, "pro");
});

test("SPRINT 2: Doğrulanmamış OAuth girişleri reddedilmeli", async () => {
  const disabledOAuth = await req("/api/auth/oauth", {
    method: "POST",
    body: JSON.stringify({ provider: "google", email: "victim@test.com", name: "Victim" })
  });
  assert.equal(disabledOAuth.status, 404);

  const invalidGoogle = await req("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential: "forged.jwt.payload" })
  });
  assert.equal(invalidGoogle.status, 401);
});

test("SPRINT 2: Admin Dashboard & Klip Silme Yetkilendirmesi", async () => {
  // Normal kullanıcı admin endpoint'ine erişemez (403)
  const reg = await req("/api/auth/register", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.201" },
    body: JSON.stringify({ name: "Normal User", email: `norm_${Date.now()}@test.com`, password: "password123" })
  });
  const normalToken = sessionCookie(reg);
  const forbiddenOverview = await req("/api/admin/overview", {
    headers: { Authorization: `Bearer ${normalToken}` }
  });
  assert.equal(forbiddenOverview.status, 403);

  // Admin kullanıcısı oluşturup giriş yapalım
  const adminEmail = "admin@subscript.local";
  let adminToken = "";
  const loginAdmin = await req("/api/auth/login", {
    method: "POST",
    headers: { "X-Forwarded-For": "198.51.100.200" },
    body: JSON.stringify({ name: "Sistem Admin", password: "admin_password_123" })
  });
  if (loginAdmin.status === 200) {
    adminToken = sessionCookie(loginAdmin);
  } else {
    // Admin henüz yoksa oluşturalım
    const regAdmin = await req("/api/auth/register", {
      method: "POST",
      headers: { "X-Forwarded-For": "198.51.100.200" },
      body: JSON.stringify({ name: "Sistem Admin", email: adminEmail, password: "admin_password_123" })
    });
    adminToken = sessionCookie(regAdmin);
  }
  // Admin overview başarılı dönmeli
  const overview = await req("/api/admin/overview", {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.totalUsers > 0);
  assert.ok(overview.data.clipCount >= 5);

  const adminPage = await fetch(`${BASE_URL}/admin.html`, {
    headers: { Cookie: `subscript_token=${adminToken}` },
    redirect: "manual"
  });
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /admin-content/);

  const invalidAdd = await req("/api/admin/clips", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      id: "../unsafe",
      title: "Geçersiz",
      level: "B9",
      youtubeId: "not-valid",
      dataFile: "../.env"
    })
  });
  assert.equal(invalidAdd.status, 400);

  // Geçici bir klip ekleyelim
  const tempClipId = `temp-test-${Date.now()}`;
  const addRes = await req("/api/admin/clips", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      id: tempClipId,
      title: "Geçici Test Klibi",
      level: "B1",
      youtubeId: "dQw4w9WgXcQ",
      dataFile: "clips/the-office.json"
    })
  });
  assert.equal(addRes.status, 201);

  // Eklenen klibi silelim
  const delRes = await req(`/api/admin/clips/${tempClipId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.success, true);

  // Cümle düzenleme PUT testi
  const clipDetail = await req("/api/clips/sons-of-anarchy");
  assert.equal(clipDetail.status, 200);
  const origText = clipDetail.data.groups[0].sentences[0].text;

  const malformedGroups = structuredClone(clipDetail.data.groups);
  malformedGroups[0].sentences[0].start = "invalid";
  const malformedUpdate = await req("/api/admin/clips/sons-of-anarchy", {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ groups: malformedGroups })
  });
  assert.equal(malformedUpdate.status, 400);

  clipDetail.data.groups[0].sentences[0].text = origText + " [TEST]";
  const putRes = await req("/api/admin/clips/sons-of-anarchy", {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(clipDetail.data)
  });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.data.success, true);

  // Geri al
  clipDetail.data.groups[0].sentences[0].text = origText;
  await req("/api/admin/clips/sons-of-anarchy", {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(clipDetail.data)
  });
});
