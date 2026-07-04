# Changelog

Bu dosya [@intellica/data-profiler](https://github.com/kerem84/data_profilleme_cli) projesindeki tum onemli degisiklikleri icerir.

Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) standardina, versiyon numaralari [Semantic Versioning](https://semver.org/) kuralina uygundur.

## [1.1.8] - 2026-04-11

### Eklenen
- HANA BW performans optimizasyonu: `M_CS_COLUMNS` system view ile bulk DISTINCT_COUNT (#28)
- `TABLESAMPLE SYSTEM (%)` destegi ile buyuk tablo profilleme hizlandirmasi (7x)
- `null_ratio_lite.sql` sablonu: distinct count katalogdan geldiginde hafif null orani hesabi
- `getColumnStatsFromCatalog()` metodu BaseConnector'a eklendi (opsiyonel override)

### Duzeltilen
- Checkpoint resume sonrasi tum tablolarin ciktiya dahil edilmesi
- Checkpoint resume'da gereksiz schema push blogu kaldirildi

### Test
- Checkpoint resume sonrasi tam profil birlesme testi eklendi

## [1.1.7] - 2026-04-01

### Duzeltilen
- SID_ prefix kolonlari icin RSDIOBJT aciklama eslesmesi duzeltildi

## [1.1.6] - 2026-03-31

### Eklenen
- Checkpoint & Resume: profilleme sirasinda ara kayit destegi (#26, #27)
- Uzun suren profilleme islemlerinde ilerleme kaybini onleme

## [1.1.5] - 2026-03-27

### Eklenen
- Hassas Veri Taramasi (Sensitive Data Discovery) - PII/KVKK tespiti (#25)
- `SensitivityAnalyzer` modulu: kategori registry ve skorlama
- IBAN ve kredi karti pattern'leri (MSSQL, Oracle, HANA)
- Varsayilan string pattern'leri (IBAN, kredi karti)
- Hassas veri entegrasyonu: profiler ve kalite skorlayiciya entegre
- HTML raporda hassas veri etiket filtresi
- Excel raporda "Hassas Veri Envanteri" sayfasi
- Interaktif menude "Hassas Veri Taramasi" secenegi
- CLI alt komutu: bagimsiz JSON tarama (`sensitivity`)

### Duzeltilen
- `person_name` heuristik false positive azaltimi
- Hassas veri sonuclarinin profile geri yazilmasi (`scanProfile`)
- Kod inceleme bulgulari: siralama hatasi, bagimsiz Excel, HTML badge, esik dogrulama

## [1.1.4] - 2026-03-27

### Duzeltilen
- `person_name` heuristik false positive azaltimi
- Hassas veri sonuclarinin profile geri yazilmasi

## [1.1.3] - 2026-03-25

### Eklenen
- ER diagram: per-schema SVG uretimi, engine secimi, dizin gruplama

## [1.1.2] - 2026-03-25

### Duzeltilen
- ER diagram crow's foot ok yonu duzeltildi

## [1.1.1] - 2026-03-25

### Eklenen
- ER diagram uretimi profil JSON'dan (#23, #24)

## [1.1.0] - 2026-03-24

### Eklenen
- SAP BW/HANA connector ile BW tablolarini profilleme (#22)
- Profil karsilastirma (Diff Report) ile kalite degisim takibi (#21, #6)
- Incremental profiling: sadece degisen tablolari yeniden profilleme (#20, #4)
- Paralel tablo profilleme ile 3-5x hizlanma (#19, #5)

### Duzeltilen
- HANA BW profilleme: prepare/execute, RSDIOBJT replace, OVER() window
- `multiSelectWithAll`: "Manuel Sec (Bos)" secenegi eklendi

## [1.0.7] - 2026-03-10

### Eklenen
- Tekli DB secimi ve tablo secim adimi
- HTML dashboard ozet kartlarina Toplam Boyut eklendi
- JSON rapor: dosya secim menusu ile el ile yol girmek yerine listeleme
- Excel ve HTML raporlara tablo boyut bilgisi eklendi

### Duzeltilen
- MSSQL baglanti timeout crash'i (#1)
- Windows TTY stdin donmasini kok nedenden cozme: stdin guard ile pause/resume dongusunu engelleme
- JSON coklu secim ve stdin listener temizligi ile kilitlenme fix
- Ana menu ESC sonrasi prompt coklanma sorunu
- Ana menude ESC ile cikisi engelle, donguye devam et
- JSON dosya secim menusunde kilitlenme duzeltildi
- Clack readline kilitlenmesi kok neden duzeltmesi

## [1.0.4] - 2026-03-01

### Eklenen
- Ilk surum: @intellica/data-profiler CLI
- PostgreSQL, MSSQL, Oracle DB destegi
- Kalite skorlama, dagilim analizi, pattern tespiti
- HTML dashboard ve Excel rapor uretimi
- Interaktif CLI menusu
- Banner ve CLI versiyonunu package.json'dan okuma

[1.1.8]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.7...HEAD
[1.1.7]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.4...v1.1.6
[1.1.5]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/kerem84/data_profilleme_cli/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/kerem84/data_profilleme_cli/compare/v1.0.7...v1.1.0
[1.0.7]: https://github.com/kerem84/data_profilleme_cli/compare/v1.0.4...v1.0.7
[1.0.4]: https://github.com/kerem84/data_profilleme_cli/releases/tag/v1.0.4
