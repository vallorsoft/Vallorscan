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
- ✈️ **Offline-first** – helyi tárolás (IndexedDB), internet nélkül is működik; net
  visszatértekor automatikus szinkron a központi szerverrel és a többi eszközzel.
- 🔐 **Bejelentkezés + felhasználókezelés** – superadmin meghívókódot generál a
  kollégáknak (email + telefon), szerkeszthető jogosultság, titkosított jelszó/kód.

---

## Gyors indítás

Előfeltétel: **Node 20+**.

```bash
npm install
cp .env.example .env        # opcionális – kulcs nélkül is fut
npm run seed                # demó adat (elhagyható)
npm start                   # http://localhost:4000
```

**PC-n:** nyisd meg a szerver címét böngészőben → **„Hozzáadás a kezdőképernyőhöz”**
(PWA telepítés, opcionális). Ezután a Facebookban: **Megosztás → Vallorscan**.

---

## Telepíthető Android app (APK)

A böngészős/PWA mód mellett van egy **natív, telepíthető Android alkalmazás** is
([Capacitor](https://capacitorjs.com) wrapper a `public/` frontend köré). Play
áruház **nem kell** – az APK közvetlenül a telefonra telepíthető (sideload).

- A natív app ugyanahhoz a **szerverhez csatlakozik** (a szerver címét és a tokent
  a **⚙ Beállítások**-ban add meg – első indításkor automatikusan oda visz).
- A Facebook **„Megosztás → Vallorscan”** natívan is működik: az app megjelenik az
  Android megosztó-lapján (`ACTION_SEND` / `text/plain` intent → `send-intent` plugin).

### APK letöltése (ajánlott – build nélkül)

Az APK-t a **GitHub Actions** fordítja automatikusan minden push-ra:

1. GitHub → **Actions** → a legutóbbi **CI** futás.
2. Az **Artifacts** alatt töltsd le a `vallorscan-debug-apk` csomagot.
3. Másold a telefonra, és telepítsd (engedélyezd az „ismeretlen forrásból” telepítést).

### APK fordítása helyben (opcionális)

Előfeltétel: **JDK 17** + **Android SDK** (Android Studio vagy command-line tools).

```bash
npm install
npm run android:apk      # cap sync + ./gradlew assembleDebug
# eredmény: android/app/build/outputs/apk/debug/app-debug.apk
```

Fejlesztéshez Android Studióban: `npx cap open android`.

> A `debug` APK aláírása a fejlesztői debug-kulccsal történik – személyes
> használatra tökéletes. Nyilvános terjesztéshez release-aláírás kell.

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
2. Az **első indításkor automatikusan létrejön egy superadmin** (lásd „Bejelentkezés”).
3. Minden telefonon/PC-n a **bejelentkező képernyőn** add meg a szerver címét, majd lépj be.
4. A bejegyzések valós időben megjelennek minden készüléken (SSE), és **offline is**
   elérhetők (helyi cache); net visszatértekor automatikus szinkron.

> Nagyobb terheléshez / több tízezer bejegyzéshez a SQLite réteg gond nélkül bírja
> (WAL mód, FTS5 index). Ha később felhős, valódi offline-first sync kell, a réteg
> PostgreSQL + PowerSync irányba cserélhető – az API-szerződés változatlan maradhat.

### Deploy (példa)

```bash
# bármely Node-hostingon (VPS, Render, Fly.io, Railway):
PORT=4000 DB_PATH=/data/vallorscan.sqlite \
  SUPERADMIN_EMAIL=te@example.com node server/index.js
```

HTTPS-t tegyél elé (Caddy/Nginx) – a PWA telepítés és a Share Target HTTPS-t igényel.

> ⚠️ **Fontos felhős hosting esetén (Render/Railway/Fly.io):** az adatbázis egyetlen
> SQLite **fájl**. Ha a hoszt fájlrendszere efemer (pl. **Render free** webszolgáltatás),
> az adat újraindításkor/deploykor **elveszik**. Köss hozzá **perzisztens diszket** (Render
> „Disk”, Railway/Fly volume), és a `DB_PATH` arra a diszkre mutasson. A free Render emellett
> **alvó állapotba megy** inaktivitáskor (lassú első kérés, az SSE megszakad) – tartós
> használatra fizetős „Starter” terv + disk ajánlott.

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
| `users` | felhasználók (email, szerep, jelszó-hash, meghívókód-hash) |
| `sessions` | belépési munkamenetek (token-hash, lejárat) |

## Duplikáció-kezelés

- **Bejegyzés:** `content_hash = sha256(normalizált szöveg + url)` UNIQUE → ugyanaz a
  poszt nem jön létre kétszer, több telefonról sem.
- **Cég:** 1) CUI egyezés (automatikus) → 2) rendszám egyezés (automatikus) →
  3) erős név-hasonlóság (automatikus) → gyengébbnél **javaslat** kézi összevonáshoz
  (`POST /api/companies/:id/merge`).

---

## Bejelentkezés és felhasználók

Zárt, **session-alapú** belépés. A jelszavakat és a meghívókódokat **titkosítva**
(`scrypt` hash, egyedi sóval) tároljuk – sosem nyersen.

- **Superadmin:** az első indításkor automatikusan létrejön. Email a
  `SUPERADMIN_EMAIL`-ből (alapértelmezett `vallorsoft@gmail.com`), jelszó a
  `SUPERADMIN_PASSWORD`-ből, vagy ha üres, **generált jelszót ír a szerver konzoljára**.
  Első belépéskor **kötelező a jelszócsere**.
- **Új kolléga meghívása:** a superadmin/admin a **👥 Felhasználók kezelése** képernyőn
  megadja a kolléga **emailjét és telefonszámát** → a rendszer **egyszeri kódot** generál.
  Ezt a kódot (és az emailt) átadod a kollégának: ezzel lép be először, majd **saját
  jelszót állít be**. A kód csak egyszer jelenik meg.
- **Jogosultságok:** a superadmin **szerkesztheti** a kolléga szerepkörét
  (felhasználó/admin), **letilthatja**, **új kódot** generálhat neki, vagy **törölheti**.
- **Szerepkörök:** `superadmin` (mindenhez + admin-kezelés), `admin` (kolléga-kezelés),
  `user` (sima használat).

| Auth útvonal | Leírás |
| --- | --- |
| `POST /api/auth/login` | belépés email + jelszó **vagy** meghívókód |
| `POST /api/auth/change-password` | jelszó beállítása/cseréje |
| `GET /api/auth/me` | aktuális felhasználó |
| `POST /api/auth/logout` | kijelentkezés |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id`, `POST /api/users/:id/reset-code` | felhasználó-kezelés (superadmin/admin) |
| `GET /api/sync?since=` | inkrementális szinkron az offline cache-hez |

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

- Zárt, **session-alapú** belépés (Bearer token a munkamenethez).
- Jelszavak és meghívókódok **`scrypt` hash**-sel, egyedi sóval titkosítva tárolva.
- Szerepkör-alapú jogosultság (superadmin / admin / user).
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
├── android/          # natív Android app (Capacitor wrapper) – APK build
├── capacitor.config.json  # Capacitor konfiguráció (appId, webDir, plugins)
├── scripts/          # seed, ikon-generátor
├── test/             # mag-logika tesztek
└── .github/workflows/ci.yml  # CI: tesztek + Android APK build
```
