// ─── Config ───────────────────────────────────────────────────────────────────
const CLIPS_CATALOG = "/api/clips";

// Sözlük eşleştirmeleri (Akıllı İpucu seviye 1 için)
const DICTIONARY = {
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
  three: "üç"
};

// ─── State ────────────────────────────────────────────────────────────────────
let groups = [];
let current = 0;       // mevcut grup indexi
let hintStage = 0;     // 0: yok, 1: anlam gösterildi, 2: ilk harf, 3: kelime tamamlandı
let speed = 1;
let player = null;
let playerReady = false;
let loopInterval = null;

// Oyunlaştırma & İstatistikler
let currentStreak = 0;
let maxStreak = 0;
let firstTrySuccessCount = 0;
let isCurrentPartFirstTry = true;

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const normalize = (v) =>
  v.toLowerCase().replace(/[^a-z0-9']/g, "").trim();

// ─── Time formatting ──────────────────────────────────────────────────────────
function stamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─── SVG Durum İkonları (Sidebar için profesyonel SVG'ler) ─────────────────────
const ICONS = {
  active: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`,
  done: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  locked: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
};

// ─── Markup Builders (Harf Harf Tile Kutuları) ────────────────────────────────

/**
 * Boşluk olan kelime için harf sayısı kadar küçük bitişik kutucuk üretir.
 */
function buildWordTilesMarkup(cleanWord, groupIndex, wordIndex) {
  const chars = cleanWord.split("");
  const tilesHtml = chars
    .map(
      (ch, charIndex) => `<input
        type="text"
        class="tile-char-input"
        maxlength="1"
        data-group="${groupIndex}"
        data-word="${wordIndex}"
        data-char-index="${charIndex}"
        data-expected="${ch.toLowerCase()}"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
      />`
    )
    .join("");

  return `<span class="word-tiles-group" data-word="${cleanWord}" data-group="${groupIndex}" data-word-idx="${wordIndex}">
    <span class="hint-meaning-bubble" id="bubble_${groupIndex}_${wordIndex}" style="display:none;"></span>
    ${tilesHtml}
  </span>`;
}

function buildSentenceMarkup(sentence, groupIndex) {
  const tokens = sentence.text.split(" ");
  const blanks = new Set(sentence.blankIndexes);

  return tokens
    .map((word, wordIdx) => {
      const cleanWord = word.replace(/[.,!?;:'"()[\]]/g, "");
      if (blanks.has(wordIdx) && cleanWord.length > 0) {
        // Noktalama işareti varsa kelimenin ardına ekle
        const trailingPunct = word.slice(cleanWord.length);
        return buildWordTilesMarkup(cleanWord, groupIndex, wordIdx) + 
               (trailingPunct ? `<span class="word-static">${trailingPunct}</span>` : "");
      }
      return `<span class="word-static">${word}</span>`;
    })
    .join(" ");
}

function buildGroupMarkup(group) {
  return group.sentences
    .map(
      (s, i) =>
        `<div class="sentence-row" data-sentence-index="${i}">${buildSentenceMarkup(s, i)}</div>`
    )
    .join("");
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  const group = groups[current];
  isCurrentPartFirstTry = true;
  hintStage = 0;

  // Header / Progress
  $("stepCount").textContent = `${current + 1} / ${groups.length}`;
  if ($("progressPercent")) {
    $("progressPercent").textContent = `%${Math.round(((current + 1) / groups.length) * 100)} TAMAMLANDI`;
  }
  $("progressFill").style.width = `${((current + 1) / groups.length) * 100}%`;

  // Segment meta
  $("segmentNumber").textContent = `PARÇA ${String(current + 1).padStart(2, "0")}`;
  $("segmentTime").textContent = `${stamp(group.start)} — ${stamp(group.end)}`;
  updateHintButtonLabel();

  if ($("prevPartButton")) {
    $("prevPartButton").disabled = current === 0;
  }

  // Boşlukları render et
  $("fillSentence").innerHTML = buildGroupMarkup(group);
  $("feedback").className = "feedback";
  $("feedback").innerHTML = "";

  setupTileEvents();

  // Sidebar listesi
  renderSidebar();

  // İlk kutuya otomatik odaklan
  const firstTile = document.querySelector(".tile-char-input");
  if (firstTile) firstTile.focus();
}

function renderSidebar() {
  $("segmentList").innerHTML = groups
    .map((g, i) => {
      let icon = ICONS.locked;
      let text = "Kilitli";
      let statusClass = "";

      if (i < current) {
        icon = ICONS.done;
        text = g.sentences.map((s) => s.text).join(" ");
        statusClass = " done";
      } else if (i === current) {
        icon = ICONS.active;
        text = "Şimdi çalışıyor";
        statusClass = " active";
      }

      return `<button class="segment-item${statusClass}" data-index="${i}">
        <div class="seg-status-icon">${icon}</div>
        <div class="seg-content">
          <span class="time">${stamp(g.start)}</span>
          <p>${text}</p>
        </div>
      </button>`;
    })
    .join("");

  document.querySelectorAll(".segment-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      if (i <= current) {
        current = i;
        render();
        play(true);
      }
    });
  });
}

// ─── Harf Kutuları (Tiles) Etkileşim Yönetimi ──────────────────────────────────
function setupTileEvents() {
  const tiles = [...document.querySelectorAll(".tile-char-input")];

  tiles.forEach((tile, index) => {
    // Harf yazıldığında otomatik sonrakine geç
    tile.addEventListener("input", (e) => {
      const val = tile.value.trim();
      if (val.length > 0) {
        tile.value = val[val.length - 1].toLowerCase();
        // Bir sonraki kutuya geç
        if (index < tiles.length - 1) {
          tiles[index + 1].focus();
          tiles[index + 1].select();
        } else {
          // Son kutuysa kontrol butonunu hedefle
          $("checkButton").focus();
        }
      }
    });

    // Backspace & Sol/Sağ ok tuşlarıyla rahat gezinme
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Backspace") {
        if (tile.value === "" && index > 0) {
          e.preventDefault();
          tiles[index - 1].focus();
          tiles[index - 1].value = "";
        }
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        tiles[index - 1].focus();
      } else if (e.key === "ArrowRight" && index < tiles.length - 1) {
        e.preventDefault();
        tiles[index + 1].focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        checkAnswer();
      }
    });

    tile.addEventListener("focus", () => tile.select());
  });
}

// ─── Playback & Canlı Ses Dalgası ─────────────────────────────────────────────
function updatePlayUI(isPlaying) {
  const btn = $("listenButton");
  const txt = $("listenButtonText");
  const iconWrap = $("playIconWrap");
  if (!btn) return;

  if (isPlaying) {
    btn.classList.add("is-playing");
    txt.textContent = "Durdur";
    iconWrap.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
  } else {
    btn.classList.remove("is-playing");
    txt.textContent = "Oynat";
    iconWrap.innerHTML = `<svg class="play-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  }
}

function disableSubtitles() {
  if (!player || !playerReady) return;
  try {
    // Altyazı parçasını kapat
    if (typeof player.unloadModule === "function") {
      player.unloadModule("captions");
      player.unloadModule("cc");
    }
    if (typeof player.setOption === "function") {
      player.setOption("captions", "track", {});
      player.setOption("cc", "track", {});
    }
  } catch (e) {}
}

function stopLoopMonitor() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
}

function startLoopMonitor() {
  stopLoopMonitor();
  disableSubtitles();
  const group = groups[current];
  loopInterval = setInterval(() => {
    if (!playerReady) return;
    try {
      const now = player.getCurrentTime();
      if (now >= group.end) {
        player.pauseVideo();
        stopLoopMonitor();
        updatePlayUI(false);
      }
    } catch (e) {}
  }, 100);
}

function play(fromStart = false) {
  if (!playerReady) return;
  const group = groups[current];

  if (fromStart) {
    player.seekTo(group.start, true);
  } else {
    const now = player.getCurrentTime();
    if (now < group.start || now >= group.end - 0.1) {
      player.seekTo(group.start, true);
    }
  }

  player.setPlaybackRate(speed);
  player.playVideo();
  updatePlayUI(true);
  startLoopMonitor();
}

function togglePlayPause() {
  if (!playerReady) return;
  const state = player.getPlayerState();
  if (state === 1) { // PLAYING
    player.pauseVideo();
    stopLoopMonitor();
    updatePlayUI(false);
  } else {
    play(false);
  }
}

// ─── Seviyeli Akıllı İpucu (3 Kademe) ──────────────────────────────────────────
function updateHintButtonLabel() {
  const lbl = $("hintCount");
  if (!lbl) return;
  if (hintStage === 0) lbl.textContent = "3 AŞAMALI İPUCU";
  else if (hintStage === 1) lbl.textContent = "AŞAMA 1: ANLAM AÇIK";
  else if (hintStage === 2) lbl.textContent = "AŞAMA 2: İLK HARF AÇIK";
  else lbl.textContent = "İPUCU TÜKENDİ";
}

function giveHint() {
  isCurrentPartFirstTry = false;
  const wordGroups = [...document.querySelectorAll(".word-tiles-group")];
  if (wordGroups.length === 0) return;

  if (hintStage === 0) {
    // 1. Kademe: Türkçe Anlam Balonunu aç
    wordGroups.forEach((groupEl) => {
      const rawWord = groupEl.dataset.word.toLowerCase();
      const meaning = DICTIONARY[rawWord] || "bağlamdan çıkarınız";
      const bubble = groupEl.querySelector(".hint-meaning-bubble");
      if (bubble) {
        bubble.textContent = meaning;
        bubble.style.display = "block";
      }
    });
    hintStage = 1;
    $("feedback").className = "feedback partial";
    $("feedback").textContent = "İpucu: Eksik kelimelerin anlamları gösterildi.";
  } else if (hintStage === 1) {
    // 2. Kademe: İlk harfi otomatik yaz ve kilitle
    wordGroups.forEach((groupEl) => {
      const firstTile = groupEl.querySelector('.tile-char-input[data-char-index="0"]');
      if (firstTile) {
        firstTile.value = firstTile.dataset.expected;
      }
    });
    hintStage = 2;
    $("feedback").className = "feedback partial";
    $("feedback").textContent = "İpucu: Kelimelerin ilk harfleri yerleştirildi.";
  } else if (hintStage === 2) {
    // 3. Kademe: Tüm kelimeleri tamamla
    wordGroups.forEach((groupEl) => {
      groupEl.querySelectorAll(".tile-char-input").forEach((inp) => {
        inp.value = inp.dataset.expected;
      });
    });
    hintStage = 3;
    $("feedback").className = "feedback partial";
    $("feedback").textContent = "İpucu: Kelimeler tamamlandı. Kontrol edebilirsin.";
  }
  updateHintButtonLabel();
}

// ─── Cevap Kontrolü & Oyunlaştırma ────────────────────────────────────────────
function checkAnswer() {
  const wordGroups = [...document.querySelectorAll(".word-tiles-group")];
  const feedback = $("feedback");

  let allFilled = true;
  let allCorrect = true;

  wordGroups.forEach((groupEl) => {
    const tiles = [...groupEl.querySelectorAll(".tile-char-input")];
    const userWord = tiles.map((t) => t.value.trim().toLowerCase()).join("");
    const targetWord = tiles.map((t) => t.dataset.expected.toLowerCase()).join("");

    if (userWord.length < targetWord.length) {
      allFilled = false;
    }

    const isMatch = userWord === targetWord;
    groupEl.classList.remove("is-correct", "is-wrong");
    void groupEl.offsetWidth; // Reflow tetikle

    if (isMatch) {
      groupEl.classList.add("is-correct");
    } else {
      groupEl.classList.add("is-wrong");
      allCorrect = false;
    }
  });

  if (!allFilled) {
    feedback.className = "feedback partial";
    feedback.textContent = "Lütfen tüm harf kutularını doldurunuz.";
    return;
  }

  if (allCorrect) {
    // Streak (Seri) Güncelleme
    currentStreak++;
    if (currentStreak > maxStreak) maxStreak = currentStreak;
    if (isCurrentPartFirstTry) firstTrySuccessCount++;

    updateStreakUI();

    feedback.className = "feedback success";
    feedback.innerHTML = `<span class="correct">Eksiksiz ve doğru!</span> Harika dinleme.`;

    setTimeout(() => {
      if (current < groups.length - 1) {
        current++;
        render();
        play(true);
      } else {
        // Klip Tamamlandı - Final Modalı & Konfeti
        showCompletionModal();
      }
    }, 1100);
  } else {
    // Hatalı cevapta streak sıfırlanır
    currentStreak = 0;
    isCurrentPartFirstTry = false;
    updateStreakUI();
    feedback.className = "feedback partial";
    feedback.textContent = "Bazı harfler uyuşmadı. Tekrar dinleyip düzeltiniz.";
  }
}

function updateStreakUI() {
  const badge = $("streakBadge");
  const count = $("streakCount");
  if (!badge || !count) return;
  if (!badge || !count) return;

  count.textContent = currentStreak;
  if (currentStreak >= 2) {
    badge.classList.add("active");
  } else {
    badge.classList.remove("active");
  }
}

// ─── Final Tebrik Modalı ve Konfeti Efekti ────────────────────────────────────
function showCompletionModal() {
  const modal = $("completionModal");
  if (!modal) return;

  const total = groups.length;
  const accuracy = Math.round((firstTrySuccessCount / total) * 100);

  $("statAccuracy").textContent = `%${accuracy}`;
  $("statMaxStreak").textContent = `${maxStreak}`;
  $("statTotalParts").textContent = `${total}`;

  modal.classList.add("open");
  launchConfetti();
}

function launchConfetti() {
  const canvas = $("confettiCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const pieces = [];
  const colors = ["#ff6838", "#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#ffffff"];

  for (let i = 0; i < 90; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: Math.random() * -canvas.height * 0.5,
      w: Math.random() * 8 + 6,
      h: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: Math.random() * 3 + 2.5,
      vx: (Math.random() - 0.5) * 2,
      rot: Math.random() * 360,
      vrot: (Math.random() - 0.5) * 6
    });
  }

  let animationFrame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let active = false;

    pieces.forEach((p) => {
      p.y += p.vy;
      p.x += p.vx;
      p.rot += p.vrot;

      if (p.y < canvas.height) active = true;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });

    if (active) {
      animationFrame = requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animationFrame);
    }
  }
  draw();
}

