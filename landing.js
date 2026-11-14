// ─── Klip Verileri & Vitrin ──────────────────────────────────────────────────
const defaultClips = [
  { title: "Breaking Bad", level: "B2", youtubeId: "MPYlxeG-8_w" },
  { title: "Sons of Anarchy", level: "B1", youtubeId: "661f6PkKOL0" },
  { title: "The Office", level: "B1", youtubeId: "gO8N3L_aERg" },
  { title: "Game of Thrones", level: "B2", youtubeId: "oUjaljMMy2M" },
  { title: "The Godfather", level: "C1", youtubeId: "4m8f8dLa_ig" }
];

let clips = [...defaultClips];
const backdrop = document.getElementById("landingBackdrop");
const clipGrid = document.getElementById("landingClipGrid");
const count = document.getElementById("heroClipCount");
let current = 0;

function renderLibrary(libraryClips) {
  if (!clipGrid) return;
  clipGrid.innerHTML = libraryClips.map((clip, index) => `
    <a class="landing-clip" href="/ogren?data=${encodeURIComponent(clip.id || clip.title)}">
      <span class="landing-clip-index">${String(index + 1).padStart(2, "0")}</span>
      <img src="https://img.youtube.com/vi/${clip.youtubeId}/mqdefault.jpg" alt="${clip.title}" loading="lazy" />
      <div><strong>${clip.title}</strong><small>${clip.level || "B1"} · Dinleme pratiği</small></div>
    </a>
  `).join("");
}

function showClip() {
  if (!backdrop || !clips.length) return;
  const clip = clips[current % clips.length];
  backdrop.style.backgroundImage = `url("https://img.youtube.com/vi/${clip.youtubeId}/maxresdefault.jpg")`;
  current += 1;
}

if (count) count.textContent = clips.length;
showClip();
window.setInterval(showClip, 2500);
renderLibrary(clips);

fetch("/api/clips")
  .then((response) => response.ok ? response.json() : null)
  .then((data) => {
    if (data?.clips?.length) {
      clips = data.clips;
      if (count) count.textContent = clips.length;
      renderLibrary(clips);
    }
  })
  .catch(() => {});

// ─── Auth Modal (Giriş Yap & Kayıt Ol) ────────────────────────────────────────
const authBackdrop = document.getElementById("landingAuthBackdrop");
const authForm = document.getElementById("landingAuthForm");
const tabLogin = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");
const groupName = document.getElementById("groupName");
const inputName = document.getElementById("authName");
const inputEmail = document.getElementById("authEmail");
const inputPassword = document.getElementById("authPassword");
const inputRemember = document.getElementById("authRemember");
const togglePasswordBtn = document.getElementById("togglePasswordBtn");
const authSubmitBtn = document.getElementById("authSubmitBtn");
const authSubmitText = document.getElementById("authSubmitText");
const authSubmitError = document.getElementById("authSubmitError");
const authModalTitle = document.getElementById("authModalTitle");
const authModalSubtitle = document.getElementById("authModalSubtitle");
const authPromptText = document.getElementById("authPromptText");
const authSwitchModeBtn = document.getElementById("authSwitchModeBtn");
const closeAuthModalBtn = document.getElementById("closeAuthModal");
const landingLoginBtn = document.getElementById("landingLoginBtn");
const landingGoogleBtn = document.getElementById("landingGoogleBtn");

let authMode = "login"; // "login" | "register"

// Giriş durumunu kontrol et
const existingToken = localStorage.getItem("subscript_token") || sessionStorage.getItem("subscript_token");
if (existingToken && landingLoginBtn) {
  landingLoginBtn.innerHTML = 'Öğrenmeye git <span>↗</span>';
  landingLoginBtn.addEventListener("click", () => {
    window.location.href = "/ogren";
  });
} else if (landingLoginBtn) {
  landingLoginBtn.addEventListener("click", () => openAuthModal("login"));
}

// Misafir modundayken korumalı rotalara geçiş yapılmasını engelle (Modal aç)
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href^="/ogren"], a[href^="/profil"], a[href^="/settings"], a[href^="/ayarlar"], a[href^="/admin"]');
  if (link) {
    const token = localStorage.getItem("subscript_token") || sessionStorage.getItem("subscript_token");
    if (!token) {
      e.preventDefault();
      openAuthModal("login");
    }
  }
});

function setAuthFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || "";
}

function setAuthSubmitError(msg) {
  if (!authSubmitError) return;
  if (msg) {
    authSubmitError.textContent = msg;
    authSubmitError.classList.add("visible");
  } else {
    authSubmitError.textContent = "";
    authSubmitError.classList.remove("visible");
  }
}

function setAuthBusy(busy) {
  if (!authSubmitBtn || !authSubmitText) return;
  authSubmitBtn.disabled = busy;
  authSubmitText.textContent = busy 
    ? (authMode === "register" ? "Hesap açılıyor…" : "Giriş yapılıyor…")
    : (authMode === "register" ? "Hesap oluştur" : "Giriş yap");
  
  if (authForm) {
    authForm.querySelectorAll("input, button").forEach((el) => {
      if (el !== togglePasswordBtn) el.disabled = busy;
    });
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";

  if (tabLogin) tabLogin.classList.toggle("active", !isRegister);
  if (tabRegister) tabRegister.classList.toggle("active", isRegister);
  if (groupName) groupName.hidden = !isRegister;

  if (authModalTitle) {
    authModalTitle.textContent = isRegister ? "Kendi hesabını oluştur." : "Kaldığın yerden devam et.";
  }
  if (authModalSubtitle) {
    authModalSubtitle.textContent = isRegister
      ? "İlerlemeni kaydetmek için ücretsiz hesabını oluştur."
      : "İlerlemeni ve favori kliplerini kaydetmek için giriş yap.";
  }
  if (authSubmitText) {
    authSubmitText.textContent = isRegister ? "Hesap oluştur" : "Giriş yap";
  }
  if (authPromptText) {
    authPromptText.textContent = isRegister ? "Zaten hesabın var mı?" : "Henüz hesabın yok mu?";
  }
  if (authSwitchModeBtn) {
    authSwitchModeBtn.textContent = isRegister ? "Giriş yap" : "Kayıt ol";
  }

  setAuthFieldError("nameError", "");
  setAuthFieldError("emailError", "");
  setAuthFieldError("passwordError", "");
  setAuthSubmitError("");
}

function openAuthModal(mode = "login") {
  if (!authBackdrop) return;
  if (authForm) authForm.reset();
  setAuthMode(mode);
  if (inputPassword) inputPassword.type = "password";
  if (togglePasswordBtn) togglePasswordBtn.textContent = "Göster";

  authBackdrop.classList.add("open");
  authBackdrop.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  window.setTimeout(() => {
    if (mode === "register" && inputName) {
      inputName.focus();
    } else if (inputEmail) {
      inputEmail.focus();
    }
  }, 100);
}

function closeAuthModal() {
  if (!authBackdrop) return;
  authBackdrop.classList.remove("open");
  authBackdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// Sekmeler & Geçişler
if (tabLogin) tabLogin.addEventListener("click", () => setAuthMode("login"));
if (tabRegister) tabRegister.addEventListener("click", () => setAuthMode("register"));
if (authSwitchModeBtn) {
  authSwitchModeBtn.addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "register" : "login");
  });
}

// Şifre Göster / Gizle
if (togglePasswordBtn && inputPassword) {
  togglePasswordBtn.addEventListener("click", () => {
    const isPass = inputPassword.type === "password";
    inputPassword.type = isPass ? "text" : "password";
    togglePasswordBtn.textContent = isPass ? "Gizle" : "Göster";
  });
}

// Kapatma butonları & dış tıklama
if (closeAuthModalBtn) closeAuthModalBtn.addEventListener("click", closeAuthModal);
if (authBackdrop) {
  authBackdrop.addEventListener("click", (e) => {
    if (e.target === authBackdrop) closeAuthModal();
  });
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && authBackdrop?.classList.contains("open")) {
    closeAuthModal();
  }
});

// Sayfadaki "Ücretsiz başla" butonları modalı register modunda açsın
document.querySelectorAll('[data-auth-trigger="register"]').forEach((btn) => {
  btn.addEventListener("click", () => openAuthModal("register"));
});
document.querySelectorAll('[data-auth-trigger="login"]').forEach((btn) => {
  btn.addEventListener("click", () => openAuthModal("login"));
});

