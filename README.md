# subscript

Film ve dizi sahneleriyle İngilizce dinleme pratiği sunan, Node.js tabanlı bir web uygulaması.

## Özellikler

- Landing sayfası ve kullanıcı kayıt/giriş akışı
- CEFR seviyelerine göre klip kataloğu
- YouTube tabanlı dinleme ve cümle tamamlama alıştırmaları
- Harf kutucuklarıyla cevaplama ve üç aşamalı ipucu sistemi
- İlerleme, doğruluk, seri ve profil istatistikleri
- Ayarlar, profil ve avatar özelleştirme ekranları
- Yönetici paneli üzerinden klip yönetimi
- Yerel admin ortamında Whisper ile transkripsiyon ve klip üretimi
- Açık/koyu tema ve tutarlı Sofia Sans tabanlı arayüz

## Teknoloji

- Node.js 22.5+
- Node.js `node:sqlite` ile yerel veri saklama
- Vanilla HTML, CSS ve JavaScript
- Python, `faster-whisper`, `yt-dlp` ve FFmpeg (yalnızca transkripsiyon araçları için)

## Hızlı başlangıç

### Gereksinimler

- Node.js 22.5 veya üzeri
- Transkripsiyon araçlarını kullanacaksan Python ve FFmpeg

FFmpeg Windows'ta şu komutla kurulabilir:

```powershell
winget install ffmpeg
```

### Uygulamayı çalıştırma

```powershell
npm start
```

Uygulama varsayılan olarak `http://localhost:8080` adresinde açılır.

Geliştirme sırasında aynı sunucuyu doğrudan şu komutla da çalıştırabilirsin:

```powershell
npm run dev
```

### Testleri çalıştırma

```powershell
npm test
```

## Route'lar

| Route | Açıklama |
|---|---|
| `/` | Tanıtım ve landing sayfası |
| `/ogren` | Korumalı öğrenme uygulaması |
| `/settings/account` | Hesap ayarları |
| `/settings/profile` | Profil ayarları |
| `/settings/courses` | Öğrenme alanları |
| `/admin` | Yönetici paneli |
| `/analysis` | Proje analiz ekranı |

Korumalı route'lar geçerli oturum yoksa landing sayfasına yönlendirilir.

## Admin yapılandırması

Sunucuyu başlatmadan önce admin hesabının e-posta adresini tanımlayabilirsin:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
npm start
```

Admin klip endpoint'leri:

```text
POST   /api/admin/clips
PUT    /api/admin/clips/:id
DELETE /api/admin/clips/:id
GET    /api/admin/overview
POST   /api/admin/transcribe
GET    /api/admin/jobs/:jobId
```

Transkripsiyon ve YouTube işleme normal kullanıcı akışının parçası değildir; yerel admin ortamında çalıştırılmalıdır.

## Veri ve içerik

- Kullanıcı ve oturum verileri: `data/subscript.sqlite`
- Klip kataloğu: `clips.json`
- Klip transkriptleri: `clips/`
- Eski kullanıcı geçiş kaynağı: `data/users.json`
- Toplu transkripsiyon girdileri: `urls.txt`

Yerel veritabanı, kullanıcı verileri ve model çıktıları Git'e dahil edilmemelidir.

## Transkripsiyon araçları

Bağımlılıkları kur:

```powershell
pip install -r requirements.txt
```

Toplu işleme:

```powershell
python batch_transcribe.py
```

Tek video işleme:

```powershell
python transcribe.py --url "https://www.youtube.com/watch?v=VIDEO_ID" --title "Film Adı"
```

## Proje yapısı

```text
subscript/
├── landing.html       # Landing sayfası
├── landing.css        # Landing stilleri
├── landing.js         # Landing ve auth modal davranışları
├── index.html         # Öğrenme, profil ve ayarlar arayüzü
├── style.css          # Uygulama stilleri ve tema sistemi
├── admin.html         # Yönetim paneli
├── analysis.html      # Analiz ekranı
├── app.js             # Uygulama etkileşimleri ve API istemcisi
├── server.js          # HTTP sunucusu, route'lar ve API
├── clips.json         # Klip kataloğu
├── clips/             # Klip veri dosyaları
├── data/              # Yerel veriler ve SQLite veritabanı
├── transcribe.py      # Tekil transkripsiyon
├── batch_transcribe.py # Toplu transkripsiyon
├── requirements.txt   # Python bağımlılıkları
└── test/              # Node.js testleri
```

## Klavye kısayolları

| Kısayol | İşlev |
|---|---|
| `Space` | Oynat / duraklat |
| `R` | Mevcut parçayı başa sar |
| `Tab` | İpucu al |
| `Enter` | Cevabı kontrol et veya sonraki parçaya geç |
| `← / →` | Harf kutucukları arasında gezin |
| `Backspace` | Harfi sil ve önceki kutuya dön |

## Üretim notu

Bu proje yerel tek sunuculu MVP olarak yapılandırılmıştır. Üretime geçmeden önce PostgreSQL, gizli ortam değişkenleri, rate limiting, e-posta doğrulama ve şifre sıfırlama akışları eklenmelidir.