// ─── Klavye Kısayolları (Keyboard Shortcuts) ──────────────────────────────────
function setupKeyboardShortcuts() {
  window.addEventListener("keydown", (e) => {
    // Eğer kullanıcı aktif olarak bir input içinde değilse veya Space tuşuna basmışsa
    const targetTag = e.target.tagName.toLowerCase();

    // Space: Oynat / Duraklat (Input içinde değilken)
    if (e.code === "Space" && targetTag !== "input") {
      e.preventDefault();
      togglePlayPause();
    }
    // R tuşu: Mevcut parçayı başa sar
    else if ((e.key === "r" || e.key === "R") && targetTag !== "input") {
      e.preventDefault();
      play(true);
    }
    // Tab tuşu: İpucu al
    else if (e.key === "Tab") {
      e.preventDefault();
      giveHint();
    }
  });
}

// ─── Controls Event Listeners ─────────────────────────────────────────────────
$("listenButton").addEventListener("click", togglePlayPause);
$("videoOverlay").addEventListener("click", togglePlayPause);
$("checkButton").addEventListener("click", checkAnswer);
$("hintButton").addEventListener("click", giveHint);

$("prevPartButton").addEventListener("click", () => {
  if (current > 0) {
    current--;
    render();
    play(true);
  }
});

