# Değişiklik Kaydı

Her sürümde neyin değiştiği, en yeni üstte. Sürüm numarası `app.json`
içindeki `expo.version`'dır; yeni bir yetenek küçük sürümü, bir düzeltme yamayı,
senden bir şey yapmanı isteyen değişiklik büyük sürümü artırır.

Notlar kısa tutulur: ne değişti, tek cümle. Sebebi ve ölçümü commit'te.
`scripts/release-notes.mjs` bir bölümü etiketinin GitHub sürüm notuna çevirir;
bölümü olmayan sürüm yayımlanamaz.

## 0.2.0

### Minor Changes

- İlaç dolabı: kutuyu karekodla, barkodla, TİTCK listesinden ya da elle eklersin; kimin olduğu, yeri, son kullanma tarihi ve kalan miktarı tutulur, süresi yaklaşan ve azalan Durum'da sayılır.
- Hane: dolabı davetle evdekilerle paylaşırsın; kimin neyi değiştirdiği yazar, değişiklik öteki telefona anında düşer.
- Reçete, tahlil, epikriz ve doktor notu dosyasıyla saklanır; kişi başına doz planı alındı, atlandı ya da ertelendi diye kaydedilir.
- Rehber: TİTCK listesindeki ilaçlar, prospektüsleri bölüm bölüm, iki ilacın karşılaştırması ve yakındaki eczaneler.
- Dolabı dışa aktarır, yedekler ve geri yüklersin (Ayarlar → Veri ve Gizlilik).
- Kişiye alerjilerini ve kronik hastalıklarını yazarsın; kişinin sayfasından açılan acil durum kartı bunları ve şu an aldığı ilaçları büyük yazıyla gösterir ve paylaşır.
- Aynı etken maddeden bir ilaç o kişide zaten varken yenisini eklersen uyarır.
- Süresi geçen ilacın nasıl atılacağı, Sıfır Atık kılavuzuyla birlikte, kutunun ve "Atılacaklar"ın sayfasında.

### Patch Changes

- Durum sadeleşti: "Evde var mı?" araması kalktı (Dolabım'da aynısı var); ilk açılışta yalnız süresi geçenler, yaklaşanlar, dozlar ve listeler görünür, öteki kartlar "Kartları Düzenle"de.
- İlacın sayfası kutularıyla açılır; etiket, fotoğraf ve bilgiler "Düzenle"nin altında.
- Her dozda iki düğme var, Aldım ve Atladım; erteleme ve "kaçırdım" "…" altında.
- Fiala'nın kendi rengi Adaçayı varsayılan palet oldu; işaret seçtiğin palete göre renk alır.
- Sunucu bir fotoğrafı ya da belgeyi kabul etmezse sessiz kalmıyor, o kaydın üstünde söylüyor.
- Doz hatırlatmaları biteceği zaman, uygulamayı bir kez açmanı hatırlatan bir bildirim geliyor.
- Silinen ya da sıfırlanan bir kaydın içeriği sunucuda da siliniyor; geriye yalnız eşitlemenin gerektirdiği işaret kalıyor.

## 0.1.0

### Minor Changes

- İlk iskelet: açılış işareti, giriş ve hesap güvenliği, ayarlar, eşitleme, geri bildirim ve aydınlatma metni var; uygulamanın kendi özelliği henüz yok.
