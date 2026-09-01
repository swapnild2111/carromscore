<script lang="ts">
  /**
   * Printer-friendly tournament pack (v3.6.2). Reads
   * `?tournament=<key>` and renders:
   *
   *   Page 1 — cover: tournament name, mode + config, country (if
   *     closed), player roster with country flags. This is the
   *     "team briefing" page an organiser hands out at check-in.
   *   Pages 2..N — one page per physical board (Board 1, Board 2,
   *     …), each with a big centered QR that encodes
   *     `?tournament=<key>&board=<N>`. These are the stickers that
   *     get cut out and stuck on each physical board.
   *
   * Why per-board QR (not per-match): the sticker is permanent —
   * printed once and stuck to the physical carrom board. Every
   * round, the umpire on Board 3 scans the same QR; the app auto-
   * advances to whichever match is currently assigned to Board 3
   * (resolvePlannedByBoard in lib/planned.ts). Zero admin work
   * between rounds. See MatchSetup's `?board=` deep-link handler.
   *
   * Roster source:
   *   - Closed tournament: /tournaments/{key}/assignedPlayerIds is
   *     authoritative. We look each id up in the /players store to
   *     get canonical name + country.
   *   - Open tournament: gather unique player names from every
   *     /planned record for this tournament. No country pill unless
   *     the name resolves cleanly against the /players store.
   */
  import { onMount } from 'svelte';
  import {
    subscribePlannedByTournament,
    type PlannedMatch,
  } from '../../lib/planned';
  import { qrToSVG } from '../../lib/qrcode';
  import {
    subscribeTournaments,
    loadAll as loadAllTournaments,
    loadAssignedPlayers,
    subscribeStore as subscribeTournamentStore,
    type Tournament,
  } from '../../lib/tournaments';
  import {
    subscribePlayers,
    loadAll as loadAllPlayersFn,
    subscribeStore as subscribePlayerStore,
    type Player,
  } from '../../lib/players';
  import { countryName, flagEmoji } from '../../lib/countries';

  let tournamentKey = $state<string>('');
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsub: (() => void) | null = null;
  let ready = $state(false);
  // Error surface when the RTDB fetch stalls or the tournament key
  // can't be found. Prevents the print page from hanging on the
  // 'Loading…' text forever if something upstream is wrong.
  let loadError = $state<string | null>(null);

  // Reactive ticks — nudge derivations when the tournament and
  // player stores refresh from Firebase, without threading the raw
  // arrays through the template.
  let tournamentTick = $state(0);
  let playerTick = $state(0);

  // Assigned-player id set for closed tournaments (empty for open).
  // Populated once when the tournament record is known.
  let assignedIds = $state<Set<string>>(new Set());

  onMount(() => {
    if (typeof window === 'undefined') return () => {};
    const params = new URLSearchParams(window.location.search);
    tournamentKey = params.get('tournament') ?? '';
    if (params.get('qrMode') === 'match') qrMode = 'match';
    if (!tournamentKey) {
      ready = true;
      return () => {};
    }
    void subscribeTournaments();
    void subscribePlayers();
    const unsubT = subscribeTournamentStore(() => (tournamentTick += 1));
    const unsubP = subscribePlayerStore(() => (playerTick += 1));
    // Belt-and-braces load path (v3.6.2 fix): do a one-shot get()
    // against /planned so the page renders even if the onValue
    // subscription can't fire (misconfigured rules, malformed
    // legacy record throwing in the callback, etc.). Then attach
    // the subscription on top for live updates when boards are
    // added/removed. Either data source flips `ready`.
    (async () => {
      try {
        const [{ getDatabase, ref, get }, { firebaseApp }] = await Promise.all([
          import('firebase/database'),
          import('../../lib/firebase'),
        ]);
        const db = getDatabase(firebaseApp());
        const snap = await get(ref(db, 'planned'));
        const raw = snap.val() as Record<string, Omit<PlannedMatch, 'mid'>> | null;
        const out: PlannedMatch[] = [];
        if (raw) {
          for (const [mid, v] of Object.entries(raw)) {
            if (!v || typeof v !== 'object') continue;
            if (v.tournamentKey !== tournamentKey) continue;
            out.push({ mid, ...v });
          }
        }
        plannedMatches = out;
        ready = true;
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
        ready = true;
      }
    })();
    (async () => {
      unsub = await subscribePlannedByTournament(tournamentKey, (arr) => {
        plannedMatches = arr;
        ready = true;
      });
    })();
    // Safety timeout — if neither the get nor the subscribe fired
    // within 8s, stop showing Loading… and surface a hint so the
    // user knows something is wrong (network, rules, key typo).
    const timeoutId = window.setTimeout(() => {
      if (!ready) {
        loadError = 'Timed out reading /planned. Check your connection and the tournament key.';
        ready = true;
      }
    }, 8000);
    return () => {
      unsub?.();
      unsubT();
      unsubP();
      window.clearTimeout(timeoutId);
    };
  });

  // Organiser profile loaded from /organiserProfiles/{createdBy}.
  // Optional — print works fine without it; logo/organizer just won't show.
  type OrgProfile = { displayName?: string; orgName?: string; logoUrl?: string };
  let orgProfile = $state<OrgProfile | null>(null);

  // Tournament record (name, type, country, defaults). Nudged by
  // tournamentTick. Falls back to a minimal shim when the record
  // isn't in the local mirror yet.
  //
  // NOTE (v3.6.2 fix, 2026-08-31): use `$derived.by(fn)` for anything
  // whose body needs to run at derive time; `$derived(() => …)` in
  // Svelte 5 stores the ARROW as the value (not its return), which
  // caused a runtime 'a(...) is not a function' when the template
  // referenced the derived under paths where Svelte's compiler had
  // already auto-invoked the getter. `.by(fn)` is the explicit
  // "call fn every time deps change" form.
  const tournament = $derived.by<Tournament | null>(() => {
    void tournamentTick;
    if (!tournamentKey) return null;
    return loadAllTournaments().find((t) => t.key === tournamentKey) ?? null;
  });

  // Load organiser profile once the tournament record's createdBy is known.
  $effect(() => {
    const uid = tournament?.createdBy;
    if (!uid) return;
    void (async () => {
      try {
        const [{ getDatabase, ref, get }, { firebaseApp }] = await Promise.all([
          import('firebase/database'),
          import('../../lib/firebase'),
        ]);
        const db = getDatabase(firebaseApp());
        const snap = await get(ref(db, `organiserProfiles/${uid}`));
        orgProfile = snap.exists() ? (snap.val() as OrgProfile) : null;
      } catch {
        orgProfile = null;
      }
    })();
  });

  // Derived print values — prefer tournament-level overrides (desc stays on
  // tournament), fall back to organiser profile for logo + organizer name.
  const printLogoUrl = $derived(orgProfile?.logoUrl ?? null);
  const printOrganizerName = $derived(
    orgProfile?.orgName || orgProfile?.displayName || null,
  );

  // Load assigned-player set once when we have both the tournament
  // and its type. Silent-on-failure: an empty set just hides the
  // roster section for a closed tournament, which is safer than a
  // partial list.
  $effect(() => {
    const t = tournament;
    if (!t || t.type !== 'closed') {
      assignedIds = new Set();
      return;
    }
    void loadAssignedPlayers(t.key).then((set) => {
      assignedIds = set;
    }).catch(() => {
      assignedIds = new Set();
    });
  });

  // Player roster to render on the cover page. For closed
  // tournaments this is the assigned set resolved against /players.
  // For open tournaments it's unique names gathered from planned
  // records, each attempted to resolve against /players for a
  // country pill.
  type RosterRow = { name: string; country?: string };
  const roster = $derived.by<RosterRow[]>(() => {
    void playerTick;
    void tournamentTick;
    const t = tournament;
    if (!t) return [];
    const players: Player[] = loadAllPlayersFn();
    const byId = new Map(players.map((p) => [p.id, p]));
    const byName = new Map<string, Player>();
    for (const p of players) byName.set(p.canonicalName.toLowerCase(), p);

    const out: RosterRow[] = [];
    if (t.type === 'closed') {
      for (const id of assignedIds) {
        const p = byId.get(id);
        if (!p) continue;
        out.push({
          name: p.canonicalName,
          ...(p.country ? { country: p.country } : {}),
        });
      }
    } else {
      const seen = new Set<string>();
      for (const m of plannedMatches) {
        for (const raw of [m.aName, m.a2Name, m.bName, m.b2Name]) {
          if (!raw) continue;
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const p = byName.get(key);
          out.push({
            name: p ? p.canonicalName : trimmed,
            ...(p?.country ? { country: p.country } : {}),
          });
        }
      }
    }
    // Alphabetical by canonical name so the roster reads like a
    // check-in sheet, not a bracket seed order.
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  });

  // Board numbers to print: union of all `board` values across
  // rounds, then filled 1..max so gaps still print a sticker.
  const boards = $derived.by<number[]>(() => {
    let max = 0;
    for (const m of plannedMatches) {
      if (m.board && m.board >= 1 && m.board <= 99 && m.board > max) {
        max = m.board;
      }
    }
    if (max === 0) return [];
    const out: number[] = [];
    for (let i = 1; i <= max; i += 1) out.push(i);
    return out;
  });

  // QR mode: 'board' = one permanent sticker per physical board (default),
  //          'match' = one QR per planned match showing who plays who.
  let qrMode = $state<'board' | 'match'>('board');

  // QR SVG cache — keyed by board number (board mode) or mid (match mode).
  let qrByBoard = $state<Record<number, string>>({});
  let qrByMid = $state<Record<string, string>>({});
  const scanBase = (() => {
    if (typeof window === 'undefined') return '';
    const base = import.meta.env.BASE_URL ?? '/';
    return `${window.location.origin}${base}`;
  })();

  function setQrMode(m: 'board' | 'match') {
    qrMode = m;
    const url = new URL(window.location.href);
    url.searchParams.set('qrMode', m);
    window.history.replaceState(null, '', url.toString());
  }

  $effect(() => {
    if (!tournamentKey) return;
    // Board QRs.
    for (const b of boards) {
      if (qrByBoard[b]) continue;
      const url = `${scanBase}?tournament=${encodeURIComponent(tournamentKey)}&board=${b}`;
      void qrToSVG(url, 400).then((svg) => {
        qrByBoard = { ...qrByBoard, [b]: svg };
      });
    }
    // Match QRs.
    for (const m of plannedMatches) {
      if (qrByMid[m.mid]) continue;
      const url = `${scanBase}?planned=${encodeURIComponent(m.mid)}`;
      void qrToSVG(url, 280).then((svg) => {
        qrByMid = { ...qrByMid, [m.mid]: svg };
      });
    }
  });

  // Human-readable config line for the cover page. Uses the same
  // fallbacks that AdminTournaments seeds new tournaments with when
  // a field is missing (bo3 / 25 / 8 / singles).
  const configLine = $derived.by<string>(() => {
    const d = tournament?.defaults ?? {};
    const mode = d.mode === 'doubles' ? 'Doubles' : 'Singles';
    const bo = d.bestOf ?? 3;
    const pts = d.pointsTarget ?? 25;
    const mb = d.maxBoards ?? 8;
    const mbTxt = mb === 0 ? 'unlimited boards' : `max ${mb} boards`;
    return `${mode} · best of ${bo} · target ${pts} points · ${mbTxt}`;
  });

  const tournamentName = $derived<string>(
    tournament?.name ?? plannedMatches[0]?.tournament ?? tournamentKey,
  );

  // Match count for the cover — reads directly from the /planned
  // subscription so it reflects every round.
  const matchCount = $derived<number>(plannedMatches.length);

  // Rounds + matches grouped for the schedule section. Each entry has
  // the round display name, order, and its matches sorted by matchOrder.
  type ScheduleRound = {
    roundKey: string;
    roundName: string;
    order: number;
    matches: PlannedMatch[];
  };
  const schedule = $derived.by<ScheduleRound[]>(() => {
    void tournamentTick;
    const byRound = new Map<string, ScheduleRound>();
    for (const m of plannedMatches) {
      if (!m.roundKey) continue;
      if (!byRound.has(m.roundKey)) {
        // Try to get display name + order from the tournament record's rounds array.
        const t = tournament;
        const r = t?.rounds?.find((rx) => rx.key === m.roundKey);
        byRound.set(m.roundKey, {
          roundKey: m.roundKey,
          roundName: r?.name ?? m.round ?? m.roundKey,
          order: r?.order ?? 0,
          matches: [],
        });
      }
      byRound.get(m.roundKey)!.matches.push(m);
    }
    // Sort matches within each round by matchOrder, then sort rounds by order.
    const out = [...byRound.values()];
    for (const r of out) {
      r.matches.sort((a, b) => (a.matchOrder ?? 0) - (b.matchOrder ?? 0));
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  });
</script>

<div class="print-wrap">
  {#if !tournamentKey}
    <p class="hint">Provide a <code>?tournament=&lt;key&gt;</code> URL param.</p>
  {:else if !ready}
    <p class="hint">Loading…</p>
  {:else if loadError}
    <p class="hint">
      Couldn't load this tournament's bracket. {loadError}
    </p>
  {:else if plannedMatches.length === 0}
    <p class="hint">
      No matches planned yet for <strong>{tournamentKey}</strong>.
      Open the tournament's Bracket and add matches first.
    </p>
  {:else if boards.length === 0}
    <p class="hint">
      Matches exist but none have a board number assigned. Edit each
      bracket row and set a Board (1..99), then come back and print.
    </p>
  {:else}
    <div class="print-actions no-print">
      <div class="print-toolbar">
        <div class="qr-type-group" role="group" aria-label="QR type">
          <span class="qr-type-label">QR type</span>
          <div class="seg-ctrl">
            <button
              type="button"
              class="seg-btn"
              class:seg-active={qrMode === 'board'}
              aria-pressed={qrMode === 'board'}
              onclick={() => setQrMode('board')}
            >Per board</button>
            <button
              type="button"
              class="seg-btn"
              class:seg-active={qrMode === 'match'}
              aria-pressed={qrMode === 'match'}
              onclick={() => setQrMode('match')}
            >Per match</button>
          </div>
        </div>
        <button type="button" class="print-btn" onclick={() => window.print()}>🖨 Print</button>
      </div>
      <p class="hint">
        {#if qrMode === 'board'}
          Board stickers — permanent QR per board, same every round. Cut out and stick to each physical board.
        {:else}
          Match cards — one QR per match. Cut out and place at the board for that match.
        {/if}
      </p>
    </div>

    <!-- ─── COVER PAGE ─────────────────────────────────────────────
         Tournament name banner, then config line, then the roster.
         Layout tuned so the whole page fits on A4 portrait even for
         tournaments with ~40 players (two columns of names). -->
    <section class="page cover">
      <div class="cover-hdr">
        <div class="cover-hdr-main">
          <p class="brand">Carromscore</p>
          <h1 class="cover-name">{tournamentName}</h1>
          {#if tournament?.country}
            <p class="cover-country">
              <span aria-hidden="true">{flagEmoji(tournament?.country ?? '')}</span>
              {countryName(tournament?.country ?? '')}
            </p>
          {/if}
          {#if tournament?.description}
            <p class="cover-description">{tournament.description}</p>
          {/if}
        </div>
        {#if printLogoUrl}
          <img src={printLogoUrl} alt="Tournament logo" class="cover-logo" />
        {/if}
      </div>

      <div class="cover-meta">
        <div class="meta-row">
          <span class="meta-label">Format</span>
          <span class="meta-value">{configLine}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Type</span>
          <span class="meta-value">
            {tournament?.type === 'closed' ? 'Invite-only (assigned roster)' : 'Open'}
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Boards</span>
          <span class="meta-value">{boards.length}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Matches</span>
          <span class="meta-value">{matchCount}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Players</span>
          <span class="meta-value">{roster.length}</span>
        </div>
      </div>

      {#if roster.length > 0}
        <h2 class="cover-section">
          Players ({roster.length})
        </h2>
        <ol class="roster">
          {#each roster as p (p.name)}
            <li class="roster-row">
              <span class="roster-name">{p.name}</span>
              {#if p.country && p.country !== 'Unknown'}
                <span class="roster-country">
                  <span aria-hidden="true">{flagEmoji(p.country)}</span>
                  {countryName(p.country)}
                </span>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="cover-empty">No players registered yet.</p>
      {/if}

      {#if schedule.length > 0}
        <h2 class="cover-section" style="margin-top:1.4rem">
          Schedule ({matchCount} {matchCount === 1 ? 'match' : 'matches'})
        </h2>
        {#each schedule as round, ri (round.roundKey)}
          <div class="sched-round">
            <p class="sched-round-name">{round.roundName}</p>
            <table class="sched-table">
              <thead>
                <tr>
                  <th class="sched-th-board">{qrMode === 'match' ? 'Match' : 'Board'}</th>
                  <th class="sched-th-match">Match</th>
                </tr>
              </thead>
              <tbody>
                {#each round.matches as m, mi (m.mid)}
                  {@const matchNum = schedule.slice(0, ri).reduce((acc, r) => acc + r.matches.length, 0) + mi + 1}
                  <tr>
                    <td class="sched-board">{qrMode === 'match' ? `M${matchNum}` : (m.board ? `B${m.board}` : '—')}</td>
                    <td class="sched-matchup">
                      <span class="sched-player">{m.aName}{#if m.a2Name} + {m.a2Name}{/if}</span>
                      <span class="sched-vs">vs</span>
                      <span class="sched-player">{m.bName}{#if m.b2Name} + {m.b2Name}{/if}</span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      {/if}

    </section>

    {#if qrMode === 'board'}
      <!-- ─── BOARD STICKERS (permanent per-board QR, 2-column grid) ── -->
      <section class="page qr-grid-page">
        <div class="qr-grid-hdr">
          <p class="brand">Carromscore</p>
          <p class="qr-grid-title">{tournamentName} — Board QR Codes</p>
          <p class="qr-grid-sub">Cut out each sticker and stick it on the physical board. Same QR used every round.</p>
        </div>
        <div class="qr-grid">
          {#each boards as b (b)}
            <div class="qr-cell">
              <p class="qr-cell-board">Board {b}</p>
              <div class="qr-holder">
                {#if qrByBoard[b]}
                  {@html qrByBoard[b]}
                {:else}
                  <div class="qr-placeholder">generating…</div>
                {/if}
              </div>
              <p class="cta">Scan to start current match</p>
            </div>
          {/each}
        </div>
      </section>
    {:else}
      <!-- ─── PER-MATCH QR CARDS (one QR per planned match) ─────────── -->
      {#each schedule as round, ri (round.roundKey)}
        <section class="page qr-grid-page">
          <div class="qr-grid-hdr">
            <p class="brand">Carromscore</p>
            <p class="qr-grid-title">{tournamentName} — {round.roundName}</p>
            <p class="qr-grid-sub">Cut out each card and place at the board for that match. Scan to start scoring.</p>
          </div>
          <div class="match-qr-grid">
            {#each round.matches as m, mi (m.mid)}
              {@const matchNum = schedule.slice(0, ri).reduce((acc, r) => acc + r.matches.length, 0) + mi + 1}
              <div class="match-qr-cell">
                <p class="mqr-board">Match {matchNum}</p>
                <div class="mqr-matchup">
                  <span class="mqr-side">{m.aName}{#if m.a2Name}<br/><span class="mqr-partner">{m.a2Name}</span>{/if}</span>
                  <span class="mqr-vs">vs</span>
                  <span class="mqr-side">{m.bName}{#if m.b2Name}<br/><span class="mqr-partner">{m.b2Name}</span>{/if}</span>
                </div>
                <div class="mqr-qr-holder">
                  {#if qrByMid[m.mid]}
                    {@html qrByMid[m.mid]}
                  {:else}
                    <div class="qr-placeholder">generating…</div>
                  {/if}
                </div>
                <p class="cta">Scan to start scoring</p>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  {/if}

  {#if printOrganizerName || printLogoUrl}
    <div class="print-footer" aria-hidden="true">
      {#if printLogoUrl}
        <img src={printLogoUrl} alt="Organiser logo" class="print-footer-logo" />
      {/if}
      {#if printOrganizerName}
        <span class="print-footer-org">Organised by {printOrganizerName}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .print-wrap {
    max-width: 60rem;
    margin: 0 auto;
    padding: 1rem;
    color: #000;
    background: #fff;
  }
  .hint {
    color: #555;
    font-size: 0.9rem;
    text-align: center;
    padding: 2rem 0;
  }
  .print-actions {
    background: #f8f8f8;
    border: 1px dashed #bbb;
    border-radius: 0.5rem;
    padding: 0.9rem 1rem 0.75rem;
    margin-bottom: 1rem;
  }
  .print-toolbar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .qr-type-group {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .qr-type-label {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #666;
  }
  /* Segmented control */
  .seg-ctrl {
    display: inline-flex;
    background: #e8e8e8;
    border: 1px solid #ccc;
    border-radius: 999px;
    padding: 3px;
    gap: 2px;
  }
  .seg-btn {
    padding: 0.3rem 0.9rem;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: #555;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    white-space: nowrap;
  }
  .seg-btn:hover:not(.seg-active) { background: rgba(0,0,0,0.06); color: #222; }
  .seg-active {
    background: #ffd54a;
    color: #000;
    box-shadow: 0 1px 4px rgba(0,0,0,0.18);
  }
  /* Print action button — visually distinct from the selector */
  .print-btn {
    background: #222;
    color: #fff;
    border: none;
    padding: 0.45rem 1.2rem;
    font-size: 0.95rem;
    font-weight: 700;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .print-btn:hover { background: #000; }
  .print-actions .hint {
    padding: 0.6rem 0 0;
    color: #666;
    font-size: 0.82rem;
    text-align: center;
  }

  .page {
    background: #fff;
    color: #000;
    padding: 2rem;
    border: 1px solid #ccc;
    margin: 1rem 0;
    break-after: page;
    page-break-after: always;
  }
  .page:last-child { break-after: auto; page-break-after: auto; }

  /* ─── Cover page ─────────────────────────────────────────────── */
  .cover {
    display: flex;
    flex-direction: column;
  }
  .cover-hdr {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding-bottom: 0.9rem;
    border-bottom: 3px solid #000;
  }
  .cover-hdr-main {
    flex: 1;
    text-align: center;
  }
  .cover-logo {
    flex-shrink: 0;
    max-height: 4rem;
    max-width: 7rem;
    object-fit: contain;
    align-self: center;
  }
  .brand {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    color: #888;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .cover-name {
    margin: 0.2rem 0 0.3rem;
    font-size: 2.1rem;
    font-weight: 900;
    color: #000;
    letter-spacing: 0.01em;
    line-height: 1.15;
  }
  .cover-country {
    margin: 0.3rem 0 0;
    font-size: 1rem;
    color: #333;
    font-weight: 500;
  }
  .cover-description {
    margin: 0.5rem auto 0;
    max-width: 32rem;
    font-size: 0.92rem;
    color: #555;
    line-height: 1.45;
  }
  .cover-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem 1.2rem;
    padding: 1rem 0 1rem;
    border-bottom: 1px solid #ddd;
  }
  .meta-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: 0.95rem;
  }
  .meta-label {
    color: #666;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    min-width: 4.5rem;
  }
  .meta-value {
    color: #000;
    font-weight: 600;
  }

  .cover-section {
    margin: 1.1rem 0 0.5rem;
    font-size: 1.05rem;
    color: #000;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 800;
  }
  .roster {
    list-style: decimal;
    padding-left: 1.6rem;
    margin: 0.4rem 0 0;
    /* Two columns on wide-ish pages so a ~30-player list fits on one
       A4 sheet. Each row is a single line, so the columns balance
       reasonably even with uneven names. */
    column-count: 2;
    column-gap: 2rem;
  }
  .roster-row {
    break-inside: avoid;
    -webkit-column-break-inside: avoid;
    page-break-inside: avoid;
    padding: 0.15rem 0;
    font-size: 0.92rem;
    color: #111;
  }
  .roster-name { font-weight: 600; }
  .roster-country {
    color: #555;
    font-size: 0.82rem;
    margin-left: 0.35rem;
    white-space: nowrap;
  }
  .cover-empty {
    color: #666;
    font-style: italic;
    margin: 1rem 0 0;
  }

  /* ─── Schedule section ───────────────────────────────────────── */
  .sched-round {
    margin: 0.8rem 0 1.1rem;
  }
  .sched-round-name {
    margin: 0 0 0.3rem;
    font-size: 0.82rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #555;
    border-bottom: 2px solid #000;
    padding-bottom: 0.2rem;
  }
  .sched-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
    table-layout: fixed;
  }
  .sched-table thead th {
    text-align: left;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #999;
    padding: 0.2rem 0 0.2rem;
    border-bottom: 1px solid #ddd;
  }
  .sched-th-board { width: 4rem; }
  .sched-th-match { }
  .sched-table tbody tr:nth-child(even) { background: #f5f5f5; }
  .sched-table td {
    padding: 0.28rem 0;
    color: #111;
    vertical-align: middle;
  }
  .sched-board {
    font-weight: 800;
    white-space: nowrap;
    width: 4rem;
    color: #000;
    font-size: 0.9rem;
  }
  .sched-matchup {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: nowrap;
  }
  .sched-player {
    font-weight: 600;
    /* Don't stretch — sit as tight as the name allows */
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .sched-vs {
    color: #bbb;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
    padding: 0 0.15rem;
  }

  /* ─── QR grid page ────────────────────────────────────────────── */
  .qr-grid-page {
    break-after: page;
    page-break-after: always;
  }
  .qr-grid-hdr {
    text-align: center;
    padding-bottom: 1rem;
    border-bottom: 2px solid #000;
    margin-bottom: 1.2rem;
  }
  .qr-grid-title {
    margin: 0.2rem 0 0.2rem;
    font-size: 1.2rem;
    font-weight: 800;
    color: #000;
  }
  .qr-grid-sub {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    color: #666;
  }
  .qr-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem 2rem;
  }
  .qr-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    border: 1.5px dashed #ccc;
    padding: 1rem 0.8rem 0.8rem;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .qr-cell-board {
    margin: 0 0 0.6rem;
    font-size: 1.5rem;
    font-weight: 900;
    color: #000;
    letter-spacing: 0.02em;
  }
  .qr-holder {
    background: #fff;
    padding: 0.4rem;
    border: 2px solid #000;
    line-height: 0;
  }
  .qr-holder :global(svg) {
    width: 220px;
    height: 220px;
    display: block;
  }
  .qr-placeholder {
    width: 220px;
    height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 0.85rem;
    border: 1px dashed #ccc;
  }
  .cta {
    margin: 0.5rem 0 0;
    color: #555;
    font-size: 0.78rem;
  }

  /* ─── Per-match QR grid ─────────────────────────────────────── */
  .match-qr-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.2rem 1.5rem;
    margin-top: 1rem;
  }
  .match-qr-cell {
    border: 1px dashed #bbb;
    border-radius: 0.5rem;
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .mqr-board {
    margin: 0 0 0.3rem;
    font-size: 0.8rem;
    font-weight: 700;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .mqr-matchup {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    margin-bottom: 0.5rem;
  }
  .mqr-side {
    flex: 1 1 0;
    font-size: 0.88rem;
    font-weight: 700;
    color: #111;
    line-height: 1.25;
    text-align: center;
  }
  .mqr-partner {
    font-size: 0.78rem;
    font-weight: 500;
    color: #444;
  }
  .mqr-vs {
    font-size: 0.78rem;
    font-weight: 600;
    color: #999;
    flex-shrink: 0;
  }
  .mqr-qr-holder {
    width: 180px;
    height: 180px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mqr-qr-holder :global(svg) { width: 180px !important; height: 180px !important; }

  /* Print footer — hidden on screen, fixed to bottom of every page in print. */
  .print-footer {
    display: none;
  }

  @media print {
    :global(body) { background: #fff; margin: 0; padding: 0; }
    .no-print { display: none !important; }
    .print-wrap { padding: 0; margin: 0; max-width: none; }
    .page {
      border: none;
      margin: 0;
      padding: 1.2cm 1.4cm 2cm;
      min-height: 0;
    }
    /* Roster column count survives print — keep it at 2. */
    .print-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
      position: fixed;
      bottom: 0.6cm;
      left: 1.4cm;
      right: 1.4cm;
      border-top: 1px solid #ddd;
      padding-top: 0.25cm;
    }
    .print-footer-logo {
      max-height: 1.4rem;
      max-width: 3rem;
      object-fit: contain;
    }
    .print-footer-org {
      font-size: 0.72rem;
      color: #888;
      font-style: italic;
      letter-spacing: 0.01em;
    }
  }

  /* Narrow phone preview: single-column meta + roster so the
     preview reads sensibly before the user prints. */
  @media (max-width: 34rem) {
    .cover-meta,
    .roster {
      grid-template-columns: 1fr;
      column-count: 1;
    }
  }
</style>
