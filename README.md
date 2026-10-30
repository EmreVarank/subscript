# 🎧 liscript

> Film ve dizi kesitleriyle İngilizce dinleme pratiği yapmanızı sağlayan yapay zeka destekli interaktif web platformu.

---

## 🌟 Özellikler

- **AI Tabanlı Transkripsiyon:** `faster-whisper` ile YouTube videolarındaki konuşmaları kelime ve salise düzeyinde zaman damgalarıyla çıkartır.
- **Akıllı Cümle Gruplama:** Doğal konuşma duraklamalarını (VAD) analiz ederek konuşmaları 2-3 cümlelik dinleme bloklarına böler.
- **İnteraktif Alıştırmalar:** Kelimeleri harf harf doldurabileceğiniz modern "tile" arayüzü.
- **Akıllı 3 Aşamalı İpucu:** 
  1. Türkçe anlam balonu
  2. İlk harfi açma
  3. Kelimeyi tamamlama
- **Oyunlaştırma (Gamification):** Doğru cevap serisi (Streak 🔥), doğruluk oranı ve bölüm sonu konfeti kutlaması.
- **Klip Kütüphanesi:** CEFR seviyelerine göre (B1, B2, C1) ayrılmış hazır film ve dizi kesitleri arasında anında geçiş.
- **Hile Önleme:** YouTube altyazılarını zorla kapatan ve ek kontrolleri engelleyen temiz video oynatıcı.

---

## 🚀 Hızlı Başlangıç

### 1. Gereksinimleri Yükleyin

```powershell
pip install -r requirements.txt
```

> **Not:** Sisteminizde `ffmpeg` yüklü olmalıdır (`winget install ffmpeg`).

### 2. Yeni Video Ekleyin

`urls.txt` dosyasını açıp dilediğiniz YouTube linklerini ekleyin:

```text
https://www.youtube.com/watch?v=VIDEO_ID | Dizi / Film Adı
```

Toplu işleme scriptini çalıştırın:

```powershell
python batch_transcribe.py
```

*Tek bir video eklemek için:*
```powershell
python transcribe.py --url "https://www.youtube.com/watch?v=VIDEO_ID" --title "Film Adı"
```

### 3. Uygulamayı Başlatın

Node.js API'si ve frontend'i birlikte başlatın (Node.js 18+):

```powershell
npm start
```

Tarayıcınızda açın:
👉 **`http://localhost:8080`**

İlk girişte kayıt olup seviyenizi seçebilirsiniz. Seviyesini bilmeyen kullanıcılar için üç soruluk mini seviye testi bulunur. Örneğin B1 kullanıcılarına B1 ve B2 klipleri önerilir.

Admin hesabını belirlemek için sunucuyu başlatmadan önce:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
npm start
```

Admin klip ekleme endpoint'i yalnızca bu e-posta ile giriş yapan kullanıcıya açıktır:

```text
POST /api/admin/clips
```

Klip ekleme gövdesi `id`, `title`, `level`, `youtubeId` ve `dataFile` alanlarını içermelidir. Bu ilk backend sürümü kullanıcıları `data/users.json` dosyasında saklar; üretime geçerken PostgreSQL'e taşınacaktır.

---

## 📁 Proje Yapısı

```
liscript/
├── clips/                # Üretilen alıştırma JSON ve TXT transkriptleri
├── app.js                # Frontend etkileşim mantığı ve YouTube Player yönetimi
├── server.js             # Node.js API, auth ve admin klip endpoint'leri
├── package.json          # Node.js çalıştırma komutları
├── data/users.json       # Yerel MVP kullanıcı verisi (git dışında)
├── batch_transcribe.py   # urls.txt üzerinden toplu video işleme scripti
├── clips.json            # Klip kataloğu ve seviye verileri
├── index.html            # Web arayüzü
├── style.css             # Karanlık mod modern arayüz stilleri
├── transcribe.py         # Tekil ses indirme ve Whisper transkripsiyon motoru
├── urls.txt              # İşlenecek YouTube linkleri listesi
├── requirements.txt      # Python bağımlılıkları
└── .gitignore            # Git dışı bırakılan geçici dosyalar
```

---

## ⌨️ Klavye Kısayolları

| Kısayol | İşlev |
|---|---|
| `Space` | Videoyu Oynat / Duraklat |
| `R` | Mevcut parçayı başa sar |
| `Tab` | İpucu al |
| `Enter` | Cevabı kontrol et / Sonraki parçaya geç |
| `← / →` | Harf kutucukları arasında gezin |
| `Backspace` | Harfi sil ve önceki kutuya dön |
