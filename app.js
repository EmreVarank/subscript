// ─── Config ───────────────────────────────────────────────────────────────────
const CLIPS_CATALOG = "/api/clips";

// Sözlük eşleştirmeleri ve dinamik önbellek
const wordMeaningCache = new Map();

async function fetchMeaning(rawWord) {
  const clean = String(rawWord || "").toLowerCase().replace(/[^a-z']/g, "").trim();
  if (!clean) return "bağlamdan çıkarınız";
  if (wordMeaningCache.has(clean)) return wordMeaningCache.get(clean);

  try {
    const res = await fetch(`/api/dictionary/${encodeURIComponent(clean)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.meaning) {
        wordMeaningCache.set(clean, data.meaning);
        return data.meaning;
      }
    }
  } catch {}
  return "bağlamdan çıkarınız";
}

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
  String(v || "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']/g, "")
    .trim();

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
    // 1. Kademe: Dinamik Türkçe Anlam Balonunu aç
    wordGroups.forEach(async (groupEl) => {
      const rawWord = groupEl.dataset.word.toLowerCase();
      const bubble = groupEl.querySelector(".hint-meaning-bubble");
      if (bubble) {
        bubble.textContent = "…";
        bubble.style.display = "block";
        const meaning = await fetchMeaning(rawWord);
        bubble.textContent = meaning;
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
  const incompleteWords = [];
  const wrongWords = [];

  wordGroups.forEach((groupEl) => {
    const tiles = [...groupEl.querySelectorAll(".tile-char-input")];
    const userWord = normalize(tiles.map((t) => t.value).join(""));
    const targetWord = normalize(tiles.map((t) => t.dataset.expected).join(""));

    if (userWord.length < targetWord.length) {
      allFilled = false;
      incompleteWords.push(groupEl.dataset.word);
    }

    const isMatch = userWord === targetWord;
    groupEl.classList.remove("is-correct", "is-wrong");
    void groupEl.offsetWidth; // Reflow tetikle

    if (isMatch) {
      groupEl.classList.add("is-correct");
    } else {
      groupEl.classList.add("is-wrong");
      allCorrect = false;
      wrongWords.push(groupEl.dataset.word);
    }
  });

  if (!allFilled) {
    feedback.className = "feedback partial";
    feedback.textContent = `Eksik kelime${incompleteWords.length > 1 ? "ler" : ""}: ${incompleteWords.join(", ")}.`;
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

    // İlerlemeyi sunucuya kaydet
    if (authToken) {
      apiRequest('/api/progress', {
        method: 'POST',
        body: JSON.stringify({
          clipId: currentDataFile,
          groupIndex: current,
          completed: true,
          firstTry: isCurrentPartFirstTry,
          attempts: hintStage > 0 ? hintStage + 1 : 1
        })
      }).catch(() => {});
    }

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
    feedback.textContent = `Kontrol edilemeyen kelime${wrongWords.length > 1 ? "ler" : ""}: ${wrongWords.join(", ")}.`;
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
let loginMode = "login";
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
  if (localStorage.getItem("subscript_onboarding_seen") === "1" || authToken) {
    authBackdrop.classList.remove("open");
  }
  showStep("welcomeStep");
  $("welcomeContinue").addEventListener("click", () => showStep("profileStep"));
  $("onboardingLogin").addEventListener("click", openLoginModal);
  $("profileBack").addEventListener("click", () => showStep("welcomeStep"));
  $("profileContinue").addEventListener("click", () => {
    const name = $("authName").value.trim();
    if (!name) {
      $("authError").textContent = "Adını yazman yeterli.";
      return;
    }
    localStorage.setItem("subscript_name", name);
    localStorage.setItem("subscript_onboarding_seen", "1");
    $("authBackdrop").classList.remove("open");
    showLevelPicker();
  });
  $("skipOnboarding").addEventListener("click", () => {
    localStorage.setItem("subscript_onboarding_seen", "1");
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
  setLoginMode("login");
  setLoginError("loginEmailError", "");
  setLoginError("loginPasswordError", "");
  setLoginError("loginSubmitError", "");
  $("loginPassword").type = "password";
  $("toggleLoginPassword").textContent = "Göster";
  loginBackdrop.classList.add("open");
  loginBackdrop.setAttribute("aria-hidden", "false");
  window.setTimeout(() => $("loginEmail").focus(), 100);
}

function setLoginMode(mode) {
  loginMode = mode;
  const isRegister = mode === "register";
  document.querySelectorAll(".login-name-field").forEach((element) => {
    element.hidden = !isRegister;
  });
  $("loginTitle").textContent = isRegister ? "Kendi hesabını oluştur." : "Kaldığın yerden devam et.";
  document.querySelector(".login-form-subtitle").textContent = isRegister
    ? "İlerlemeni kaydetmek için bir dakikadan kısa sürede hesabını oluştur."
    : "İlerlemeni ve favori kliplerini kaydetmek için giriş yap.";
  $("loginSubmitLabel").textContent = isRegister ? "Hesap oluştur" : "Giriş yap";
  $("loginAccountPrompt").textContent = isRegister ? "Zaten hesabın var mı?" : "Henüz hesabın yok mu?";
  $("loginRegisterHint").textContent = isRegister ? "Giriş yap" : "Ücretsiz başla";
}

async function submitLogin(event) {
  event.preventDefault();
  if (authToken) {
    closeLoginModal();
    return;
  }

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const name = $("loginName").value.trim();
  setLoginError("loginNameError", loginMode === "register" && !name ? "Adını yaz." : "");
  setLoginError("loginEmailError", !email ? "E-posta adresini yaz." : !email.includes("@") ? "Geçerli bir e-posta adresi yaz." : "");
  setLoginError("loginPasswordError", !password ? "Şifreni yaz." : password.length < 8 ? "Şifren en az 8 karakter olmalı." : "");
  setLoginError("loginSubmitError", "");
  if (!email || !email.includes("@") || !password || password.length < 8 || (loginMode === "register" && !name)) return;

  setLoginBusy(true);
  try {
    const result = await apiRequest(loginMode === "register" ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ name, email, password, remember: $("loginRemember").checked })
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

async function loadUserStats() {
  if (!authToken) return;
  try {
    const stats = await apiRequest('/api/stats');
    if ($('profileMinutes')) $('profileMinutes').textContent = Math.round(stats.totalMinutes || 0);
    if ($('profileAccuracy')) $('profileAccuracy').textContent = stats.accuracy ? `%${Math.round(stats.accuracy)}` : '—';
    if ($('profileStreak')) $('profileStreak').textContent = stats.currentStreak || 0;
    if ($('profilePoints')) $('profilePoints').textContent = stats.totalPoints || 0;
    if ($('profileCompletedCount')) $('profileCompletedCount').textContent = stats.totalCompleted || 0;
  } catch {}
}

function updateProfileUI() {
  const storedName = localStorage.getItem("subscript_name");
  const name = authUser?.name || storedName || "Misafir";
  const level = authUser?.level || localStorage.getItem("subscript_level");
  const language = localStorage.getItem("subscript_language") || "en";
  const flags = { en: "🇬🇧", de: "🇩🇪", fr: "🇫🇷", es: "🇪🇸" };
  const initial = getInitials(name);
  applyAvatarStyle(initial);
  $("headerProfileName").textContent = name;
  $("menuProfileName").textContent = name;
  $("menuProfileLevel").textContent = level ? `İngilizce · ${level}` : "İngilizce · Seviye seçilmedi";
  $("profileLogin").hidden = Boolean(authUser);
  $("profileLogout").hidden = !authUser;
  if ($("adminNavItem")) $("adminNavItem").hidden = !authUser?.isAdmin;
  if ($("profilePageAvatar")) $("profilePageAvatar").textContent = initial;
  if ($("profilePageName")) $("profilePageName").textContent = name;
  if ($("profilePageEmail")) $("profilePageEmail").textContent = authUser?.email || "Misafir olarak devam ediyorsun";
  if ($("profilePageLevel")) $("profilePageLevel").textContent = level ? `İngilizce · ${level}` : "Seviye seçilmedi";
  if ($("profileLevel")) $("profileLevel").textContent = level || "Seçilmedi";
  if ($("profileLanguage")) $("profileLanguage").textContent = `${flags[language] || flags.en} İngilizce`;
}

function getInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "S";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  return `${Array.from(parts[0])[0] || ""}${Array.from(parts[parts.length - 1])[0] || ""}`.toUpperCase();
}

function applyAvatarStyle(initials) {
  const color = authUser?.avatarColor || localStorage.getItem("subscript_avatar_color") || "violet";
  document.querySelectorAll(".avatar").forEach((avatar) => {
    avatar.textContent = initials;
    avatar.classList.remove("avatar-color-violet", "avatar-color-ocean", "avatar-color-sunset", "avatar-color-mint", "avatar-color-rose", "avatar-color-slate");
    avatar.classList.add(`avatar-color-${color}`);
  });
}

function routeForSection(section) {
  if (section === "profile") return "/profil";
  if (section === "admin") return "/admin";
  return "/ogren";
}

function sectionForPath(pathname) {
  if (pathname === "/profil") return "profile";
  if (pathname === "/admin") return "admin";
  return "learn";
}

function showSection(section, updateUrl = true) {
  if (section === "admin" && !authUser?.isAdmin) {
    section = "learn";
  }
  const isProfile = section === "profile";
  const isLearn = section === "learn";
  const isAdmin = section === "admin";
  document.querySelectorAll(".side-nav-item").forEach((navItem) => {
    navItem.classList.toggle("active", navItem.dataset.section === section);
  });
  $("profileView").hidden = !isProfile;
  $("adminView").hidden = !isAdmin;
  document.querySelector(".lesson-head").hidden = !isLearn;
  document.querySelector(".main-layout").hidden = !isLearn;
  $("libraryTriggerBtn").hidden = !isLearn;
  const headerTitle = document.querySelector(".header-context strong");
  if (headerTitle) headerTitle.textContent = isProfile ? "Profil" : isAdmin ? "Admin" : "Öğren";
  if (isProfile) { updateProfileUI(); loadUserStats(); }
  if (isAdmin) loadAdminView();
  if (isLearn) ensureLearnView();
  if (updateUrl && window.location.pathname !== routeForSection(section)) {
    const url = new URL(window.location);
    url.pathname = routeForSection(section);
    window.history.pushState({ section }, "", url);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

let adminViewLoaded = false;
let adminViewLoading = null;
let learnViewLoaded = false;
let learnViewLoading = null;

async function loadAdminView() {
  if (adminViewLoaded || adminViewLoading) return adminViewLoading;
  adminViewLoading = fetch("/admin.html")
    .then((response) => {
      if (!response.ok) throw new Error("Admin paneli yüklenemedi.");
      return response.text();
    })
    .then(async (html) => {
      const documentFragment = new DOMParser().parseFromString(html, "text/html");
      const content = documentFragment.querySelector(".admin-content");
      const script = Array.from(documentFragment.querySelectorAll("script"))
        .find((candidate) => candidate.textContent.includes("initAdminPanel"));
      if (!content || !script) throw new Error("Admin paneli yapısı eksik.");
      $("adminView").innerHTML = content.innerHTML;
      const adminScript = document.createElement("script");
      adminScript.textContent = script.textContent;
      $("adminView").appendChild(adminScript);
      if (typeof window.initAdminPanel !== "function") {
        throw new Error("Admin paneli başlatılamadı.");
      }
      await window.initAdminPanel();
      adminViewLoaded = true;
    })
    .catch((error) => {
      $("adminView").innerHTML = `<div class="profile-section-card"><p class="feedback">${error.message}</p></div>`;
      throw error;
    })
    .finally(() => {
      adminViewLoading = null;
    });
  return adminViewLoading;
}

async function ensureLearnView() {
  if (learnViewLoaded || learnViewLoading) return learnViewLoading;
  learnViewLoading = (async () => {
    await loadCatalog();
    const params = new URLSearchParams(window.location.search);
    const dataFile = params.get("data") || globalCatalog[0]?.id;
    if (!dataFile) {
      document.body.innerHTML = "<p style='padding:2rem'>Henüz hiç klip eklenmemiş.</p>";
      return;
    }
    await loadClip(dataFile);
    learnViewLoaded = true;
  })().finally(() => {
    learnViewLoading = null;
  });
  return learnViewLoading;
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
    setLoginMode(loginMode === "register" ? "login" : "register");
    setLoginError("loginSubmitError", "");
  });
  $("forgotPasswordButton").addEventListener("click", async () => {
    const email = $("loginEmail").value.trim();
    if (!email || !email.includes("@")) {
      setLoginError("loginEmailError", "Sıfırlama linki için geçerli e-postanızı yazınız.");
      return;
    }
    try {
      setLoginBusy(true);
      const res = await apiRequest("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email })
      });
      setLoginError("loginSubmitError", res.message || "Sıfırlama bağlantısı gönderildi.");
    } catch (err) {
      setLoginError("loginSubmitError", err.message || "İşlem başarısız.");
    } finally {
      setLoginBusy(false);
    }
  });

  const handleGoogleLogin = async () => {
    try {
      setLoginBusy(true);
      setLoginError("loginSubmitError", "");

      // 1. Google Client ID yapılandırmasını kontrol et
      let googleClientId = "";
      try {
        const cfg = await apiRequest("/api/config/auth");
        googleClientId = cfg?.googleClientId || "";
      } catch {}

      // 2. Client ID tanımlıysa resmi Google Identity Services popup'ını tetikle
      if (googleClientId && window.google?.accounts?.id) {
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            try {
              setLoginBusy(true);
              const result = await apiRequest("/api/auth/google", {
                method: "POST",
                body: JSON.stringify({ credential: response.credential })
              });
              authToken = result.token;
              authUser = result.user;
              localStorage.setItem("subscript_token", authToken);
              if (authUser.name) localStorage.setItem("subscript_name", authUser.name);
              closeLoginModal();
              updateProfileUI();
              await loadCatalog();
            } catch (err) {
              setLoginError("loginSubmitError", err.message || "Google girişi doğrulanamadı.");
            } finally {
              setLoginBusy(false);
            }
          }
        });
        google.accounts.id.prompt();
        setLoginBusy(false);
        return;
      }

      // 3. Client ID henüz girilmemişse kullanıcıyı şeffaf bilgilendir
      const userChoice = confirm(
        "Google Giriş Entegrasyonu:\n\n" +
        "Gerçek Google hesap seçme ekranı (accounts.google.com) için .env dosyasında GOOGLE_CLIENT_ID tanımlanmalıdır.\n\n" +
        "Şimdi test hesabıyla giriş yapmak ister misiniz?"
      );

      if (userChoice) {
        const result = await apiRequest("/api/auth/oauth", {
          method: "POST",
          body: JSON.stringify({ provider: "google", name: "Google Kullanıcısı" })
        });
        authToken = result.token;
        authUser = result.user;
        localStorage.setItem("subscript_token", authToken);
        if (authUser.name) localStorage.setItem("subscript_name", authUser.name);
        closeLoginModal();
        updateProfileUI();
        await loadCatalog();
      }
    } catch (err) {
      setLoginError("loginSubmitError", err.message || "Giriş işlemi tamamlanamadı.");
    } finally {
      setLoginBusy(false);
    }
  };

  const handleAppleLogin = async () => {
    try {
      setLoginBusy(true);
      const userChoice = confirm(
        "Apple ile Giriş Entegrasyonu:\n\n" +
        "Gerçek Apple ID ile oturum açmak için Apple Developer Program hesabı ve Service ID gereklidir.\n\n" +
        "Şimdi Apple test hesabıyla giriş yapmak ister misiniz?"
      );
      if (userChoice) {
        const result = await apiRequest("/api/auth/oauth", {
          method: "POST",
          body: JSON.stringify({ provider: "apple", name: "Apple Kullanıcısı" })
        });
        authToken = result.token;
        authUser = result.user;
        localStorage.setItem("subscript_token", authToken);
        if (authUser.name) localStorage.setItem("subscript_name", authUser.name);
        closeLoginModal();
        updateProfileUI();
        await loadCatalog();
      }
    } catch (err) {
      setLoginError("loginSubmitError", err.message || "Apple girişi başarısız.");
    } finally {
      setLoginBusy(false);
    }
  };

  $("googleLoginButton").addEventListener("click", handleGoogleLogin);
  $("appleLoginButton").addEventListener("click", handleAppleLogin);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".header-profile-wrap")) $("profileMenu").hidden = true;
  });
  document.querySelectorAll(".side-nav-item, [data-profile-action], .profile-action-button").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (item.tagName === "A") {
        event.preventDefault();
      }
      const section = item.dataset.section || item.dataset.profileAction;
      $("profileMenu").hidden = true;
      if (section === "learn" || section === "profile" || section === "admin") {
        showSection(section);
      }
    });
  });
  window.addEventListener("popstate", () => showSection(sectionForPath(window.location.pathname), false));
  // ── Ayarlar Modalı Yönetimi ───────────────────────────────────────────────
  const settingsBackdrop = $("settingsBackdrop");

  const openSettingsModal = () => {
    if (!authToken) {
      openLoginModal();
      return;
    }
    $("profileMenu").hidden = true;
    $("settingsNameInput").value = authUser?.name || localStorage.getItem("subscript_name") || "";
    document.querySelectorAll("[data-avatar-color]").forEach((button) => {
      button.classList.toggle("selected", button.dataset.avatarColor === (authUser?.avatarColor || "violet"));
    });
    $("settingsCurrentPass").value = "";
    $("settingsNewPass").value = "";
    $("settingsPassMsg").textContent = "";

    const plan = (authUser?.plan || "free").toUpperCase();
    const badge = $("settingsPlanBadge");
    if (badge) {
      badge.textContent = plan;
      badge.style.background = plan === "PRO" ? "#10b981" : "#6366f1";
    }
    const upBtn = $("upgradePlanBtn");
    if (upBtn) {
      upBtn.textContent = plan === "PRO" ? "Aboneliğiniz Aktif (Pro)" : "Pro Plana Yükselt (Stripe)";
      upBtn.disabled = plan === "PRO";
    }

    settingsBackdrop.classList.add("open");
    settingsBackdrop.setAttribute("aria-hidden", "false");
  };

  const closeSettingsModal = () => {
    if (!settingsBackdrop) return;
    settingsBackdrop.classList.remove("open");
    settingsBackdrop.setAttribute("aria-hidden", "true");
  };

  if ($("closeSettingsButton")) $("closeSettingsButton").addEventListener("click", closeSettingsModal);
  if (settingsBackdrop) {
    settingsBackdrop.addEventListener("click", (e) => {
      if (e.target === settingsBackdrop) closeSettingsModal();
    });
  }

  // İsim güncelleme formu
  if ($("updateNameForm")) {
    $("updateNameForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const newName = $("settingsNameInput").value.trim();
      if (!newName) return;
      try {
        const res = await apiRequest("/api/profile/update", {
          method: "POST",
          body: JSON.stringify({
            name: newName,
            avatarColor: authUser?.avatarColor || localStorage.getItem("subscript_avatar_color") || "violet"
          })
        });
        authUser = res.user;
        localStorage.setItem("subscript_name", newName);
        localStorage.setItem("subscript_avatar_color", authUser.avatarColor);
        updateProfileUI();
        alert("Adınız başarıyla güncellendi.");
      } catch (err) {
        alert("Hata: " + err.message);
      }
    });
  }

  document.querySelectorAll("[data-avatar-color]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!authUser) return;
      try {
        const res = await apiRequest("/api/profile/update", {
          method: "POST",
          body: JSON.stringify({
            name: authUser.name,
            avatarColor: button.dataset.avatarColor
          })
        });
        authUser = res.user;
        localStorage.setItem("subscript_avatar_color", authUser.avatarColor);
        document.querySelectorAll("[data-avatar-color]").forEach((item) => {
          item.classList.toggle("selected", item === button);
        });
        updateProfileUI();
      } catch (error) {
        alert("Avatar rengi güncellenemedi: " + error.message);
      }
    });
  });

  // Şifre değiştirme formu
  if ($("updatePasswordForm")) {
    $("updatePasswordForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const currentPassword = $("settingsCurrentPass").value;
      const newPassword = $("settingsNewPass").value;
      const msgEl = $("settingsPassMsg");

      if (newPassword.length < 8) {
        msgEl.textContent = "Yeni şifre en az 8 karakter olmalı.";
        return;
      }
      try {
        msgEl.style.color = "var(--muted)";
        msgEl.textContent = "Güncelleniyor…";
        const res = await apiRequest("/api/profile/password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword })
        });
        msgEl.style.color = "#10b981";
        msgEl.textContent = res.message || "Şifreniz değiştirildi.";
        $("settingsCurrentPass").value = "";
        $("settingsNewPass").value = "";
      } catch (err) {
        msgEl.style.color = "#ef4444";
        msgEl.textContent = err.message;
      }
    });
  }

  // Stripe Pro Yükseltme
  if ($("upgradePlanBtn")) {
    $("upgradePlanBtn").addEventListener("click", async () => {
      try {
        const res = await apiRequest("/api/subscription/create-checkout-session", {
          method: "POST",
          body: JSON.stringify({ plan: "pro_monthly" })
        });

        if (res.url) {
          window.location.href = res.url;
        } else {
          // Stripe anahtarı henüz .env'de yoksa geliştirici modu
          const choice = confirm(
            "Stripe Ödeme Entegrasyonu:\n\n" +
            "Gerçek kredi kartı tahsilatı için .env dosyasında STRIPE_SECRET_KEY tanımlanmalıdır.\n\n" +
            "Şimdi hesabınızı doğrudan PRO plana yükseltmek istiyor musunuz?"
          );
          if (choice) {
            const upRes = await apiRequest("/api/subscription/upgrade", {
              method: "POST",
              body: JSON.stringify({ plan: "pro" })
            });
            authUser.plan = "pro";
            openSettingsModal();
            updateProfileUI();
            alert("Tebrikler! Hesabınız Pro seviyesine yükseltildi.");
          }
        }
      } catch (err) {
        alert("Abonelik hatası: " + err.message);
      }
    });
  }

  document.querySelectorAll("[data-section='settings']").forEach((item) => {
    item.addEventListener("click", () => {
      openSettingsModal();
    });
  });
  $("profileLogout").addEventListener("click", async () => {
    try {
      if (authToken) await apiRequest("/api/auth/session", { method: "DELETE" });
    } catch (error) {
      console.error("Oturum sunucudan silinemedi:", error);
    } finally {
      authToken = "";
      authUser = null;
      localStorage.removeItem("subscript_token");
      sessionStorage.removeItem("subscript_token");
      $("profileMenu").hidden = true;
      updateProfileUI();
    }
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
  
  const catalogItem = globalCatalog.find((c) => c.id === dataFile);
  const level = (catalogItem && catalogItem.level) || data.level || "B1";

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
  const requestedSection = sectionForPath(window.location.pathname);
  showSection(requestedSection, false);
  const authenticated = await ensureAuthenticated();
  updateProfileUI();
  if (authenticated) authBackdrop.classList.remove("open");
  showSection(authenticated && requestedSection === "admin" ? "admin" : requestedSection === "admin" ? "learn" : requestedSection, false);

  // E-posta doğrulama banner'ı
  if (authenticated && authUser && !authUser.emailVerified) {
    const banner = document.createElement('div');
    banner.id = 'verifyBanner';
    banner.style.cssText = 'background:#f97316;color:#fff;text-align:center;padding:8px 16px;font-size:13px;font-weight:600;cursor:default;';
    banner.textContent = '📧 E-posta adresinizi doğrulamanız gerekmektedir. Gelen kutunuzu kontrol edin.';
    document.body.prepend(banner);
  }
  if (requestedSection === "admin") {
    if (authUser?.isAdmin) {
      await loadAdminView();
    }
    return;
  }
  await ensureLearnView();
  // Event listeners for Library
  if ($("libraryTriggerBtn")) $("libraryTriggerBtn").addEventListener("click", openLibraryModal);
  if ($("changeClipLink")) $("changeClipLink").addEventListener("click", openLibraryModal);
  if ($("closeLibraryBtn")) $("closeLibraryBtn").addEventListener("click", closeLibraryModal);
  if ($("libraryModal")) {
    $("libraryModal").addEventListener("click", (e) => {
      if (e.target === $("libraryModal")) closeLibraryModal();
    });
  }

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
