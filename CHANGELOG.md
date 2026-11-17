# Değişiklik Kaydı

Her sürümde neyin değiştiği, en yeni üstte. Sürüm numarası `app.json`
içindeki `expo.version`'dır; yeni bir yetenek küçük sürümü, bir düzeltme yamayı,
senden bir şey yapmanı isteyen değişiklik büyük sürümü artırır.

Notlar kısa tutulur: ne değişti, tek cümle. Sebebi ve ölçümü commit'te.
`scripts/release-notes.mjs` bir bölümü etiketinin GitHub sürüm notuna çevirir;
bölümü olmayan sürüm yayımlanamaz.

## 0.3.0

### Minor Changes

- Yeni "Geçmiş ve Raporlar" sayfası: hangi kutunun ne zaman eklendiği, kullanıldığı, düzenlendiği ve bittiği süzülerek görülüyor; SKT'si yaklaşan, geçen, bilgisi eksik kutular sayılıyor ve seçilen ilaçlar doktor ya da eczacıyla düz metin olarak paylaşılabiliyor.
- Bir belge hanenin tamamı yerine yalnız seçilen kişilere gösterilebiliyor.
- Yedek artık belgeleri ve fotoğrafları da içeriyor; başka bir hesabın yedeği de geri yüklenebiliyor.
- Görünüm yenilendi: renkli ikon kutuları, SKT durum etiketleri, kalan miktar çubuğu, Durum'da sayaçlar ve tek dokunuşla süzen düğmeler.

### Patch Changes

- Bulutun kalıcı olarak kabul etmediği bir fotoğraf ya da belge artık eşitlemeyi ve çıkışı bekletmiyor; "Bekleyen Kayıtlar"da görünüyor.
- Hesap silindikten sonra başka bir cihazın yüklediği fotoğraf ve belgeler de buluttan en geç bir gün içinde siliniyor.
- Ekran okuyucu ve tablet düzeni bütün sayfalarda tarandı; bulunan sorun yok, tarama her sürümde yineleniyor.

## 0.2.3

### Patch Changes

- Bu cihazda başka bir hesabın gönderilmemiş kayıtları dururken yeni hesapla giriş yapılınca artık ne silineceği söylenip soruluyor; onaylanırsa giriş yapılıyor. Eskiden o hesap geri gelemiyorsa cihaz kilitli kalıyordu.
- Güncellemeden sonra bekleyen kayıtlar yeniden gönderilirken, o sırada başka cihazda yapılmış daha yeni değişikliğin üstüne artık yazılmıyor.

## 0.2.2

### Patch Changes

- Çıkış yaparken sunucunun kabul etmediği kayıtlar ile henüz yüklenmemiş fotoğraf ve belgeler için de önce soruluyor; eskiden sorulmadan siliniyorlardı.
- Çıkıştan önce bekleyen fotoğraf ve belgeler de gönderiliyor.
- Hesap dondurulamayınca çıkan uyarı, gönderilemeyen kayıtların Ayarlar'da nerede görüleceğini de söylüyor.

## 0.2.1

### Patch Changes

- Silinen ya da taşınan kutunun değişiklik geçmişi de siliniyor ve içindeki not, takma ad ve seri buluttan kalkıyor; geri alma geçmişi kutuyla birlikte getiriyor.
- Silinen bir saklama yerinin adı buluttan da siliniyor.
- "Doz hatırlatmaları duracak" bildirimi yalnız haftadan uzun süren bir plan varken geliyor; hafta içinde biten plan sessizce bitiyor.
- İlacı başka cihazda silinmiş bir kutu başka dolaba taşınmıyor; önceden adsız bir ilaç oluşup senkronda takılıyordu.

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
