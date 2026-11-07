import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
        DATABASE_FILE: testDatabaseFile
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

// ─────────────────────────────────────────────────────────────────────────────
// BÖLÜM 1: REGRESYON TESTLERİ (Mevcut Temel Özellikler)
// ─────────────────────────────────────────────────────────────────────────────
test("REGRESYON: Statik sayfalar ve SPA fallback doğru servis edilmeli", async () => {
  const index = await fetch(`${BASE_URL}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /subscript\./);

  const admin = await fetch(`${BASE_URL}/admin.html`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /Admin Dashboard/);
  const adminRoute = await fetch(`${BASE_URL}/admin`);
  assert.equal(adminRoute.status, 200);
  const adminRouteHtml = await adminRoute.text();
  assert.match(adminRouteHtml, /id="adminView"/);
  assert.match(adminRouteHtml, /id="adminNavItem"/);

  // Hassas dosyalara doğrudan erişim engellenmeli (403 Forbidden)
  const forbidden = await fetch(`${BASE_URL}/data/subscript.sqlite`);
  assert.equal(forbidden.status, 403);

  const envForbidden = await fetch(`${BASE_URL}/.env`);
  assert.equal(envForbidden.status, 403);
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
  assert.ok(registerRes.data.token);
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
    body: JSON.stringify({ email: randomEmail, password: "wrong_password" })
  });
  assert.equal(wrongLogin.status, 401);

  // Doğru şifre ile giriş (200)
  const validLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: randomEmail, password: "password123" })
  });
  assert.equal(validLogin.status, 200);
  assert.ok(validLogin.data.token);

  // /api/me oturum kontrolü
  const meRes = await req("/api/me", {
    headers: { Authorization: `Bearer ${validLogin.data.token}` }
  });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.data.user.email, randomEmail);

  // Oturumu kapatma
  const logoutRes = await req("/api/auth/session", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${validLogin.data.token}` }
  });
  assert.equal(logoutRes.status, 204);

  // Kapatılan oturumla /api/me (401)
  const meAfterLogout = await req("/api/me", {
    headers: { Authorization: `Bearer ${validLogin.data.token}` }
  });
  assert.equal(meAfterLogout.status, 401);
});

test("REGRESYON: Profil CEFR seviyesi güncelleme", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Seviye Testi", email: `level_${Date.now()}@test.com`, password: "password123" })
  });
  const token = reg.data.token;

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
});

// ─────────────────────────────────────────────────────────────────────────────
// BÖLÜM 2: SPRINT 1 TESTLERİ (Kritik Yeni Özellikler)
// ─────────────────────────────────────────────────────────────────────────────
test("SPRINT 1: Kullanıcı ilerlemesi (Progress) kaydetme ve İstatistik (Stats) hesaplama", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Progress User", email: `prog_${Date.now()}@test.com`, password: "password123" })
  });
  const token = reg.data.token;

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

  // Veritabanından son üretilen reset token'ını alalım
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(testDatabaseFile);
  const resetRow = db.prepare("SELECT token FROM password_resets ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(resetRow && resetRow.token);

  // Yeni şifreyi belirleme
  const resetRes = await req("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token: resetRow.token, password: "new_password999" })
  });
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.success, true);

  // Eski şifreyle giriş başarısız olmalı
  const oldLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "old_password123" })
  });
  assert.equal(oldLogin.status, 401);

  // Yeni şifreyle giriş başarılı olmalı
  const newLogin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "new_password999" })
  });
  assert.equal(newLogin.status, 200);
  assert.ok(newLogin.data.token);
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

test("SPRINT 2: Abonelik Planları & Pro Upgrade", async () => {
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Sub User", email: `sub_${Date.now()}@test.com`, password: "password123" })
  });
  const token = reg.data.token;

  // Plan listesi
  const plans = await req("/api/subscription/plans");
  assert.equal(plans.status, 200);
  assert.equal(plans.data.plans.length, 3);
  assert.equal(plans.data.plans[0].id, "free");

  // Kullanıcı başlangıçta 'free' planda olmalı
  const me = await req("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.data.user.plan, "free");

  // Pro plana geçiş
  const upgrade = await req("/api/subscription/upgrade", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan: "pro" })
  });
  assert.equal(upgrade.status, 200);
  assert.equal(upgrade.data.plan, "pro");

  // Güncellenmiş profil
  const mePro = await req("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(mePro.data.user.plan, "pro");
});

test("SPRINT 2: Sosyal Giriş (OAuth Google/Apple) Otomatik Kayıt & Oturum", async () => {
  const oauthRes = await req("/api/auth/oauth", {
    method: "POST",
    body: JSON.stringify({ provider: "google", name: "Google Test User" })
  });
  assert.equal(oauthRes.status, 200);
  assert.ok(oauthRes.data.token);
  assert.equal(oauthRes.data.user.name, "Google Test User");
  assert.equal(oauthRes.data.user.emailVerified, true); // OAuth kullanıcıları doğrudan onaylıdır
});

test("SPRINT 2: Admin Dashboard & Klip Silme Yetkilendirmesi", async () => {
  // Normal kullanıcı admin endpoint'ine erişemez (403)
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Normal User", email: `norm_${Date.now()}@test.com`, password: "password123" })
  });
  const normalToken = reg.data.token;
  const forbiddenOverview = await req("/api/admin/overview", {
    headers: { Authorization: `Bearer ${normalToken}` }
  });
  assert.equal(forbiddenOverview.status, 403);

  // Admin kullanıcısı oluşturup giriş yapalım
  const adminEmail = "admin@subscript.local";
  let adminToken = "";
  const loginAdmin = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: adminEmail, password: "admin_password_123" })
  });
  if (loginAdmin.status === 200) {
    adminToken = loginAdmin.data.token;
  } else {
    // Admin henüz yoksa oluşturalım
    const regAdmin = await req("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name: "Sistem Admin", email: adminEmail, password: "admin_password_123" })
    });
    adminToken = regAdmin.data.token;
  }
  // Admin overview başarılı dönmeli
  const overview = await req("/api/admin/overview", {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(overview.status, 200);
  assert.ok(overview.data.totalUsers > 0);
  assert.ok(overview.data.clipCount >= 5);

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