// Form Gönderme (Login / Register)
if (authForm) {
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = inputName ? inputName.value.trim() : "";
    const email = inputEmail ? inputEmail.value.trim() : "";
    const password = inputPassword ? inputPassword.value : "";
    const remember = inputRemember ? inputRemember.checked : true;

    setAuthFieldError("nameError", authMode === "register" && !name ? "Adını yazmalısın." : "");
    setAuthFieldError("emailError", !email ? "E-posta adresini yaz." : !email.includes("@") ? "Geçerli bir e-posta gir." : "");
    setAuthFieldError("passwordError", !password ? "Şifreni yaz." : password.length < 8 ? "Şifre en az 8 karakter olmalı." : "");
    setAuthSubmitError("");

    if (!email || !email.includes("@") || !password || password.length < 8 || (authMode === "register" && !name)) {
      return;
    }

    setAuthBusy(true);
    try {
      const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload = authMode === "register"
        ? { name, email, password, remember }
        : { email, password, remember };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "İşlem tamamlanamadı. Lütfen tekrar deneyin.");
      }

      if (remember) {
        localStorage.setItem("subscript_token", data.token);
        sessionStorage.removeItem("subscript_token");
        document.cookie = `subscript_token=${data.token}; Path=/; Max-Age=2592000; SameSite=Lax`;
      } else {
        sessionStorage.setItem("subscript_token", data.token);
        localStorage.removeItem("subscript_token");
        document.cookie = `subscript_token=${data.token}; Path=/; SameSite=Lax`;
      }
      if (data.user?.name) {
        localStorage.setItem("subscript_name", data.user.name);
      }
      localStorage.setItem("subscript_onboarding_seen", "1");
      if (authMode === "register") {
        sessionStorage.setItem("subscript_is_new_user", "1");
      } else {
        sessionStorage.removeItem("subscript_is_new_user");
      }

      // Yönlendir
      window.location.href = "/ogren";
    } catch (err) {
      setAuthSubmitError(err.message || "Giriş yapılamadı.");
    } finally {
      setAuthBusy(false);
    }
  });
}

// Google Girişi
if (landingGoogleBtn) {
  landingGoogleBtn.addEventListener("click", async () => {
    setAuthSubmitError("");
    setAuthBusy(true);

    try {
      let googleClientId = "";
      try {
        const cfgRes = await fetch("/api/config/auth");
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          googleClientId = cfg?.googleClientId || "";
        }
      } catch {}

      if (googleClientId && window.google?.accounts?.id) {
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            try {
              setAuthBusy(true);
              const gRes = await fetch("/api/auth/google", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ credential: response.credential })
              });
              const gData = await gRes.json();
              if (!gRes.ok) throw new Error(gData.error || "Google girişi başarısız.");

              localStorage.setItem("subscript_token", gData.token);
              document.cookie = `subscript_token=${gData.token}; Path=/; Max-Age=2592000; SameSite=Lax`;
              if (gData.user?.name) localStorage.setItem("subscript_name", gData.user.name);
              localStorage.setItem("subscript_onboarding_seen", "1");
              window.location.href = "/ogren";
            } catch (err) {
              setAuthSubmitError(err.message);
            } finally {
              setAuthBusy(false);
            }
          }
        });
        google.accounts.id.prompt();
        setAuthBusy(false);
        return;
      }

      // Test modu
      const userChoice = confirm(
        "Google Giriş Entegrasyonu:\n\n" +
        "Gerçek Google hesabı seçimi için .env dosyasında GOOGLE_CLIENT_ID tanımlanmalıdır.\n\n" +
        "Şimdi test hesabıyla giriş yapıp öğrenmeye geçmek ister misiniz?"
      );

      if (userChoice) {
        const testRes = await fetch("/api/auth/oauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "google", name: "Google Kullanıcısı" })
        });
        const testData = await testRes.json();
        if (!testRes.ok) throw new Error(testData.error || "Giriş yapılamadı.");

        localStorage.setItem("subscript_token", testData.token);
        document.cookie = `subscript_token=${testData.token}; Path=/; Max-Age=2592000; SameSite=Lax`;
        if (testData.user?.name) localStorage.setItem("subscript_name", testData.user.name);
        localStorage.setItem("subscript_onboarding_seen", "1");
        window.location.href = "/ogren";
      }
    } catch (err) {
      setAuthSubmitError(err.message || "Google girişi başlatılamadı.");
    } finally {
      setAuthBusy(false);
    }
  });
}
