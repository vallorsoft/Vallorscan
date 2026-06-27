// Mag-logika tesztek: normalizálás, hasonlóság, fallback kinyerés, dedup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCui, normalizePlate, normalizeCompanyName, diceSimilarity, contentHash } from '../server/normalize.js';
import { fallbackExtract } from '../server/ai.js';

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