$("backButton").addEventListener("click", () => {
  if (playerReady) play(true);
});

$("speedButton").addEventListener("click", () => {
  speed = speed === 1 ? 0.75 : speed === 0.75 ? 0.5 : 1;
  $("speedButton").textContent = `${speed}×`;
  if (playerReady) player.setPlaybackRate(speed);
});

if ($("restartModalBtn")) {
  $("restartModalBtn").addEventListener("click", () => {
    $("completionModal").classList.remove("open");
    current = 0;
    currentStreak = 0;
    firstTrySuccessCount = 0;
    render();
    play(true);
  });
}

// ─── Klip Kütüphanesi (Library Modal) ─────────────────────────────────────────
let globalCatalog = [];
let currentDataFile = "";

let authToken = localStorage.getItem("subscript_token") || sessionStorage.getItem("subscript_token") || "";
let authUser = null;
const authBackdrop = $("authBackdrop");
const loginBackdrop = $("loginBackdrop");

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-theme", isDark);
  $(`theme-${isDark ? "dark" : "light"}`).checked = true;
}

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "İstek başarısız.");
  return body;
}

function showLevelPicker() {
  $("levelBackdrop").classList.add("open");
}

async function saveLevel(level) {
  try {
    localStorage.setItem("subscript_level", level);
    if (!authToken) {
      $("levelBackdrop").classList.remove("open");
      window.location.reload();
      return;
    }
    const result = await apiRequest("/api/profile/level", { method: "POST", body: JSON.stringify({ level }) });
    authUser = result.user;
    $("levelBackdrop").classList.remove("open");
    window.location.reload();
  } catch (error) {
    $("authError").textContent = error.message;
  }
}

