# Vallorscan 🚚🔎

**Fuvarozó cégek ellenőrzése** – problémás / nem fizető fuvarozó és szállítmányozó
cégek bejegyzéseinek gyors mentése (Facebook „Megosztás”-ból), AI-feldolgozása és
visszakeresése. Cégen belüli, napi használatra.

Technológia: **PWA** (telepíthető Androidra) + **Node.js/Express** + **SQLite**
központi adatbázis + **Gemini** AI (kulcs nélkül regex-fallbackkel) + valós idejű
**SSE** szinkron + **offline outbox**.

> Egyetlen kis szerver kiszolgálja az összes telefont (3–10 készülék) – nincs szükség
> külön felhőszolgáltatásra az induláshoz. Kulcs nélkül is azonnal fut.

---

## Funkciók

- 📲 **Facebook „Megosztás → Vallorscan”** – a megosztott szöveg/link a Web Share
  Target API-n keresztül egyenesen az appba kerül.
- 🤖 **AI kinyerés** – cégnév, CUI, rendszám, tartozás összege, fizetési késés (nap),
  probléma típusa, eredeti nyelv. Szerkeszthető review képernyő (human-in-the-loop).
- 🧱 **Duplikáció-védelem** – bejegyzés szinten tartalom-hash; cég szinten CUI →
  rendszám → fuzzy név, kézi összevonással.
- 🔍 **Univerzális keresés** – cégnév, CUI, rendszám és kulcsszó (full-text) egy mezőből.
- 🕒 **Cég-idővonal** – egy céghez tartozó összes bejegyzés időrendben.
- 📡 **Valós idejű szinkron** – minden telefon azonnal frissül (SSE).
- ✈️ **Offline-first** – internet nélkül is működik; net visszatértekor automatikus szinkron.

---

## Gyors indítás

Előfeltétel: **Node 20+**.

```bash
npm install
cp .env.example .env        # opcionális – kulcs nélkül is fut
npm run seed                # demó adat (elhagyható)
npm start                   # http://localhost:4000
```

Telefonon: nyisd meg a szerver címét böngészőben → **„Hozzáadás a kezdőképernyőhöz”**
(PWA telepítés). Ezután a Facebookban: **Megosztás → Vallorscan**.

### Tesztek

```bash
npm test            # mag-logika: normalizálás, hasonlóság, dedup, AI-fallback
```

---

## AI konfiguráció (Gemini)

A `.env`-ben:

```
GEMINI_API_KEY=...           # ha üres → determinisztikus regex-fallback
GEMINI_MODEL=gemini-2.5-flash
```

- **Kulccsal:** Gemini `structured output` (JSON séma), pontos többnyelvű (RO/HU/EN) kinyerés.
- **Kulcs nélkül:** regex-fallback fut (alacsony `confidence` → minden bejegyzés
  „ellenőrzésre vár” jelölést kap). Így az app kulcs nélkül is használható.
- A kulcs **csak a szerveren** van – sosem kerül a telefonra.

---

## Több telefon / központi adatbázis

A séma egyetlen szerverre + egy SQLite fájlra épül, ami minden klienst kiszolgál.

1. Telepítsd a szervert egy elérhető gépre/VPS-re (lásd lent).
2. Állíts be belépési tokeneket a `.env`-ben:
   ```
   AUTH_TOKENS=iroda:titok1,sofor1:titok2,sofor2:titok3
   ```
3. Minden telefonon a **⚙ Beállítások**-nál add meg a szerver címét és a sajat tokent.
4. A bejegyzések valós időben megjelennek minden készüléken.

> Nagyobb terheléshez / több tízezer bejegyzéshez a SQLite réteg gond nélkül bírja
> (WAL mód, FTS5 index). Ha később felhős, valódi offline-first sync kell, a réteg
> PostgreSQL + PowerSync irányba cserélhető – az API-szerződés változatlan maradhat.

### Deploy (példa)

```bash
# bármely Node-hostingon (VPS, Render, Fly.io, Railway):
PORT=4000 DB_PATH=/data/vallorscan.sqlite AUTH_TOKENS="iroda:..." node server/index.js
```

HTTPS-t tegyél elé (Caddy/Nginx) – a PWA telepítés és a Share Target HTTPS-t igényel.

---

## Adatmodell (SQLite)

| Tábla | Szerep |
| --- | --- |
| `companies` | cég (egyedi CUI, normalizált név) |
| `plates` | rendszámok (egyedi, céghez kötve) |
| `company_aliases` | korábbi nevek összevonás után (jövőbeli egyezéshez) |
| `posts` | bejegyzések (idővonal, `content_hash` egyedi → dedup) |
| `posts_fts` | FTS5 full-text index a kulcsszó-kereséshez |
| `audit_log` | ki, mit, mikor (összevonás, létrehozás) |

## Duplikáció-kezelés

- **Bejegyzés:** `content_hash = sha256(normalizált szöveg + url)` UNIQUE → ugyanaz a
  poszt nem jön létre kétszer, több telefonról sem.
- **Cég:** 1) CUI egyezés (automatikus) → 2) rendszám egyezés (automatikus) →
  3) erős név-hasonlóság (automatikus) → gyengébbnél **javaslat** kézi összevonáshoz
  (`POST /api/companies/:id/merge`).

---

## API áttekintés

| Útvonal | Leírás |
| --- | --- |
| `POST /api/share/preview` | AI feldolgozás mentés nélkül (review-hoz) |
| `POST /api/share/commit` | bejegyzés mentése dedup-pal |
| `GET /api/companies` | céglista (aggregált adatokkal) |
| `GET /api/companies/:id` | cég + teljes idővonal |
| `POST /api/companies/:id/merge` | két cég összevonása |
| `GET /api/search?q=` | univerzális keresés (név/CUI/rendszám/kulcsszó) |
| `GET /api/events` | SSE – valós idejű frissítés |
| `POST /share-target` | Web Share Target belépési pont (Facebook „Megosztás”) |

---

## Biztonság

- Zárt, **token-alapú** belépés (Bearer). Üres `AUTH_TOKENS` = nyitott mód, csak helyi teszthez.
- API-kulcsok kizárólag szerveroldalon.
- Audit napló minden módosításhoz.
- ⚠️ **Jogi megjegyzés:** a rendszer cégekre vonatkozó negatív adatokat tárol →
  GDPR-érintett. Javasolt: csak tényalapú adatok, **belső (nem nyilvános) használat**,
  és törlési/javítási folyamat. Éles indulás előtt érdemes jogi egyeztetés.

---

## Projektszerkezet

```
vallorscan/
├── server/
│   ├── index.js      # Express API + statikus PWA + SSE
│   ├── db.js         # SQLite séma, FTS5, audit
│   ├── normalize.js  # CUI/rendszám/név normalizálás + hasonlóság + hash
│   ├── ai.js         # Gemini kinyerés + regex-fallback
│   ├── dedup.js      # cég-feloldás + összevonás
│   ├── posts.js      # preview/commit folyamat
│   ├── queries.js    # keresés + idővonal
│   ├── events.js     # SSE broadcaster
│   └── auth.js       # token hitelesítés
├── public/           # PWA: index.html, app.js, styles.css, sw.js, manifest, ikonok
├── scripts/          # seed, ikon-generátor
└── test/             # mag-logika tesztek
```
