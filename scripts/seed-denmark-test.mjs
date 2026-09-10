/**
 * Seed script for Denmark League Test Tournament using real DK country players.
 * Uses the Firebase CLI (admin bypass) to expand groups to 4 players each,
 * update leagueCfg to 3 flights, and write completed group-stage planned matches
 * so standings + all 3 flights (Gold/Silver/Bronze League) are populated.
 *
 * Run:  node scripts/seed-denmark-test.mjs
 * Undo: node scripts/seed-denmark-test.mjs --cleanup
 */

import { execSync } from 'child_process';

const CLEANUP = process.argv.includes('--cleanup');
const TAG = '_DEMO_SEED';
const TK = 'denmark-league-test-tournament';
const CLI = '--project carrom-score --instance carrom-score-default-rtdb';

function fbSet(path, data) {
  const json = JSON.stringify(data);
  execSync(`firebase database:set -f "${path}" ${CLI} -d '${json.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
}

function fbRemove(path) {
  execSync(`firebase database:set -f "${path}" ${CLI} -d 'null'`, { stdio: 'pipe' });
}

// ─── Real DK players ──────────────────────────────────────────────────────────
// Grouped in rank order: index 0 = best player in group (wins most matches)
const GROUPS = {
  g1: [
    { id: 'swapnil-deshpande-65gb',              name: 'Swapnil Deshpande' },
    { id: 'sivarama-pushpala-qjfo',              name: 'Sivarama Pushpala' },
    { id: 'kalyan-pushpala-qxh7',                name: 'Kalyan Pushpala' },
    { id: 'suraj-paluri-kzy7',                   name: 'Suraj Paluri' },
  ],
  g2: [
    { id: 'sampath-swamy-xupj',                  name: 'Sampath Swamy' },
    { id: 'manas-dalvi-4r1j',                    name: 'Manas Dalvi' },
    { id: 'vethanayagam-antonio-sylvester-pw7p', name: 'Antonio Vethanayagam Sylvester' },
    { id: 'yuvaraj-eshwaramoorthy-cltm',         name: 'Yuvaraj Eshwaramoorthy' },
  ],
};

// Original 2-player groups before seeding
const ORIGINAL = {
  g1: ['swapnil-deshpande-65gb', 'vethanayagam-antonio-sylvester-pw7p'],
  g2: ['sampath-swamy-xupj',     'yuvaraj-eshwaramoorthy-cltm'],
};

// ─── Cleanup ─────────────────────────────────────────────────────────────────
function cleanup() {
  console.log('Cleaning up seed data…');

  // Restore original 2-player groups
  fbSet(`/tournaments/${TK}/groups/g1/playerIds`, ORIGINAL.g1);
  fbSet(`/tournaments/${TK}/groups/g2/playerIds`, ORIGINAL.g2);

  // Restore leagueCfg
  fbSet(`/tournaments/${TK}/leagueCfg/playersPerGroup`, 2);
  fbSet(`/tournaments/${TK}/leagueCfg/flightNames`, ['Gold League']);
  console.log('  restored tournament config');

  // Remove assignedPlayerIds for the extra players (those not in original)
  const allSeededIds = [
    ...GROUPS.g1.map(p => p.id),
    ...GROUPS.g2.map(p => p.id),
  ].filter(id => !ORIGINAL.g1.includes(id) && !ORIGINAL.g2.includes(id));
  for (const id of allSeededIds) {
    fbRemove(`/tournaments/${TK}/assignedPlayerIds/${id}`);
  }

  // Remove demo planned matches tagged with TAG
  const raw = execSync(
    `firebase database:get /planned ${CLI} 2>&1 | tail -n +5`,
    { encoding: 'utf8' }
  );
  try {
    const all = JSON.parse(raw);
    let removed = 0;
    for (const [mid, v] of Object.entries(all)) {
      if (v?.createdBy === TAG) {
        fbRemove(`/planned/${mid}`);
        removed++;
      }
    }
    console.log(`  removed ${removed} demo planned matches`);
  } catch {
    console.log('  (could not parse planned matches — may already be clean)');
  }

  // Remove demo rounds
  const roundsRaw = execSync(
    `firebase database:get /tournaments/${TK}/rounds ${CLI} 2>&1 | tail -n +5`,
    { encoding: 'utf8' }
  );
  try {
    const rounds = JSON.parse(roundsRaw);
    for (const [rk, rv] of Object.entries(rounds)) {
      if (rv?.createdBy === TAG) {
        fbRemove(`/tournaments/${TK}/rounds/${rk}`);
        console.log(`  removed round ${rk}`);
      }
    }
  } catch { /* no demo rounds */ }

  console.log('\nDone. Refresh the app.');
}

// ─── Seed ────────────────────────────────────────────────────────────────────
function seed() {
  console.log('Seeding real Denmark players into Denmark League Test Tournament…');
  const now = Date.now();

  // 1. Expand groups to 4 players each
  for (const [gKey, players] of Object.entries(GROUPS)) {
    fbSet(`/tournaments/${TK}/groups/${gKey}/playerIds`, players.map(p => p.id));
    // Register all as assigned
    for (const p of players) {
      fbSet(`/tournaments/${TK}/assignedPlayerIds/${p.id}`, true);
    }
  }
  fbSet(`/tournaments/${TK}/leagueCfg/playersPerGroup`, 4);
  fbSet(`/tournaments/${TK}/leagueCfg/flightNames`, ['Gold League', 'Silver League', 'Bronze League']);
  console.log('  updated leagueCfg: 4 players/group, 3 flights (Gold/Silver/Bronze League)');

  // 2. Write completed round-robin matches for each group
  //    Player at index i beats all players at index j > i (simulating ranked results)
  const groupDefs = [
    { gKey: 'g1', roundName: 'Group G1', roundKey: 'group-g1', players: GROUPS.g1 },
    { gKey: 'g2', roundName: 'Group G2', roundKey: 'group-g2', players: GROUPS.g2 },
  ];

  let totalMatches = 0;
  for (const g of groupDefs) {
    let count = 0;
    for (let i = 0; i < g.players.length; i++) {
      for (let j = i + 1; j < g.players.length; j++) {
        const a = g.players[i];
        const b = g.players[j];
        const mid = `-DEMO${g.gKey}${String(count).padStart(3, '0')}`;
        // Realistic board scores: winner gets 20 pts (target), loser gets varied score
        // Higher-ranked players (lower i) win more convincingly
        const loserScore = [15, 12, 8, 5][Math.min(j - i - 1, 3)];
        fbSet(`/planned/${mid}`, {
          mode: 'singles',
          tournament: 'Denmark League Test Tournament',
          tournamentKey: TK,
          round: g.roundName,
          roundKey: g.roundKey,
          matchOrder: 100 + count,
          aName: a.name,
          aResolvedId: a.id,
          bName: b.name,
          bResolvedId: b.id,
          cfg: { bestOf: 1, pointsTarget: 20, maxBoards: 4 },
          createdAt: now + count,
          createdBy: TAG,
          completedAt: now + count + 1,
          completedBy: TAG,
          result: {
            setsA: 1,
            setsB: 0,
            winner: 'a',
            boards: [{ aScore: 20, bScore: loserScore }],
          },
        });
        count++;
      }
    }
    console.log(`  wrote ${count} matches for ${g.roundName}`);
    totalMatches += count;
  }

  console.log(`\n  Total: ${totalMatches} group-stage matches written.`);
  console.log('\nStandings should now show (per group):');
  console.log('  Rank 1: best player (won all 3)');
  console.log('  Rank 2: second best (won 2)');
  console.log('  Rank 3: third (won 1)');
  console.log('  Rank 4: last (won 0)');
  console.log('\nExpected flight seeding:');
  console.log('  Gold League:   Swapnil (G1-R1)  vs Sampath (G2-R1)');
  console.log('  Silver League: Sivarama (G1-R2) vs Manas (G2-R2)');
  console.log('  Bronze League: Kalyan (G1-R3)   vs Antonio (G2-R3)');
  console.log('\nNext steps in the app:');
  console.log('  1. Open League Setup → Stage 2 tab');
  console.log('  2. Standings should show 4 players per group');
  console.log('  3. Click "Generate flights →" to create Gold/Silver/Bronze League brackets');
  console.log('\nTo undo: node scripts/seed-denmark-test.mjs --cleanup');
}

CLEANUP ? cleanup() : seed();