async function loadCatalog() {
  const level = authUser?.level || localStorage.getItem("subscript_level");
  const result = await apiRequest(level ? `${CLIPS_CATALOG}?level=${encodeURIComponent(level)}` : CLIPS_CATALOG);
  globalCatalog = result.clips;
}

async function ensureAuthenticated() {
  if (!authToken) return false;
  try {
    authUser = (await apiRequest("/api/me")).user;
    return true;
  } catch {
    localStorage.removeItem("subscript_token");
    sessionStorage.removeItem("subscript_token");
    authToken = "";
    return false;
  }
}

function setupAuth() {
  const showStep = (step) => {
    ["welcomeStep", "profileStep"].forEach((id) => {
      const element = $(id);
      if (element) element.hidden = true;
    });
    const target = $(step);
    if (target) target.hidden = false;
  };
  showStep("welcomeStep");
  $("welcomeContinue").addEventListener("click", () => showStep("profileStep"));
  $("profileContinue").addEventListener("click", () => {
    const name = $("authName").value.trim();
    if (!name) {
      $("authError").textContent = "Adını yazman yeterli.";
      return;
    }
    localStorage.setItem("subscript_name", name);
    $("authBackdrop").classList.remove("open");
    showLevelPicker();
  });
  $("skipOnboarding").addEventListener("click", () => {
    $("authBackdrop").classList.remove("open");
  });
  document.querySelectorAll("[data-level]").forEach((button) => button.addEventListener("click", () => saveLevel(button.dataset.level)));
  $("startTestButton").addEventListener("click", () => {
    $("startTestButton").hidden = true;
    $("levelOptions").hidden = true;
    $("levelTest").hidden = false;
    runLevelTest();
  });
  $("skipLevelButton").addEventListener("click", () => $("levelBackdrop").classList.remove("open"));
}

