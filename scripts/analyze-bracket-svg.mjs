/**
 * Analyze what the bracket SVG will actually render:
 * - What history records exist for R32 and R16
 * - What matchOrder each has
 * - What the SVG pairing logic will produce
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();

const [plannedSnap, histSnap] = await Promise.all([
  db.ref('planned').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value'),
  db.ref('matches').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value'),
]);
const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid,v]) => ({mid,...v}));
const history = Object.entries(histSnap.val() ?? {}).map(([id,v]) => ({id,...v}));

// The SVG reads from buildRoundReports → buildReportRows which uses history matches.
// Each history match gets matchOrder from: (m as any).matchOrder
// Let's see what matchOrder is stored on history records

console.log('=== R32 History records (what SVG renders) ===');
const r32h = history.filter(h => h.round==='G1 — R32').sort((a,b) => (a.matchOrder??999)-(b.matchOrder??999));
for (const h of r32h) {
  const w = h.result?.winner === 'a' ? h.aName : h.bName;
  console.log(`  matchOrder=${h.matchOrder??'NONE'} | ${h.aName} vs ${h.bName} | winner=${w} | id=${h.id}`);
}

console.log('\n=== R16 History records (what SVG renders) ===');
const r16h = history.filter(h => h.round==='G1 — R16').sort((a,b) => (a.matchOrder??999)-(b.matchOrder??999));
for (const h of r16h) {
  const w = h.result?.winner === 'a' ? h.aName : h.bName;
  console.log(`  matchOrder=${h.matchOrder??'NONE'} | ${h.aName} vs ${h.bName} | winner=${w} | id=${h.id}`);
}

console.log('\n=== R32 Planned records (used by SVG when no history or supplement) ===');
const r32p = planned.filter(m => m.round==='G1 — R32').sort((a,b) => (a.matchOrder??999)-(b.matchOrder??999));
for (const p of r32p) {
  const w = p.result?.winner === 'a' ? p.aName : p.result?.winner === 'b' ? p.bName : '—';
  const hasHist = r32h.some(h => {
    const pa = p.aName?.trim().toLowerCase(), pb = p.bName?.trim().toLowerCase();
    const ha = (h.aName??'').trim().toLowerCase(), hb = (h.bName??'').trim().toLowerCase();
    return (ha===pa&&hb===pb)||(ha===pb&&hb===pa);
  });
  console.log(`  order=${p.matchOrder} | ${p.aName} vs ${p.bName} | winner=${w} | hasHist=${hasHist}`);
}

console.log('\n=== How buildRoundReports builds rows for SVG ===');
console.log('SVG uses: rr.rows sorted by matchOrder');
console.log('rows come from buildReportRows(history matches for this round)');
console.log('matchOrder on row comes from: (m as any).matchOrder — i.e. the history record matchOrder field');
console.log('\nSo: which history records have matchOrder set?');
const r32WithOrder = r32h.filter(h => h.matchOrder != null);
const r32Without = r32h.filter(h => h.matchOrder == null);
console.log(`  R32: ${r32WithOrder.length} have matchOrder, ${r32Without.length} do not`);
const r16WithOrder = r16h.filter(h => h.matchOrder != null);
const r16Without = r16h.filter(h => h.matchOrder == null);
console.log(`  R16: ${r16WithOrder.length} have matchOrder, ${r16Without.length} do not`);

console.log('\n=== Connector logic in SVG ===');
console.log('connectors pair by position index, not matchOrder:');
console.log('R32 slot index i → R16 slot index ceil((i+1)/2)-1 = floor(i/2)');
console.log('So R32[0]+R32[1] → R16[0], R32[2]+R32[3] → R16[1], etc.');
console.log('\nR32 rendered order (sorted by matchOrder, null last):');
r32h.forEach((h,i) => {
  const w = h.result?.winner === 'a' ? h.aName : h.bName;
  console.log(`  idx=${i} matchOrder=${h.matchOrder??'null'} ${h.aName} vs ${h.bName} → winner=${w} → connects to R16[${Math.floor(i/2)}]`);
});
console.log('\nR16 rendered order:');
r16h.forEach((h,i) => {
  const w = h.result?.winner === 'a' ? h.aName : h.bName;
  console.log(`  idx=${i} matchOrder=${h.matchOrder??'null'} ${h.aName} vs ${h.bName} → winner=${w}`);
});

process.exit(0);
