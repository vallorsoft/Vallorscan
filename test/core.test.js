// Mag-logika tesztek: normalizálás, hasonlóság, fallback kinyerés, dedup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCui, normalizePlate, normalizeCompanyName, diceSimilarity, contentHash } from '../server/normalize.js';
import { fallbackExtract, isoDateOrNull } from '../server/ai.js';
import { computeVerdict } from '../server/verdict.js';

test('CUI normalizálás RO prefixszel', () => {
  assert.equal(normalizeCui('RO 12345678'), '12345678');
  assert.equal(normalizeCui('CUI: 12345678'), '12345678');
  assert.equal(normalizeCui('abc'), null);
});

test('rendszám normalizálás', () => {
  assert.equal(normalizePlate('B 123 ABC'), 'B123ABC');
  assert.equal(normalizePlate('cj-99-xyz'), 'CJ99XYZ');
  assert.equal(normalizePlate('xx'), null);
});

test('cégnév normalizálás jogi forma nélkül', () => {
  assert.equal(normalizeCompanyName('Transport Marfa Rapid SRL'), 'transport marfa rapid');
  assert.equal(normalizeCompanyName('Kis Logisztika Kft.'), 'kis logisztika');
});

test('hasonlóság erős és gyenge', () => {
  assert.ok(diceSimilarity('Transport Marfa Rapid SRL', 'Transport Marfa Rapid') > 0.9);
  assert.ok(diceSimilarity('Cargo Expres', 'Kis Logisztika') < 0.3);
});

test('tartalom-hash stabil és url-érzékeny', () => {
  assert.equal(contentHash('Hello  World', 'http://x'), contentHash('hello world', 'http://x'));
  assert.notEqual(contentHash('a', 'http://x'), contentHash('a', 'http://y'));
});

test('fallback kinyerés román szövegből', () => {
  const r = fallbackExtract('Transport Rapid SRL CUI RO12345678 masina B 123 ABC datorie 8500 RON 45 zile nu plateste');
  assert.equal(r.cui, '12345678');
  assert.ok(r.license_plates.includes('B123ABC'));
  assert.equal(r.debt_amount, 8500);
  assert.equal(r.currency, 'RON');
  assert.equal(r.delay_days, 45);
  assert.equal(r.problem_type, 'non_payment');
});

test('ISO dátum validálás', () => {
  assert.equal(isoDateOrNull('2025-03-14'), '2025-03-14');
  assert.equal(isoDateOrNull('2025-03-14T10:00:00Z'), '2025-03-14');
  assert.equal(isoDateOrNull('tegnap'), null);
  assert.equal(isoDateOrNull(null), null);
  assert.equal(isoDateOrNull('2025-13-40'), null);
});

test('cég-értékelés: pozitív többség → Fizető', () => {
  const v = computeVerdict({ pos_count: 13, neg_count: 1, neu_count: 1, recent_pos: 0, recent_neg: 0 });
  assert.equal(v.verdict, 'pays');
  assert.equal(v.verdict_label, 'Fizető');
});

test('cég-értékelés: negatív többség → Nem fizető', () => {
  const v = computeVerdict({ pos_count: 1, neg_count: 9, recent_pos: 0, recent_neg: 0 });
  assert.equal(v.verdict, 'nonpay');
});

test('cég-értékelés: kiegyensúlyozott → Vegyes', () => {
  const v = computeVerdict({ pos_count: 5, neg_count: 5, recent_pos: 0, recent_neg: 0 });
  assert.equal(v.verdict, 'mixed');
});

test('cég-értékelés: nincs komment → Nincs adat', () => {
  assert.equal(computeVerdict({}).verdict, 'unknown');
});

test('cég-értékelés: friss vélemény felülírja a régit (javuló trend)', () => {
  // Régen 5 rossz, mostanában 5 jó → friss alapján Fizető + javuló trend.
  const v = computeVerdict({ pos_count: 5, neg_count: 5, recent_pos: 5, recent_neg: 0 });
  assert.equal(v.verdict, 'pays');
  assert.equal(v.trend, 'improving');
});