function setLoginError(id, message) {
  const element = $(id);
  if (element) element.textContent = message;
}

function setLoginBusy(busy) {
  const button = $("loginSubmitButton");
  const label = $("loginSubmitLabel");
  if (!button || !label) return;
  button.disabled = busy;
  label.textContent = busy ? "Giriş yapılıyor…" : "Giriş yap";
  $("loginForm").querySelectorAll("input, button").forEach((element) => {
    if (element.id !== "closeLoginButton" && element.id !== "loginRegisterHint") element.disabled = busy;
  });
}

function closeLoginModal() {
  if (!loginBackdrop) return;
  loginBackdrop.classList.remove("open");
  loginBackdrop.setAttribute("aria-hidden", "true");
}

function openLoginModal() {
  if (!loginBackdrop) return;
  $("profileMenu").hidden = true;
  $("loginForm").reset();
  setLoginError("loginEmailError", "");
  setLoginError("loginPasswordError", "");
  setLoginError("loginSubmitError", "");
  $("loginPassword").type = "password";
  $("toggleLoginPassword").textContent = "Göster";
  loginBackdrop.classList.add("open");
  loginBackdrop.setAttribute("aria-hidden", "false");
  window.setTimeout(() => $("loginEmail").focus(), 100);
}

async function submitLogin(event) {
  event.preventDefault();
  if (authToken) {
    closeLoginModal();
    return;
  }

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  setLoginError("loginEmailError", !email ? "E-posta adresini yaz." : !email.includes("@") ? "Geçerli bir e-posta adresi yaz." : "");
  setLoginError("loginPasswordError", !password ? "Şifreni yaz." : "");
  setLoginError("loginSubmitError", "");
  if (!email || !email.includes("@") || !password) return;

  setLoginBusy(true);
  try {
    const result = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, remember: $("loginRemember").checked })
    });
    authToken = result.token;
    authUser = result.user;
    if ($("loginRemember").checked) {
      localStorage.setItem("subscript_token", authToken);
      sessionStorage.removeItem("subscript_token");
    } else {
      sessionStorage.setItem("subscript_token", authToken);
      localStorage.removeItem("subscript_token");
    }
    if (authUser.name) localStorage.setItem("subscript_name", authUser.name);
    closeLoginModal();
    updateProfileUI();
    await loadCatalog();
  } catch (error) {
    setLoginError("loginSubmitError", error.message || "Giriş yapılamadı. Lütfen tekrar dene.");
  } finally {
    setLoginBusy(false);
  }
}

