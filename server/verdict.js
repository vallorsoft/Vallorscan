// Cég-értékelés a kommentekből – tiszta függvény (DB nélkül), hogy tesztelhető legyen.

/**
 * A frissebb (fél éven belüli) véleményt nagyobb súllyal véve dönt.
 * Bemenet egy aggregált sor: { pos_count, neg_count, recent_pos, recent_neg }.
 * Visszaad: { verdict, verdict_label, trend }.
 *  - verdict: 'pays' | 'nonpay' | 'mixed' | 'unknown'
 *  - trend:   'improving' | 'worsening' | null
 */
export function computeVerdict(row) {
  const pos = row.pos_count || 0, neg = row.neg_count || 0;
  const rpos = row.recent_pos || 0, rneg = row.recent_neg || 0;
  // Ha van friss vélemény, az alapján döntünk; különben az összesből.
  const [bp, bn] = (rpos + rneg > 0) ? [rpos, rneg] : [pos, neg];

  let verdict = 'unknown', label = 'Nincs adat';
  if (bp + bn > 0) {
    if (bp > bn * 1.5) { verdict = 'pays'; label = 'Fizető'; }
    else if (bn > bp * 1.5) { verdict = 'nonpay'; label = 'Nem fizető'; }
    else { verdict = 'mixed'; label = 'Vegyes'; }
  }

  // Trend: a régi (fél évnél idősebb) és a friss vélemények iránya eltér-e.
  const oldPos = pos - rpos, oldNeg = neg - rneg;
  let trend = null;
  if (oldNeg > oldPos && rpos > rneg) trend = 'improving';
  else if (oldPos > oldNeg && rneg > rpos) trend = 'worsening';

  return { verdict, verdict_label: label, trend };
}
