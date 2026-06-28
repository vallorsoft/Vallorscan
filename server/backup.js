// Automatikus adatbázis-mentés: időzített SQLite backup + régi mentések selejtezése.
import { db } from './db.js';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/vallorscan.sqlite';
const backupsDir = path.join(path.dirname(DB_PATH), 'backups');

// Csak a legutóbbi N mentés marad meg.
const KEEP = 7;

// Egyszeri mentés: könyvtár létrehozása, biztonságos backup (WAL-ban is), majd selejtezés.
// Soha nem dob kifelé – nem dönti le a szervert.
export async function runBackup() {
  try {
    fs.mkdirSync(backupsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `vallorscan-${ts}.sqlite`);
    await db.backup(dest);

    // Régi mentések törlése – csak a legfrissebb KEEP marad.
    const files = fs.readdirSync(backupsDir)
      .filter((f) => /^vallorscan-.*\.sqlite$/.test(f))
      .sort(); // a timestamp alfabetikusan = időrendben
    for (const f of files.slice(0, -KEEP)) {
      fs.unlinkSync(path.join(backupsDir, f));
    }
    console.log(`Backup kész: ${dest}`);
  } catch (e) {
    console.error('Backup hiba:', e.message || e);
  }
}

// Időzítés: ~10 mp után az első mentés, utána 24 óránként.
// unref() – ne tartsa életben a folyamatot (tesztekben).
export function scheduleBackups() {
  setTimeout(runBackup, 10_000).unref();
  setInterval(runBackup, 24 * 60 * 60 * 1000).unref();
}

// Az élő DB-fájl elérési útja (letöltéshez).
export function dbFilePath() {
  return DB_PATH;
}
