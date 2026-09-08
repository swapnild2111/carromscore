<script lang="ts">
  /**
   * In-memory League Simulator — zero Firebase writes.
   * Runs the full UAE-style 48-player league algorithm client-side
   * and renders groups, round-robin schedules, and flight brackets.
   */

  import {
    potSeeding,
    generateRoundRobinPairs,
    redistributeToFlights,
    singleEliminationPairs,
    shuffleArray,
  } from '../../lib/league';

  // ─── UAE 48-player roster ─────────────────────────────────────────
  // Fictional UAE carrom players with synthetic pot scores (historical ranking).
  // Pot scores represent career strike points — higher = stronger seed.
  const PLAYERS: { name: string; score: number }[] = [
    // Top tier (pot 1 candidates — 8 players for 8 groups)
    { name: 'Khalid Al Mansouri',  score: 980 },
    { name: 'Mohammed Al Rashidi', score: 960 },
    { name: 'Ahmed Al Zaabi',      score: 945 },
    { name: 'Sultan Al Nuaimi',    score: 930 },
    { name: 'Saeed Al Mazrouei',   score: 918 },
    { name: 'Hamdan Al Falasi',    score: 905 },
    { name: 'Rashid Al Ketbi',     score: 892 },
    { name: 'Omar Al Shamsi',      score: 880 },
    // Pot 2
    { name: 'Faisal Al Suwaidi',   score: 855 },
    { name: 'Nasser Al Dhaheri',   score: 840 },
    { name: 'Tariq Al Marri',      score: 828 },
    { name: 'Yousuf Al Muhairi',   score: 815 },
    { name: 'Jassim Al Hajri',     score: 800 },
    { name: 'Abdullah Al Kaabi',   score: 788 },
    { name: 'Waleed Al Neyadi',    score: 775 },
    { name: 'Majid Al Qubaisi',    score: 762 },
    // Pot 3
    { name: 'Saif Al Blooshi',     score: 740 },
    { name: 'Rashed Al Ameri',     score: 726 },
    { name: 'Hamed Al Remeithi',   score: 712 },
    { name: 'Obaid Al Marzouqi',   score: 698 },
    { name: 'Saqer Al Yamahi',     score: 685 },
    { name: 'Humaid Al Teneiji',   score: 672 },
    { name: 'Mansoor Al Suwaidi',  score: 658 },
    { name: 'Zayed Al Harthi',     score: 644 },
    // Pot 4
    { name: 'Mubarak Al Khaili',   score: 620 },
    { name: 'Essa Al Romaithi',    score: 607 },
    { name: 'Khalifa Al Mazrouei', score: 594 },
    { name: 'Harib Al Mahri',      score: 580 },
    { name: 'Saeed Al Qubaisi',    score: 566 },
    { name: 'Marwan Al Hosani',    score: 552 },
    { name: 'Theyab Al Muhairi',   score: 538 },
    { name: 'Khamis Al Zaabi',     score: 525 },
    // Pot 5
    { name: 'Jamal Al Suwaidi',    score: 500 },
    { name: 'Falah Al Ameri',      score: 487 },
    { name: 'Nawaf Al Shamsi',     score: 474 },
    { name: 'Rashid Al Blooshi',   score: 460 },
    { name: 'Saeed Al Nuaimi',     score: 447 },
    { name: 'Ahmed Al Dhaheri',    score: 433 },
    { name: 'Sultan Al Hajri',     score: 420 },
    { name: 'Hamad Al Ketbi',      score: 406 },
    // Pot 6
    { name: 'Bilal Al Marzouqi',   score: 380 },
    { name: 'Yasser Al Kaabi',     score: 366 },
    { name: 'Adil Al Neyadi',      score: 352 },
    { name: 'Suhail Al Muhairi',   score: 338 },
    { name: 'Fawzi Al Teneiji',    score: 325 },
    { name: 'Rami Al Suwaidi',     score: 311 },
    { name: 'Loay Al Ameri',       score: 298 },
    { name: 'Issa Al Falasi',      score: 284 },
  ];

  const GROUP_COUNT = 8;
  const FLIGHT_NAMES = ['Gold Flight', 'Silver Flight', 'Bronze Flight'];
  // 8 groups × 6 players = 48 → 3 flights of 16 (8 groups × 2 ranks each)
  const BOARDS_PER_GROUP = 2;

  // Build lookup maps
  const playerIds = PLAYERS.map((_, i) => `p${i + 1}`);
  const playerNames = new Map(PLAYERS.map((p, i) => [`p${i + 1}`, p.name]));
  const potScores  = new Map(PLAYERS.map((p, i) => [`p${i + 1}`, p.score]));

  // ─── Reactive state ───────────────────────────────────────────────
  let groups     = $state(runSeeding());
  let activeTab  = $state<'groups' | 'schedule' | 'flights'>('groups');
  let openGroups = $state<Set<string>>(new Set());

  function runSeeding() {
    return potSeeding(playerIds, playerNames, potScores, GROUP_COUNT, 'Group ');
  }

  function reshuffleGroups() {
    groups = runSeeding();
    openGroups = new Set();
  }

  // ─── Derived data (recomputed reactively) ─────────────────────────

  // Per-group: list of match pairs using player display names
  const groupSchedules = $derived.by(() => {
    const out: { groupKey: string; groupName: string; pairs: [string, string][]; boards: number[] }[] = [];
    for (const [gKey, group] of Object.entries(groups)) {
      const pairs = generateRoundRobinPairs(group.playerIds);
      const boardStart = (group.order - 1) * BOARDS_PER_GROUP + 1;
      const boards = pairs.map((_, i) => boardStart + (i % BOARDS_PER_GROUP));
      out.push({ groupKey: gKey, groupName: group.name, pairs, boards });
    }
    out.sort((a, b) => {
      const ga = groups[a.groupKey]?.order ?? 0;
      const gb = groups[b.groupKey]?.order ?? 0;
      return ga - gb;
    });
    return out;
  });

  // Total match count across all groups
  const totalMatches = $derived(groupSchedules.reduce((n, g) => n + g.pairs.length, 0));

  // Flight seeds: rank-1/2 from each group → Gold, rank-3/4 → Silver, rank-5/6 → Bronze
  // For the simulation we use pot score as a proxy for final standing rank within group
  const flightSeeds = $derived.by(() => {
    // Build a simple mock standings per group: sort group players by pot score desc
    const standingsMap = new Map(
      Object.entries(groups).map(([, group]) => {
        const ranked = [...group.playerIds].sort(
          (a, b) => (potScores.get(b) ?? 0) - (potScores.get(a) ?? 0)
        );
        return [
          group.name,
          {
            groupKey: group.name,
            groupName: group.name,
            players: ranked.map((pid, i) => ({
              playerId: pid,
              name: playerNames.get(pid) ?? pid,
              rank: i + 1,
              groupKey: group.name,
              groupName: group.name,
              // PlayerSummary fields (unused by redistributeToFlights)
              matches: 0, wins: 0, losses: 0, draws: 0,
              boardsWon: 0, strikePoints: 0, netPoints: 0, pointsScored: 0,
            })),
          },
        ];
      })
    );
    const groupList = Object.values(groups).sort((a, b) => a.order - b.order);
    return redistributeToFlights(groupList, standingsMap, FLIGHT_NAMES);
  });

  // Per-flight bracket pairs
  const flightBrackets = $derived.by(() => {
    const out: { flightName: string; pairs: [string, string][]; seeds: string[] }[] = [];
    for (const fname of FLIGHT_NAMES) {
      const seeds = flightSeeds.get(fname) ?? [];
      const pairs = singleEliminationPairs(seeds);
      out.push({ flightName: fname, seeds, pairs });
    }
    return out;
  });

  function toggleGroup(key: string) {
    const next = new Set(openGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openGroups = next;
  }

  // Seed labels: which group did this player come from + their rank in that group
  function seedLabel(pid: string, flightName: string): string {
    const seeds = flightSeeds.get(flightName) ?? [];
    const seedIdx = seeds.indexOf(pid);
    if (seedIdx < 0) return '';
    return `Seed ${seedIdx + 1}`;
  }
</script>

<div class="sim-wrap">
  <header class="sim-hdr">
    <div class="sim-title-row">
      <h2 class="sim-title">UAE League Simulator</h2>
      <span class="sim-badge">IN-MEMORY · NO DB WRITES</span>
    </div>
    <p class="sim-desc">
      48 players · 8 groups of 6 · pot-based seeding (champions separated) ·
      15 round-robin matches per group · 3 knockout flights of 16
    </p>
  </header>

  <div class="sim-stats">
    <div class="sim-stat"><span class="sim-stat-n">48</span><span class="sim-stat-lbl">Players</span></div>
    <div class="sim-stat"><span class="sim-stat-n">8</span><span class="sim-stat-lbl">Groups</span></div>
    <div class="sim-stat"><span class="sim-stat-n">{totalMatches}</span><span class="sim-stat-lbl">Group matches</span></div>
    <div class="sim-stat"><span class="sim-stat-n">3 × 8</span><span class="sim-stat-lbl">Flight R16 matches</span></div>
    <div class="sim-stat"><span class="sim-stat-n">{totalMatches + 3 * (8 + 4 + 2 + 1)}</span><span class="sim-stat-lbl">Total matches</span></div>
  </div>

  <div class="sim-tabs" role="tablist">
    <button role="tab" aria-selected={activeTab === 'groups'} class="sim-tab" class:sim-tab-on={activeTab === 'groups'} onclick={() => activeTab = 'groups'}>Groups</button>
    <button role="tab" aria-selected={activeTab === 'schedule'} class="sim-tab" class:sim-tab-on={activeTab === 'schedule'} onclick={() => activeTab = 'schedule'}>Schedule</button>
    <button role="tab" aria-selected={activeTab === 'flights'} class="sim-tab" class:sim-tab-on={activeTab === 'flights'} onclick={() => activeTab = 'flights'}>Flights</button>
    <button class="btn-reshuffle" onclick={reshuffleGroups} title="Re-run pot seeding with a new random shuffle">↺ Re-seed</button>
  </div>

  <!-- ── Groups tab ── -->
  {#if activeTab === 'groups'}
    <p class="tab-hint">Pot-based seeding: pot 1 (top 8) spread one per group, shuffled within each pot so the draw is random but balanced.</p>
    <div class="group-grid">
      {#each Object.entries(groups).sort(([,a],[,b]) => a.order - b.order) as [gKey, group] (gKey)}
        <div class="group-card">
          <div class="group-card-hdr">
            <span class="group-card-name">{group.name}</span>
            <span class="group-card-count">{group.playerIds.length} players · boards {(group.order - 1) * BOARDS_PER_GROUP + 1}–{group.order * BOARDS_PER_GROUP}</span>
          </div>
          <ol class="group-player-list">
            {#each group.playerIds as pid, idx (pid)}
              {@const score = potScores.get(pid) ?? 0}
              {@const potNum = Math.floor(PLAYERS.findIndex(p => p.name === playerNames.get(pid)) / GROUP_COUNT) + 1}
              <li class="group-player" class:group-player-pot1={potNum === 1}>
                <span class="gp-rank">{idx + 1}</span>
                <span class="gp-name">{playerNames.get(pid)}</span>
                <span class="gp-score" title="Historical pot score">{score}</span>
                <span class="gp-pot" title="Pot number">P{potNum}</span>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </div>
  {/if}

  <!-- ── Schedule tab ── -->
  {#if activeTab === 'schedule'}
    <p class="tab-hint">Circle-method scheduling: {totalMatches} total matches. Each player plays {GROUP_COUNT - 1} matches within their group. Boards cycle so no player is on two boards at once.</p>
    <div class="schedule-grid">
      {#each groupSchedules as gs (gs.groupKey)}
        {@const open = openGroups.has(gs.groupKey)}
        <div class="sched-card" class:sched-card-open={open}>
          <button class="sched-card-hdr" onclick={() => toggleGroup(gs.groupKey)} aria-expanded={open}>
            <span class="sched-card-caret" class:sched-card-caret-closed={!open}>▾</span>
            <span class="sched-card-name">{gs.groupName}</span>
            <span class="sched-card-count">{gs.pairs.length} matches</span>
          </button>
          {#if open}
            <table class="sched-tbl">
              <thead>
                <tr><th>#</th><th>Board</th><th class="col-name">Side A</th><th class="col-name">Side B</th></tr>
              </thead>
              <tbody>
                {#each gs.pairs as [aId, bId], i}
                  <tr>
                    <td>{i + 1}</td>
                    <td>{gs.boards[i]}</td>
                    <td class="col-name">{playerNames.get(aId)}</td>
                    <td class="col-name">{playerNames.get(bId)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- ── Flights tab ── -->
  {#if activeTab === 'flights'}
    <p class="tab-hint">Rank-1/2 from each group → Gold Flight (16 players), rank-3/4 → Silver, rank-5/6 → Bronze. Standard bracket seeding: seed 1 vs 16, seed 8 vs 9, etc. (Standings simulated from pot scores for this preview.)</p>
    <div class="flights-wrap">
      {#each flightBrackets as fb (fb.flightName)}
        {@const isGold   = fb.flightName.startsWith('Gold')}
        {@const isSilver = fb.flightName.startsWith('Silver')}
        <div class="flight-card" class:flight-gold={isGold} class:flight-silver={isSilver} class:flight-bronze={!isGold && !isSilver}>
          <div class="flight-hdr">
            <span class="flight-name">{fb.flightName}</span>
            <span class="flight-count">{fb.seeds.length} players · {fb.pairs.length} R16 matches</span>
          </div>
          <div class="flight-body">
            <div class="flight-seeds">
              <div class="flight-seeds-hdr">Seeding</div>
              {#each fb.seeds as pid, i (pid)}
                <div class="flight-seed-row">
                  <span class="flight-seed-num">{i + 1}</span>
                  <span class="flight-seed-name">{playerNames.get(pid)}</span>
                  <span class="flight-seed-score">{potScores.get(pid)}</span>
                </div>
              {/each}
            </div>
            <div class="flight-bracket">
              <div class="flight-bracket-hdr">R16 draw</div>
              {#each fb.pairs as [aId, bId], i}
                <div class="bracket-match">
                  <span class="bracket-match-num">M{i + 1}</span>
                  <div class="bracket-players">
                    <span class="bracket-player bracket-player-a">{playerNames.get(aId)}</span>
                    <span class="bracket-vs">vs</span>
                    <span class="bracket-player bracket-player-b">{playerNames.get(bId)}</span>
                  </div>
                </div>
              {/each}
            </div>
          </div>
          <div class="flight-rounds-hint">
            <span class="flight-round-chip">R16 · 8 matches</span>
            <span class="flight-round-chip">QF · 4 matches</span>
            <span class="flight-round-chip">SF · 2 matches</span>
            <span class="flight-round-chip">Final · 1 match</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sim-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
    font-family: inherit;
    color: var(--fg, #f5f5f5);
  }

  /* ── Header ── */
  .sim-hdr { margin-bottom: 1.2rem; }
  .sim-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.35rem;
  }
  .sim-title {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 800;
    color: var(--accent, #ffd54a);
  }
  .sim-badge {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 0.2rem 0.6rem;
    background: rgba(100, 220, 100, 0.1);
    border: 1px solid rgba(100, 220, 100, 0.3);
    border-radius: 999px;
    color: #9be0a8;
  }
  .sim-desc {
    margin: 0;
    font-size: 0.85rem;
    color: rgba(255,255,255,0.55);
    line-height: 1.5;
  }

  /* ── Stats strip ── */
  .sim-stats {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 1.2rem;
  }
  .sim-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.5rem 0.9rem;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-top: 2px solid rgba(255,213,74,0.3);
    border-radius: 0.5rem;
    min-width: 5rem;
    text-align: center;
  }
  .sim-stat-n {
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--accent, #ffd54a);
    font-variant-numeric: tabular-nums;
  }
  .sim-stat-lbl {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255,255,255,0.45);
    margin-top: 0.1rem;
  }

  /* ── Tabs ── */
  .sim-tabs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    padding-bottom: 0;
  }
  .sim-tab {
    padding: 0.45rem 1rem;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: rgba(255,255,255,0.5);
    font: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
    margin-bottom: -1px;
  }
  .sim-tab:hover { color: var(--fg, #f5f5f5); }
  .sim-tab-on {
    color: var(--accent, #ffd54a);
    border-bottom-color: var(--accent, #ffd54a);
  }
  .btn-reshuffle {
    margin-left: auto;
    padding: 0.35rem 0.8rem;
    background: transparent;
    border: 1px solid rgba(255,213,74,0.4);
    border-radius: 0.4rem;
    color: var(--accent, #ffd54a);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.12s;
  }
  .btn-reshuffle:hover { background: rgba(255,213,74,0.08); }

  .tab-hint {
    margin: 0 0 1rem;
    font-size: 0.82rem;
    color: rgba(255,255,255,0.45);
    line-height: 1.5;
  }

  /* ── Groups grid ── */
  .group-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.75rem;
  }
  @media (min-width: 900px) { .group-grid { grid-template-columns: repeat(4, 1fr); } }
  @media (max-width: 540px) { .group-grid { grid-template-columns: 1fr; } }

  .group-card {
    background: rgba(255,213,74,0.03);
    border: 1px solid rgba(255,213,74,0.15);
    border-radius: 0.6rem;
    overflow: hidden;
  }
  .group-card-hdr {
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0.75rem;
    background: rgba(255,213,74,0.07);
    border-bottom: 1px solid rgba(255,213,74,0.12);
    gap: 0.1rem;
  }
  .group-card-name { font-size: 0.9rem; font-weight: 700; color: var(--accent, #ffd54a); }
  .group-card-count { font-size: 0.68rem; color: rgba(255,255,255,0.4); }

  .group-player-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
  }
  .group-player {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.28rem 0.75rem;
    font-size: 0.8rem;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .group-player:last-child { border-bottom: none; }
  .group-player-pot1 { background: rgba(255,213,74,0.04); }
  .gp-rank { width: 1rem; text-align: right; color: rgba(255,255,255,0.3); font-size: 0.7rem; flex-shrink: 0; }
  .gp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-player-pot1 .gp-name { color: var(--accent, #ffd54a); font-weight: 600; }
  .gp-score { font-size: 0.7rem; color: rgba(255,255,255,0.3); font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .gp-pot {
    font-size: 0.62rem;
    font-weight: 700;
    color: rgba(255,255,255,0.25);
    background: rgba(255,255,255,0.05);
    border-radius: 0.25rem;
    padding: 0.05rem 0.3rem;
    flex-shrink: 0;
  }
  .group-player-pot1 .gp-pot {
    color: rgba(255,213,74,0.7);
    background: rgba(255,213,74,0.1);
  }

  /* ── Schedule grid ── */
  .schedule-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.6rem;
  }
  @media (min-width: 900px) { .schedule-grid { grid-template-columns: repeat(4, 1fr); } }
  @media (max-width: 540px) { .schedule-grid { grid-template-columns: 1fr; } }

  .sched-card {
    border: 1px solid rgba(255,213,74,0.15);
    border-radius: 0.55rem;
    overflow: hidden;
  }
  .sched-card-hdr {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: rgba(255,213,74,0.07);
    border: none;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }
  .sched-card-hdr:hover { background: rgba(255,213,74,0.12); }
  .sched-card-caret {
    color: var(--accent, #ffd54a);
    font-size: 1rem;
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .sched-card-caret-closed { transform: rotate(-90deg); }
  .sched-card-name { flex: 1; }
  .sched-card-count {
    font-size: 0.68rem;
    font-weight: 500;
    color: rgba(255,255,255,0.4);
    background: rgba(255,255,255,0.06);
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .sched-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
  }
  .sched-tbl th {
    padding: 0.3rem 0.55rem;
    background: rgba(255,255,255,0.04);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.45);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    text-align: center;
  }
  .sched-tbl td {
    padding: 0.3rem 0.55rem;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    text-align: center;
    color: rgba(255,255,255,0.75);
  }
  .sched-tbl tr:last-child td { border-bottom: none; }
  .sched-tbl .col-name { text-align: left; }

  /* ── Flights ── */
  .flights-wrap {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .flight-card {
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 0.65rem;
    overflow: hidden;
  }
  .flight-gold   { border-color: rgba(255,213,74,0.35); }
  .flight-silver { border-color: rgba(192,192,210,0.35); }
  .flight-bronze { border-color: rgba(205,127,50,0.35); }

  .flight-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    gap: 0.5rem;
  }
  .flight-gold   .flight-hdr { background: rgba(255,213,74,0.08); }
  .flight-silver .flight-hdr { background: rgba(192,192,210,0.07); }
  .flight-bronze .flight-hdr { background: rgba(205,127,50,0.08); }

  .flight-name {
    font-size: 1rem;
    font-weight: 700;
  }
  .flight-gold   .flight-name { color: var(--accent, #ffd54a); }
  .flight-silver .flight-name { color: #c0c0d2; }
  .flight-bronze .flight-name { color: #cd7f32; }

  .flight-count {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.4);
    font-variant-numeric: tabular-nums;
  }

  .flight-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    border-top: 1px solid rgba(255,255,255,0.07);
  }
  @media (max-width: 640px) { .flight-body { grid-template-columns: 1fr; } }

  .flight-seeds {
    padding: 0.5rem 0.75rem;
    border-right: 1px solid rgba(255,255,255,0.07);
    overflow-x: auto;
  }
  .flight-bracket {
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
  }
  .flight-seeds-hdr,
  .flight-bracket-hdr {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: rgba(255,255,255,0.35);
    margin-bottom: 0.4rem;
    font-weight: 700;
  }

  .flight-seed-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0;
    font-size: 0.78rem;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .flight-seed-row:last-child { border-bottom: none; }
  .flight-seed-num {
    width: 1.4rem;
    text-align: right;
    color: rgba(255,255,255,0.3);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .flight-seed-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flight-seed-score {
    font-size: 0.68rem;
    color: rgba(255,255,255,0.25);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .bracket-match {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 0.78rem;
  }
  .bracket-match:last-child { border-bottom: none; }
  .bracket-match-num {
    font-size: 0.68rem;
    color: rgba(255,255,255,0.3);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    width: 1.8rem;
    text-align: right;
    padding-top: 0.05rem;
  }
  .bracket-players {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .bracket-player {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bracket-player-a { color: var(--fg, #f5f5f5); }
  .bracket-player-b { color: rgba(255,255,255,0.6); }
  .bracket-vs {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255,255,255,0.2);
  }

  .flight-rounds-hint {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.015);
  }
  .flight-round-chip {
    font-size: 0.68rem;
    padding: 0.15rem 0.5rem;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 999px;
    color: rgba(255,255,255,0.4);
    font-variant-numeric: tabular-nums;
  }
</style>
