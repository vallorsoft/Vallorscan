// Önjavító karbantartás: hiányzó fordítások pótlása + elavult cég-vélemények frissítése.
import { db } from './db.js';
import { translateMissingComments, generateOpinionFor } from './reports.js';

// Egyszeri karbantartás: fordítások + elavult vélemények.
// Soha nem dob kifelé – nem dönti le a szervert.
export async function runMaintenance() {
  try {
    // A. lépés: hiányzó magyar fordítások pótlása.
    let translated = 0;
    try {
      const t = await translateMissingComments({ limit: 200 });
      translated = t?.translated ?? t?.count ?? 0;
    } catch {}

    // B. lépés: legfeljebb 10 cég, akinek a véleménye elavult vagy hiányzik, de van hozzászólása.
    let refreshed = 0;
    const stale = db.prepare(`SELECT c.id FROM companies c
      WHERE (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id) > 0
        AND (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id) <> COALESCE(c.ai_opinion_count, 0)
      LIMIT 10`).all();
    for (const row of stale) {
      try {
        await generateOpinionFor(row.id);
        refreshed++;
      } catch {}
    }

    console.log(`Karbantartás kész: ${translated} fordítás, ${refreshed} vélemény frissítve.`);
  } catch (e) {
    console.error('Karbantartás hiba:', e.message || e);
  }
}

// Időzítés: ~30 mp után az első futás, utána 30 percenként.
// unref() – ne tartsa életben a folyamatot (tesztekben).
export function scheduleMaintenance() {
  setTimeout(runMaintenance, 30_000).unref();
  setInterval(runMaintenance, 30 * 60 * 1000).unref();
}