function updateProfileUI() {
  const storedName = localStorage.getItem("subscript_name");
  const name = authUser?.name || storedName || "Misafir";
  const level = authUser?.level || localStorage.getItem("subscript_level");
  const language = localStorage.getItem("subscript_language") || "en";
  const flags = { en: "🇬🇧", de: "🇩🇪", fr: "🇫🇷", es: "🇪🇸" };
  const initial = name.trim().charAt(0).toUpperCase() || "S";
  $("headerAvatar").textContent = initial;
  $("menuAvatar").textContent = initial;
  $("headerProfileName").textContent = name;
  $("menuProfileName").textContent = name;
  $("headerLanguageFlag").textContent = flags[language] || flags.en;
  $("menuProfileLevel").textContent = level ? `İngilizce · ${level}` : "İngilizce · Seviye seçilmedi";
  $("profileLogin").hidden = Boolean(authUser);
  $("profileLogout").hidden = !authUser;
}

function setupNavigation() {
  updateProfileUI();
  applyTheme(localStorage.getItem("subscript_theme") || "light");
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener("change", () => {
      localStorage.setItem("subscript_theme", input.value);
      applyTheme(input.value);
    });
  });
  $("headerProfileButton").addEventListener("click", () => {
    const menu = $("profileMenu");
    menu.hidden = !menu.hidden;
  });
  $("profileLogin").addEventListener("click", openLoginModal);
  $("closeLoginButton").addEventListener("click", closeLoginModal);
  $("loginBackdrop").addEventListener("click", (event) => {
    if (event.target === $("loginBackdrop")) closeLoginModal();
  });
  $("loginForm").addEventListener("submit", submitLogin);
  $("toggleLoginPassword").addEventListener("click", () => {
    const input = $("loginPassword");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    $("toggleLoginPassword").setAttribute("aria-label", visible ? "Şifreyi göster" : "Şifreyi gizle");
    $("toggleLoginPassword").classList.toggle("is-visible", !visible);
  });
  $("loginRegisterHint").addEventListener("click", () => {
    setLoginError("loginSubmitError", "Kayıt olma akışı yakında aktif olacak. Şimdilik misafir olarak devam edebilirsin.");
  });
  $("forgotPasswordButton").addEventListener("click", () => {
    setLoginError("loginSubmitError", "Şifre yenileme akışı yakında aktif olacak.");
  });
  ["googleLoginButton", "appleLoginButton"].forEach((id) => {
    $(id).addEventListener("click", () => {
      setLoginError("loginSubmitError", "Sosyal medya ile giriş yakında aktif olacak.");
    });
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".header-profile-wrap")) $("profileMenu").hidden = true;
  });
  document.querySelectorAll(".side-nav-item, [data-profile-action]").forEach((item) => {
    item.addEventListener("click", () => {
      const section = item.dataset.section || item.dataset.profileAction;
      document.querySelectorAll(".side-nav-item").forEach((navItem) => navItem.classList.toggle("active", navItem.dataset.section === section));
      $("profileMenu").hidden = true;
      if (section === "learn") window.scrollTo({ top: 0, behavior: "smooth" });
      if (section === "profile") updateProfileUI();
    });
  });
  $("profileLogout").addEventListener("click", () => {
    authToken = "";
    authUser = null;
    localStorage.removeItem("subscript_token");
    sessionStorage.removeItem("subscript_token");
    $("profileMenu").hidden = true;
    updateProfileUI();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && loginBackdrop.classList.contains("open")) closeLoginModal();
  });
}

