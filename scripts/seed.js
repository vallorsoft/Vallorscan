// Demó adat betöltése – valós jellegű (RO/HU) bejegyzések a dedup és keresés teszteléséhez.
import { commitShare } from '../server/posts.js';
import { extract } from '../server/ai.js';
import { bootstrapSuperadmin } from '../server/users.js';

bootstrapSuperadmin(); // a seed is biztosítson superadmint

const SAMPLES = [
  { text: 'Atentie! Transport Marfa Rapid SRL, CUI RO12345678, masina B 123 ABC nu plateste de 45 zile. Datorie 8500 RON.', url: 'https://facebook.com/groups/fuvar/posts/1' },
  { text: 'Ugyanaz a cég RO12345678, rendszám CJ 99 XYZ, megint nem fizet, 3200 lei tartozás 60 nap.', url: 'https://facebook.com/groups/fuvar/posts/2' },
  { text: 'Vigyazat: Cargo Expres SA CUI RO87654321 csaló, átvette az árut és eltűnt. B 555 DEF', url: 'https://facebook.com/groups/fuvar/posts/3' },
  { text: 'Kis Logisztika Kft késik a fizetéssel, 15 nap, 1200 EUR. Rendszám: ABC 123', url: '' },
];

for (const s of SAMPLES) {
  const ai = await extract(s.text, s.url);
  const r = commitShare({
    raw_text: s.text, source_url: s.url, source_type: 'facebook',
    company_name: ai.company_name, cui: ai.cui, license_plates: ai.license_plates,
    debt_amount: ai.debt_amount, currency: ai.currency, delay_days: ai.delay_days,
    problem_type: ai.problem_type, summary: ai.summary,
    original_language: ai.original_language, confidence: ai.confidence,
  }, 'seed');
  console.log(r.duplicate ? 'duplikátum (kihagyva)' : `mentve → cég: ${r.company.name} (${r.matchedBy})`);
}
console.log('Seed kész.');
