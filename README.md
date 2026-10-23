<div align="center">

# Fiala

### Evin dijital ilaç dolabı — yapım aşamasında.

*A local-first Expo + Supabase medicine cabinet for a household: the boxes at
home, whose they are, their expiry and stock. iOS, Android and the web from one
codebase.*

[![Expo SDK 57](https://img.shields.io/badge/Expo-SDK%2057-0F0F0D?logo=expo&logoColor=white)](https://docs.expo.dev/versions/v57.0.0/)
[![Node 22](https://img.shields.io/badge/Node-22-0F0F0D?logo=nodedotjs&logoColor=5FA04E)](#geliştirici-kurulumu)
[![Proprietary](https://img.shields.io/badge/license-proprietary-A55335)](LICENSE)

</div>

---

## Şu an ne var?

Uygulamanın kabuğu ve dört sekmesi: Durum, Dolabım, Rehber, Ayarlar. Açılır,
giriş yapılır, ayarlar bulutla eşitlenir, açılış işareti çizilir; ilaç ekleme ve
dolap sırayla geliyor.

- **Önce cihaz.** Her yazma cihazdaki SQLite veritabanına iner — veri satırı ve
  outbox kaydı tek transaction içinde. Bağlantı gelince outbox Supabase'e gider.
- **Hesap.** E-posta ve şifre, e-postaya gelen 6 haneli kodla doğrulama,
  şifre ve e-posta değişikliği, hesabı dondurma ve silme.
- **Eşitleme.** Silmeler tombstone'dur; reddedilen kayıt karantinaya alınır ve
  Ayarlar'da yazılır, ötekiler gitmeye devam eder.
- **Geri bildirim** ve KVKK **Aydınlatma Metni**.
- **Tema.** Açık/koyu ve üç palet; hareket azaltma tercihi hareketi durdurur.

---

## Geliştirici kurulumu

> **Node 22 zorunlu** (`.nvmrc`) — Expo SDK 57'nin derleyip test ettiği sürüm.

```bash
git clone https://github.com/topraksv/fiala.git
cd fiala
npm ci
cp .env.example .env             # boş bırakılırsa: yerel-yalnız geliştirme derlemesi

npm run web                      # tarayıcıda aç
npx expo start --tunnel --clear  # Expo Go
```

### Kalite kapısı

```bash
npm run verify        # typecheck + dosya başına kapsama eşikli Vitest + lint ratchet
npm run test:e2e      # Playwright: tarayıcı senaryoları
npm run verify:full   # + production export, bundle bütçesi, tüm Playwright
```

`lint-baseline.json` her lint kuralının kaç kez tetiklendiğini kaydeder ve daha
sık tetiklenmesi push'u düşürür. `mutation-baseline.json` kapsamdaki her
dosyanın mutasyon puanını tutar; düşemez.

### Kod haritası

| Klasör | Sorumluluk |
|---|---|
| `src/app/` | Expo Router rotaları ve ekran orkestrasyonu. Yaprak katman: kimse rotaları import etmez |
| `src/domain/` | Saf kurallar. React'sız, testlenebilir |
| `src/data/` | Kalıcılık cephesi ve canlı sorgu hook'ları |
| `src/db/` | Şema, migration'lar, atomik yazma katmanı |
| `src/sync/` | Outbox, birleştirme politikası, karantina |
| `src/auth/` | Oturum, hesap dondurma, giriş kaydı |
| `src/services/` | Yan etkili entegrasyonlar: geri bildirim, paylaşım, cihaz deposu |
| `src/ui/` | Tasarım sistemi ilkelleri ve tokenlar |
| `src/i18n/` | Arayüzdeki her metin |
| `supabase/` | Sunucu migration'ları, RLS testleri (pgTAP), geri bildirim fonksiyonu |
| `tests/<katman>/`, `e2e/` | Birim ve sözleşme testleri kaynağın katman adıyla; tarayıcı senaryoları |

Bağımlılık yönü `app → data → db` ve `app → domain`.

---

## Lisans / License

**Proprietary — all rights reserved.** © 2026 Ömer Toprak Şavlı.

Kaynak; şeffaflık ve inceleme için görünürdür, açık kaynak değildir. Yazılı izin
olmadan çalıştırma, kopyalama, değiştirme, dağıtma veya ticari kullanım hakkı
vermez. Tam koşullar [LICENSE](LICENSE) içinde.
