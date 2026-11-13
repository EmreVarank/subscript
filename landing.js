const clips = [
  { title: "Breaking Bad", level: "B2", youtubeId: "MPYlxeG-8_w" },
  { title: "Sons of Anarchy", level: "B1", youtubeId: "661f6PkKOL0" },
  { title: "The Office", level: "B1", youtubeId: "gO8N3L_aERg" },
  { title: "Game of Thrones", level: "B2", youtubeId: "oUjaljMMy2M" },
  { title: "The Godfather", level: "C1", youtubeId: "4m8f8dLa_ig" }
];

const backdrop = document.getElementById("landingBackdrop");
const clipGrid = document.getElementById("landingClipGrid");
const count = document.getElementById("heroClipCount");
let current = 0;

function renderLibrary(libraryClips) {
  clipGrid.innerHTML = libraryClips.map((clip, index) => `
    <a class="landing-clip" href="/ogren?data=${encodeURIComponent(clip.id || clip.title)}">
      <span class="landing-clip-index">${String(index + 1).padStart(2, "0")}</span>
      <img src="https://img.youtube.com/vi/${clip.youtubeId}/mqdefault.jpg" alt="${clip.title}" loading="lazy" />
      <div><strong>${clip.title}</strong><small>${clip.level || "B1"} · Dinleme pratiği</small></div>
    </a>
  `).join("");
}

function showClip() {
  const clip = clips[current % clips.length];
  backdrop.style.backgroundImage = `url("https://img.youtube.com/vi/${clip.youtubeId}/maxresdefault.jpg")`;
  current += 1;
}

count.textContent = clips.length;
showClip();
window.setInterval(showClip, 2000);
renderLibrary(clips);

fetch("/api/clips")
  .then((response) => response.ok ? response.json() : null)
  .then((data) => {
    if (data?.clips?.length) {
      count.textContent = data.clips.length;
      renderLibrary(data.clips);
    }
  })
  .catch(() => {});