function runLevelTest() {
  const questions = [
    { text: "She ___ to work every day.", options: ["go", "goes", "going"], answer: "goes", level: "A2" },
    { text: "I have lived here ___ 2020.", options: ["for", "since", "during"], answer: "since", level: "B1" },
    { text: "If I had known, I ___ you.", options: ["would tell", "would have told", "will tell"], answer: "would have told", level: "B2" }
  ];
  let index = 0;
  let score = 0;
  const renderQuestion = () => {
    const question = questions[index];
    $("testQuestion").textContent = question.text;
    $("testOptions").innerHTML = question.options.map((option) => `<button type="button">${option}</button>`).join("");
    $("testOptions").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
      if (button.textContent === question.answer) score += 1;
      index += 1;
      if (index < questions.length) renderQuestion();
      else saveLevel(score === 0 ? "A1" : questions[score - 1].level);
    }));
  };
  renderQuestion();
}

async function openLibraryModal() {
  const modal = $("libraryModal");
  if (!modal) return;

  try {
    await loadCatalog();
  } catch (e) {}

  renderLibraryGrid();
  modal.classList.add("open");
}

function closeLibraryModal() {
  const modal = $("libraryModal");
  if (modal) modal.classList.remove("open");
}

function renderLibraryGrid() {
  const grid = $("libraryGrid");
  if (!grid) return;

  if (globalCatalog.length === 0) {
    grid.innerHTML = `<p style="color:var(--muted);grid-column:1/-1;padding:20px;text-align:center">Henüz kayıtlı klip bulunmuyor.</p>`;
    return;
  }

  grid.innerHTML = globalCatalog
    .map((item) => {
      const isCurrent = item.id === currentDataFile;
      const thumbUrl = `https://img.youtube.com/vi/${item.youtubeId}/mqdefault.jpg`;
      const dur = stamp(item.durationSeconds || 0);
      const level = item.level || "B1";

      return `
        <button class="clip-card-item${isCurrent ? " is-current" : ""}" data-id="${item.id}">
          <div class="clip-thumb-wrap">
            <img class="clip-thumb-img" src="${thumbUrl}" alt="${item.title}" loading="lazy" />
            <span class="clip-level-badge level-${level.toLowerCase()}">${level}</span>
            <span class="clip-duration-badge">${dur}</span>
          </div>
          <div class="clip-card-body">
            <h4 class="clip-card-title">${item.title} <span class="clip-card-level-tag">· ${level}</span></h4>
            <div class="clip-card-meta">
              <span>${item.groupCount || "?"} Parça</span>
              <span>${item.sentenceCount || "?"} Cümle</span>
            </div>
          </div>
        </button>
      `;
    })
    .join("");

  grid.querySelectorAll(".clip-card-item").forEach((card) => {
    card.addEventListener("click", () => {
      const targetId = card.dataset.id;
      if (targetId) {
        closeLibraryModal();
        if (targetId !== currentDataFile) {
          switchClip(targetId);
        }
      }
    });
  });
}

async function switchClip(dataFile) {
  // Önceki oynatıcıyı durdur
  stopLoopMonitor();
  if (player && typeof player.pauseVideo === "function") {
    player.pauseVideo();
  }
  // URL parametresini güncelle
  const url = new URL(window.location);
  url.searchParams.set("data", dataFile);
  window.history.pushState({}, "", url);

  current = 0;
  currentStreak = 0;
  firstTrySuccessCount = 0;
  updateStreakUI();

  await loadClip(dataFile);
}

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function loadClip(dataFile) {
  currentDataFile = dataFile;
  const data = await apiRequest(`/api/clips/${encodeURIComponent(dataFile)}`);

  groups = data.groups;
  $("clipTitle").textContent = data.title;
  
  // Katalogdan seviyeyi bul ve üstteki eyebrow rozetini güncelle
  const catalogItem = globalCatalog.find((c) => c.id === dataFile);
  const level = (catalogItem && catalogItem.level) || data.level || "B1";
  if ($("clipEyebrow")) {
    $("clipEyebrow").textContent = `FİLM KESİTİ · ${level}`;
  }

  document.title = `loop. — ${data.title} (${level})`;

  render();
  if (player && playerReady) {
    player.loadVideoById(data.youtubeId);
  } else {
    initYouTube(data.youtubeId);
  }
  setupKeyboardShortcuts();
}

async function init() {
  setupAuth();
  setupNavigation();
  const authenticated = await ensureAuthenticated();
  updateProfileUI();
  if (authenticated) authBackdrop.classList.remove("open");
  await loadCatalog();
  // Event listeners for Library
  if ($("libraryTriggerBtn")) $("libraryTriggerBtn").addEventListener("click", openLibraryModal);
  if ($("changeClipLink")) $("changeClipLink").addEventListener("click", openLibraryModal);
  if ($("closeLibraryBtn")) $("closeLibraryBtn").addEventListener("click", closeLibraryModal);
  if ($("libraryModal")) {
    $("libraryModal").addEventListener("click", (e) => {
      if (e.target === $("libraryModal")) closeLibraryModal();
    });
  }

  const params = new URLSearchParams(window.location.search);
  let dataFile = params.get("data");

  if (!dataFile) {
    const catalog = globalCatalog;
    if (!catalog.length) {
      document.body.innerHTML = "<p style='padding:2rem'>Henüz hiç klip eklenmemiş.</p>";
      return;
    }
    dataFile = catalog[0].id;
  }

  await loadClip(dataFile);
}

// ─── YouTube IFrame API ───────────────────────────────────────────────────────
function initYouTube(videoId) {
  const createPlayer = () => {
    player = new YT.Player("youtubePlayer", {
      videoId,
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        cc_load_policy: 0,
        cc_lang_pref: "none"
      },
      events: {
        onReady: () => {
          playerReady = true;
          disableSubtitles();
          play();
        },
        onApiChange: () => {
          disableSubtitles();
        },
        onStateChange: (event) => {
          disableSubtitles();
          if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
            updatePlayUI(false);
            stopLoopMonitor();
          } else if (event.data === YT.PlayerState.PLAYING) {
            updatePlayUI(true);
            startLoopMonitor();
          }
        }
      },
    });
  };

  if (window.YT && window.YT.Player) {
    createPlayer();
  } else {
    window.onYouTubeIframeAPIReady = createPlayer;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<p style="padding:2rem;color:red">${err.message}</p>`;
});
