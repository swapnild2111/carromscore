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
  import { type MatchRecord } from '../../lib/history';
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
  import { BRACKET_ROUND_RX } from '../../lib/bracket';

  let tournamentKey = $state<string>('');
  let plannedMatches = $state<PlannedMatch[]>([]);
  let historyMatches = $state<MatchRecord[]>([]);
  let unsub: (() => void) | null = null;
  // Error surface when the RTDB fetch stalls or the tournament key
  // can't be found. Prevents the print page from hanging on the
  // 'Loading…' text forever if something upstream is wrong.
  let loadError = $state<string | null>(null);

  // Reactive ticks — nudge derivations when the tournament and
  // player stores refresh from Firebase, without threading the raw
  // arrays through the template.
  let tournamentTick = $state(0);
  let playerTick = $state(0);
  let plannedReady = $state(false);
  let playersReady = $state(false);
  let historyReady = $state(false);
  // Wait for /planned, /players, and /matches history before rendering.
  const ready = $derived(plannedReady && playersReady && historyReady);

  /** Resolve a player id to their current canonical name, falling back
   *  to the stored string. Mirrors history.ts playerName(). */
  function resolvedName(id: string | undefined, fallback: string): string {
    void playerTick;
    if (!id) return fallback;
    const p = loadAllPlayersFn().find((x) => x.id === id);
    return p?.canonicalName ?? fallback;
  }

  // Assigned-player id set for closed tournaments (empty for open).
  // Populated once when the tournament record is known.
  let assignedIds = $state<Set<string>>(new Set());

  onMount(() => {
    if (typeof window === 'undefined') return () => {};
    const params = new URLSearchParams(window.location.search);
    tournamentKey = params.get('tournament') ?? '';
    if (params.get('qrMode') === 'match') qrMode = 'match';
    if (!tournamentKey) {
      plannedReady = true;
      playersReady = true;
      historyReady = true;
      return () => {};
    }
    void subscribeTournaments();
    void subscribePlayers();
    const unsubT = subscribeTournamentStore(() => (tournamentTick += 1));
    // Players are cosmetic (canonical name resolution) — don't block rendering.
    // Set ready immediately; names update reactively when the store arrives.
    playersReady = true;
    const unsubP = subscribePlayerStore(() => {
      playerTick += 1;
    });
    // Single import chain — fetch /planned and /matches in parallel,
    // then attach the live subscription. One module load instead of three.
    (async () => {
      try {
        const [{ getDatabase, ref, get, query, orderByChild, equalTo }, { firebaseApp }] =
          await Promise.all([import('firebase/database'), import('../../lib/firebase')]);
        const db = getDatabase(firebaseApp());

        // Fetch /planned and /matches simultaneously.
        const [plannedSnap, matchesSnap] = await Promise.all([
          get(query(ref(db, 'planned'), orderByChild('tournamentKey'), equalTo(tournamentKey))),
          get(query(ref(db, 'matches'), orderByChild('tournamentKey'), equalTo(tournamentKey))).catch(() => null),
        ]);

        const plannedRaw = plannedSnap.val() as Record<string, Omit<PlannedMatch, 'mid'>> | null;
        const plannedOut: PlannedMatch[] = [];
        if (plannedRaw) {
          for (const [mid, v] of Object.entries(plannedRaw)) {
            if (!v || typeof v !== 'object') continue;
            plannedOut.push({ mid, ...v });
          }
        }
        plannedMatches = plannedOut;
        plannedReady = true;

        const matchesRaw = matchesSnap?.val() as Record<string, Omit<MatchRecord, 'id'>> | null;
        const matchesOut: MatchRecord[] = [];
        if (matchesRaw) {
          for (const [id, v] of Object.entries(matchesRaw)) {
            if (!v || typeof v !== 'object') continue;
            matchesOut.push({ id, ...v });
          }
        }
        historyMatches = matchesOut;
        historyReady = true;
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
        plannedReady = true;
        historyReady = true;
      }

      // Live subscription for board additions/removals (non-blocking).
      unsub = await subscribePlannedByTournament(tournamentKey, (arr) => {
        plannedMatches = arr;
        plannedReady = true;
      });
    })();
    // Safety timeout — if neither the get nor the subscribe fired
    // within 8s, stop showing Loading… and surface a hint so the
    // user knows something is wrong (network, rules, key typo).
    const timeoutId = window.setTimeout(() => {
      if (!ready) {
        loadError = 'Timed out reading /planned. Check your connection and the tournament key.';
        plannedReady = true;
        playersReady = true;
        historyReady = true;
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

  // Derived print values.
  // Logo: organiser profile first, then fall back to the legacy per-tournament
  // logoUrl (tournaments created before the profile system stored the logo directly).
  // Organizer name: organiser profile only (the old per-tournament organizerName
  // field was removed from the add/edit dialogs).
  const printLogoUrl = $derived(
    orgProfile?.logoUrl ?? tournament?.logoUrl ?? null,
  );
  const printOrganizerName = $derived(
    orgProfile?.orgName || orgProfile?.displayName ||
    tournament?.organizerName || null,
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
    // Board QRs — one per board, few in number, safe to reassign individually.
    for (const b of boards) {
      if (qrByBoard[b]) continue;
      const url = `${scanBase}?tournament=${encodeURIComponent(tournamentKey)}&board=${b}`;
      void qrToSVG(url, 400).then((svg) => { qrByBoard = { ...qrByBoard, [b]: svg }; });
    }
    // Match QRs — generate all in parallel then write the entire batch at once
    // so concurrent promises don't race-overwrite each other via spread.
    const pending = plannedMatches.filter((m) => !qrByMid[m.mid]);
    if (pending.length > 0) {
      void Promise.all(
        pending.map((m) =>
          qrToSVG(`${scanBase}?planned=${encodeURIComponent(m.mid)}`, 280)
            .then((svg): [string, string] => [m.mid, svg])
        )
      ).then((pairs) => {
        const next = { ...qrByMid };
        for (const [mid, svg] of pairs) next[mid] = svg;
        qrByMid = next;
      }).catch((err) => { console.error('[PrintBracket] QR generation failed:', err); });
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

  const timerLine = $derived<string | null>(
    (tournament?.defaults?.timerDuration ?? 0) > 0
      ? `${tournament!.defaults!.timerDuration} min`
      : null
  );

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

  // Bracket rounds: QF/SF/Final/R16/R32 only, sorted by order.
  const bracketRounds = $derived.by<ScheduleRound[]>(() =>
    schedule.filter((r) => BRACKET_ROUND_RX.test(r.roundName))
  );

  // Merged schedule for display: bracket sub-rounds (QF Match 1–4, R16 Match 1–8)
  // are collapsed into one section per flight+stage (e.g. "Bronze League — Quarter Finals").
  // Group rounds and non-bracket rounds stay as individual sections.
  // Matches are deduplicated by mid within each merged section.
  type MergedRound = { key: string; displayName: string; matches: PlannedMatch[]; order: number };
  const mergedSchedule = $derived.by<MergedRound[]>(() => {
    const out = new Map<string, MergedRound>();
    for (const sr of schedule) {
      const isBracket = BRACKET_ROUND_RX.test(sr.roundName);
      if (isBracket) {
        // Build a merge key: flight + stage label
        const sep = sr.roundName.indexOf(' — ');
        const flight = sep !== -1 ? sr.roundName.slice(0, sep) : '';
        const stage = stageLabel(sr.roundName);
        const mergeKey = flight ? `${flight} — ${stage}` : stage;
        if (!out.has(mergeKey)) {
          out.set(mergeKey, { key: mergeKey, displayName: mergeKey, matches: [], order: sr.order });
        }
        const bucket = out.get(mergeKey)!;
        // Deduplicate by mid
        const seen = new Set(bucket.matches.map((m) => m.mid));
        for (const m of sr.matches) {
          if (!seen.has(m.mid)) { bucket.matches.push(m); seen.add(m.mid); }
        }
        // Keep the earliest order for sorting
        if (sr.order < bucket.order) bucket.order = sr.order;
      } else {
        // Group / non-bracket round — normalise "Group RR" for round-robin
        const displayName = sr.roundName === 'Group RR' ? 'Round Robin Group' : sr.roundName;
        out.set(sr.roundKey, { key: sr.roundKey, displayName, matches: sr.matches, order: sr.order });
      }
    }
    return [...out.values()].sort((a, b) => a.order - b.order);
  });

  // Canonical stage label shared by SVG builder and template header chips
  function stageLabel(name: string): string {
    const n = name.replace(/^.*?—\s*/, '');
    if (n.includes('Final') && !n.includes('SF')) return 'Finals';
    if (n.includes('SF')) return 'Semi Finals';
    if (n.includes('QF')) return 'Quarter Finals';
    if (n.includes('R16') || n.toLowerCase().includes('round of 16')) return 'Rounds';
    if (n.includes('R32')) return 'Rounds';
    return n;
  }

  // Build per-set scores map from match history boardLog.
  type SetScore = { a: number; b: number };
  function buildSetScoresMap(records: MatchRecord[]): Map<string, SetScore[]> {
    const m = new Map<string, SetScore[]>();
    for (const rec of records) {
      if (!rec?.id || !rec.boardLog?.length) continue;
      const bySet = new Map<number, { a: number; b: number }>();
      for (const entry of rec.boardLog) {
        if (!entry) continue;
        const s = entry.set ?? 0;
        if (!bySet.has(s)) bySet.set(s, { a: 0, b: 0 });
        const agg = bySet.get(s)!;
        agg.a += entry.pointsA ?? 0;
        agg.b += entry.pointsB ?? 0;
      }
      const sets = [...bySet.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      if (sets.length > 0) m.set(rec.id, sets);
    }
    return m;
  }

  // Match slot type used by the SVG builder (works with both history and planned data).
  type BracketSlot = {
    aId?: string; aName: string;
    bId?: string; bName: string;
    isDone: boolean;
    winner?: 'a' | 'b';
    setScores?: SetScore[];    // from boardLog when available
    setsA?: number; setsB?: number; // fallback from result
  };

  // Build an inline SVG bracket matching the reports-tab style.
  // Stages are merged (all QF matches → one column) and per-set scores shown.
  // Light theme for print.
  function buildFlightBracketSVG(
    cols: Array<{ label: string; slots: BracketSlot[] }>,
  ): string {
    if (cols.length < 2) return '';

    const COL_W = 200;
    const COL_GAP = 48;
    const NAME_MAX = 22;

    function clip(s: string): string {
      return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
    }

    // Slot height depends on number of set score lines
    function slotH(slot: BracketSlot): number {
      const lines = scoreLines(slot);
      return lines.length <= 1 ? 44 : 44 + (lines.length - 1) * 14;
    }

    function scoreLines(slot: BracketSlot): string[] {
      if (!slot.isDone) return [];
      if (slot.setScores && slot.setScores.length > 0) {
        return slot.setScores.map((s) => `${s.a}–${s.b}`);
      }
      if (slot.setsA !== undefined && slot.setsB !== undefined) {
        return [`${slot.setsA}–${slot.setsB}`];
      }
      return [];
    }

    const SLOT_PAD = 10;
    const MATCH_H = 56; // base spacing between match centres

    const maxSlots = cols[0].slots.length;
    const colCount = cols.length;
    const totalH = maxSlots * MATCH_H + (maxSlots - 1) * SLOT_PAD;
    const totalW = colCount * COL_W + (colCount - 1) * COL_GAP;

    const lines: string[] = [];
    const colX = (ci: number) => ci * (COL_W + COL_GAP);

    function slotCY(idx: number, slotCount: number): number {
      const spacing = totalH / slotCount;
      return spacing * idx + spacing / 2;
    }

    // Column stage labels
    for (let ci = 0; ci < cols.length; ci++) {
      const x = colX(ci);
      lines.push(`<text x="${x + COL_W / 2}" y="-6" text-anchor="middle" font-size="10" font-weight="700"
            font-family="sans-serif" fill="#888" letter-spacing="0.06em">${cols[ci].label.toUpperCase()}</text>`);
    }

    // Connector lines
    for (let ci = 0; ci < cols.length - 1; ci++) {
      const currCount = cols[ci].slots.length;
      const nextCount = cols[ci + 1].slots.length;
      const x1 = colX(ci) + COL_W;
      const x2 = colX(ci + 1);
      const xMid = x1 + COL_GAP / 2;
      for (let ni = 0; ni < nextCount; ni++) {
        const cy2 = slotCY(ni, nextCount);
        const srcA = ni * 2;
        const srcB = ni * 2 + 1;
        if (srcA < currCount) {
          const cy1 = slotCY(srcA, currCount);
          lines.push(`<line x1="${x1}" y1="${cy1}" x2="${xMid}" y2="${cy1}" stroke="#bbb" stroke-width="1.25"/>`);
          lines.push(`<line x1="${xMid}" y1="${cy1}" x2="${xMid}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
        }
        if (srcB < currCount) {
          const cy1 = slotCY(srcB, currCount);
          lines.push(`<line x1="${x1}" y1="${cy1}" x2="${xMid}" y2="${cy1}" stroke="#bbb" stroke-width="1.25"/>`);
          lines.push(`<line x1="${xMid}" y1="${cy1}" x2="${xMid}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
        }
        lines.push(`<line x1="${xMid}" y1="${cy2}" x2="${x2}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
      }
    }

    // Match slots
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      const x = colX(ci);

      for (let mi = 0; mi < col.slots.length; mi++) {
        const slot = col.slots[mi];
        const cy = slotCY(mi, col.slots.length);
        const sh = slotH(slot);
        const sy = cy - sh / 2;

        const aName = clip(resolvedName(slot.aId, slot.aName));
        const bName = clip(resolvedName(slot.bId, slot.bName));
        const aIsWinner = slot.isDone && slot.winner === 'a';
        const bIsWinner = slot.isDone && slot.winner === 'b';

        const aFill = aIsWinner ? '#000' : '#333';
        const bFill = bIsWinner ? '#000' : '#333';
        const aWeight = aIsWinner ? '700' : '400';
        const bWeight = bIsWinner ? '700' : '400';
        const aOpacity = slot.isDone && !aIsWinner ? '0.38' : '1';
        const bOpacity = slot.isDone && !bIsWinner ? '0.38' : '1';

        lines.push(`
          <rect x="${x}" y="${sy}" width="${COL_W}" height="${sh}" rx="5"
                fill="#fff" stroke="#d4d4d4" stroke-width="1"/>
          <line x1="${x + 1}" y1="${sy + sh / 2}" x2="${x + COL_W - 1}" y2="${sy + sh / 2}"
                stroke="#ebebeb" stroke-width="0.75"/>
          <text x="${x + 10}" y="${sy + 16}" font-size="12" font-weight="${aWeight}"
                opacity="${aOpacity}" font-family="sans-serif" fill="${aFill}">${aName || 'TBD'}</text>
          <text x="${x + 10}" y="${sy + sh - 7}" font-size="12" font-weight="${bWeight}"
                opacity="${bOpacity}" font-family="sans-serif" fill="${bFill}">${bName || 'TBD'}</text>
        `);

        // Score pill — per set or set counts
        const sLines = scoreLines(slot);
        if (sLines.length > 0) {
          const pillW = 38;
          const pillH = sLines.length === 1 ? 17 : sLines.length * 14 + 4;
          const px = x + COL_W - pillW - 4;
          const py = cy - pillH / 2;
          lines.push(`<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="${Math.min(8, pillH / 2)}" fill="#f5f5f5" stroke="#e0e0e0" stroke-width="0.75"/>`);
          sLines.forEach((sl, si) => {
            const ty = py + (sLines.length === 1 ? 12 : 12 + si * 14);
            lines.push(`<text x="${px + pillW / 2}" y="${ty}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#444" font-weight="600">${sl}</text>`);
          });
        }
      }
    }

    const svgH = Math.max(totalH, 120);
    const svgPadT = 20;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -${svgPadT} ${totalW + 16} ${svgH + svgPadT + 8}"
      width="${totalW + 16}" height="${svgH + svgPadT + 8}" style="max-width:100%;height:auto;display:block">
      <rect x="-8" y="-${svgPadT}" width="${totalW + 16}" height="${svgH + svgPadT + 8}" fill="#fff"/>
      ${lines.join('\n')}
    </svg>`;
  }

  // Group bracket rounds by flight prefix ("Gold League", "Silver League", etc.)
  // If no " — " prefix, all rounds go into one unnamed flight.
  type BracketFlight = { name: string; rounds: ScheduleRound[] };
  // History-based bracket flights — built from /matches records grouped by roundKey.
  // Deduplicates same-stage rounds and uses boardLog for per-set scores.
  type HistoryBracketFlight = { name: string; cols: Array<{ label: string; slots: BracketSlot[] }> };

  const STAGE_ORDER = ['Rounds', 'Quarter Finals', 'Semi Finals', 'Finals'];

  const historyBracketFlights = $derived.by<HistoryBracketFlight[]>(() => {
    void playerTick;
    void tournamentTick; // for schedule dependency
    if (historyMatches.length === 0) return [];

    const setScoresMap = buildSetScoresMap(historyMatches);

    // Group history matches by flight name (prefix before " — ") + roundKey
    type RoundGroup = { label: string; slots: BracketSlot[] };
    const flightMap = new Map<string, Map<string, RoundGroup>>();

    for (const rec of historyMatches) {
      const round = rec.round ?? rec.roundKey ?? '';
      if (!BRACKET_ROUND_RX.test(round)) continue;

      const sep = round.indexOf(' — ');
      const flightName = sep !== -1 ? round.slice(0, sep) : '';
      const stageLbl = stageLabel(round);

      if (!flightMap.has(flightName)) flightMap.set(flightName, new Map());
      const stageMap = flightMap.get(flightName)!;
      if (!stageMap.has(stageLbl)) stageMap.set(stageLbl, { label: stageLbl, slots: [] });

      const slot: BracketSlot = {
        aId: rec.playerAId,
        aName: rec.aName ?? '',
        bId: rec.playerBId,
        bName: rec.bName ?? '',
        isDone: !!(rec.result?.winner),
        winner: rec.result?.winner === 'a' ? 'a' : rec.result?.winner === 'b' ? 'b' : undefined,
        setScores: setScoresMap.get(rec.id),
        setsA: rec.result?.setsA,
        setsB: rec.result?.setsB,
      };
      stageMap.get(stageLbl)!.slots.push(slot);
    }

    // Build a flight → min round order map from schedule (already sorted by order)
    // so flights render in the same sequence as the Reports tab.
    const flightMinOrder = new Map<string, number>();
    for (const sr of schedule) {
      const sep = sr.roundName.indexOf(' — ');
      const fn = sep !== -1 ? sr.roundName.slice(0, sep) : '';
      if (!flightMinOrder.has(fn) || sr.order < flightMinOrder.get(fn)!) {
        flightMinOrder.set(fn, sr.order);
      }
    }

    const result: HistoryBracketFlight[] = [];
    for (const [flightName, stageMap] of flightMap) {
      // Sort stages by STAGE_ORDER
      const sortedStages = [...stageMap.values()].sort((a, b) => {
        const ai = STAGE_ORDER.indexOf(a.label);
        const bi = STAGE_ORDER.indexOf(b.label);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      if (sortedStages.length < 2) continue;
      result.push({ name: flightName, cols: sortedStages });
    }
    // Sort by round order from tournament config (matches Reports tab order).
    // Fall back to alphabetical if order info isn't available.
    result.sort((a, b) => {
      const oa = flightMinOrder.get(a.name) ?? 999;
      const ob = flightMinOrder.get(b.name) ?? 999;
      return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
    });
    return result;
  });

  // Fallback: /planned-based bracket flights (used when no history data yet)
  const plannedBracketFlights = $derived.by<BracketFlight[]>(() => {
    void tournamentTick;
    const map = new Map<string, ScheduleRound[]>();
    for (const r of bracketRounds) {
      const sep = r.roundName.indexOf(' — ');
      const key = sep !== -1 ? r.roundName.slice(0, sep) : '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].map(([name, rounds]) => ({ name, rounds }));
  });

  // Build planned-based BracketSlot cols (fallback when no history)
  function plannedFlightToCols(rounds: ScheduleRound[]): Array<{ label: string; slots: BracketSlot[] }> {
    const sorted = [...rounds].sort((a, b) => {
      const ai = STAGE_ORDER.indexOf(stageLabel(a.roundName));
      const bi = STAGE_ORDER.indexOf(stageLabel(b.roundName));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    const mergedMap = new Map<string, { label: string; slots: BracketSlot[] }>();
    for (const r of sorted) {
      const lbl = stageLabel(r.roundName);
      if (!mergedMap.has(lbl)) mergedMap.set(lbl, { label: lbl, slots: [] });
      for (const m of r.matches) {
        mergedMap.get(lbl)!.slots.push({
          aId: m.aResolvedId,
          aName: m.aName,
          bId: m.bResolvedId,
          bName: m.bName,
          isDone: !!m.completedAt,
          winner: m.result?.winner === 'a' ? 'a' : m.result?.winner === 'b' ? 'b' : undefined,
          setsA: m.result?.setsA,
          setsB: m.result?.setsB,
        });
      }
    }
    return [...mergedMap.values()];
  }

  // Per-flight bracket SVGs — keyed by flight name. Uses history data when available.
  const flightBracketSVGs = $derived.by<Map<string, string>>(() => {
    void tournamentTick;
    void playerTick;
    const out = new Map<string, string>();

    if (historyBracketFlights.length > 0) {
      // Use history data (has boardLog → per-set scores, deduped rounds)
      for (const f of historyBracketFlights) {
        const svg = buildFlightBracketSVG(f.cols);
        if (svg) out.set(f.name, svg);
      }
    } else {
      // Fallback to /planned data (no boardLog, set counts only)
      for (const f of plannedBracketFlights) {
        const cols = plannedFlightToCols(f.rounds);
        const svg = buildFlightBracketSVG(cols);
        if (svg) out.set(f.name, svg);
      }
    }
    return out;
  });

  // Active flights list — used by the template to decide what to render
  const activeBracketFlights = $derived.by<Array<{ name: string }>>(() => {
    if (historyBracketFlights.length > 0) {
      return historyBracketFlights.map((f) => ({ name: f.name }));
    }
    return plannedBracketFlights.map((f) => ({ name: f.name }));
  });

  const bracketSVG = $derived.by<string>(() => {
    void tournamentTick;
    void playerTick;
    // Legacy: single flight — render one SVG
    if (activeBracketFlights.length <= 1) {
      return flightBracketSVGs.get(activeBracketFlights[0]?.name ?? '') ?? '';
    }
    return '';
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
  {:else if boards.length === 0 && bracketRounds.length === 0}
    <p class="hint">
      Matches exist but none have a board number assigned.<br>
      If this is a League tournament, open <strong>League Setup → Re-draw groups</strong>
      to regenerate the schedule with board numbers, then come back and print.
    </p>
  {:else}
    <div class="print-actions no-print">
      <div class="print-toolbar">
        {#if boards.length > 0}
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
        {/if}
        <button type="button" class="print-btn" onclick={() => window.print()}>🖨 Print</button>
      </div>
      {#if boards.length > 0}
        <p class="hint">
          {#if qrMode === 'board'}
            Board stickers — permanent QR per board, same every round. Cut out and stick to each physical board.
          {:else}
            Match cards — one QR per match. Cut out and place at the board for that match.
          {/if}
        </p>
      {/if}
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
        {#if timerLine}
        <div class="meta-row">
          <span class="meta-label">Timer</span>
          <span class="meta-value">{timerLine}</span>
        </div>
        {/if}
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

      {#if mergedSchedule.length > 0}
        <h2 class="cover-section" style="margin-top:1.4rem">
          Schedule ({matchCount} {matchCount === 1 ? 'match' : 'matches'})
        </h2>
        {#each mergedSchedule as round, ri (round.key)}
          <div class="sched-round">
            <p class="sched-round-name">{round.displayName}</p>
            <table class="sched-table">
              <thead>
                <tr>
                  <th class="sched-th-board">{qrMode === 'match' ? 'Match' : 'Board'}</th>
                  <th class="sched-th-match">Match</th>
                </tr>
              </thead>
              <tbody>
                {#each round.matches as m, mi (m.mid)}
                  {@const matchNum = mergedSchedule.slice(0, ri).reduce((acc, r) => acc + r.matches.length, 0) + mi + 1}
                  <tr>
                    <td class="sched-board">{qrMode === 'match' ? `M${matchNum}` : (m.board ? `B${m.board}` : '—')}</td>
                    <td class="sched-matchup">
                      <span class="sched-player">{resolvedName(m.aResolvedId, m.aName)}{#if m.a2Name} + {resolvedName(m.a2ResolvedId, m.a2Name)}{/if}</span>
                      <span class="sched-vs">vs</span>
                      <span class="sched-player">{resolvedName(m.bResolvedId, m.bName)}{#if m.b2Name} + {resolvedName(m.b2ResolvedId, m.b2Name)}{/if}</span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      {/if}

      {#if printOrganizerName || printLogoUrl}
        <div class="page-footer">
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
          {/if}
          {#if printOrganizerName}
            <span class="page-footer-org">Organised by {printOrganizerName}</span>
          {/if}
        </div>
      {/if}
    </section>

    {#if flightBracketSVGs.size >= 1}
      <!-- ─── BRACKET PAGE(S) ─────────────────────────────────────────
           Single flight: one page with the bracket tree.
           Multi-flight (league): one bracket section per flight on
           one shared page, each with its own header and SVG. -->
      {#if activeBracketFlights.length <= 1}
        {#if bracketSVG}
          <section class="page bracket-page">
            <div class="bracket-hdr">
              <p class="brand">Carromscore</p>
              <h2 class="bracket-title">{tournamentName} — Draw</h2>
            </div>
            <div class="bracket-svg-wrap">
              {@html bracketSVG}
            </div>
            <p class="bracket-footer">Generated by Carromscore · carromscore.app</p>
          </section>
        {/if}
      {:else}
        {#each activeBracketFlights as flight (flight.name)}
          {@const flightSVG = flightBracketSVGs.get(flight.name) ?? ''}
          {#if flightSVG}
            <section class="page bracket-page">
              <div class="bracket-hdr">
                <p class="brand">Carromscore</p>
                <h2 class="bracket-title">{tournamentName} — {flight.name || 'Draw'}</h2>
              </div>
              <div class="bracket-svg-wrap">
                {@html flightSVG}
              </div>
              <p class="bracket-footer">Generated by Carromscore · carromscore.app</p>
            </section>
          {/if}
        {/each}
      {/if}
    {/if}

    {#if boards.length > 0}
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
        {#if printOrganizerName || printLogoUrl}
          <div class="page-footer">
            {#if printLogoUrl}
              <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
            {/if}
            {#if printOrganizerName}
              <span class="page-footer-org">Organised by {printOrganizerName}</span>
            {/if}
          </div>
        {/if}
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
                  <span class="mqr-side">{resolvedName(m.aResolvedId, m.aName)}{#if m.a2Name}<br/><span class="mqr-partner">{resolvedName(m.a2ResolvedId, m.a2Name)}</span>{/if}</span>
                  <span class="mqr-vs">vs</span>
                  <span class="mqr-side">{resolvedName(m.bResolvedId, m.bName)}{#if m.b2Name}<br/><span class="mqr-partner">{resolvedName(m.b2ResolvedId, m.b2Name)}</span>{/if}</span>
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
          {#if printOrganizerName || printLogoUrl}
            <div class="page-footer">
              {#if printLogoUrl}
                <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
              {/if}
              {#if printOrganizerName}
                <span class="page-footer-org">Organised by {printOrganizerName}</span>
              {/if}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
    {/if}
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

  /* ─── Per-page footer (logo + "Organised by") ───────────────── */
  /* Sits at the bottom of every .page via margin-top: auto in a
     flex-column page. Hidden on screen (content-only pages look
     fine without it); shown only in print. */
  .page-footer {
    display: none;
  }

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

  @media print {
    :global(body) { background: #fff; margin: 0; padding: 0; }
    .no-print { display: none !important; }
    .print-wrap { padding: 0; margin: 0; max-width: none; }
    .page {
      border: none;
      margin: 0;
      padding: 1.2cm 1.4cm;
      min-height: 0;
      /* flex-column already set on .cover; add it to QR pages too
         so margin-top:auto on .page-footer pushes it to the bottom */
      display: flex;
      flex-direction: column;
    }
    /* Roster column count survives print — keep it at 2. */
    .page-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: auto;
      padding-top: 0.3cm;
      border-top: 1px solid #ddd;
    }
    .page-footer-logo {
      max-height: 1.4rem;
      max-width: 3rem;
      object-fit: contain;
    }
    .page-footer-org {
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

  /* ── Bracket page ─────────────────────────────────────── */
  .bracket-page {
    color-scheme: light;
    background: #fff;
    color: #000;
  }
  .bracket-hdr {
    margin-bottom: 1.25rem;
    border-bottom: 2px solid #e0e0e0;
    padding-bottom: 0.75rem;
  }
  .bracket-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0.15rem 0 0.5rem;
    line-height: 1.2;
  }
  .bracket-round-labels {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .bracket-round-label {
    background: #f0f0f0;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.78rem;
    padding: 0.15rem 0.55rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #444;
  }
  .bracket-svg-wrap {
    overflow-x: auto;
    padding: 0.5rem 0 1rem;
  }
  .bracket-footer {
    font-size: 0.72rem;
    color: #aaa;
    text-align: center;
    margin-top: 1rem;
    border-top: 1px solid #eee;
    padding-top: 0.6rem;
  }
  @media print {
    .bracket-page {
      page-break-before: always;
    }
    .bracket-svg-wrap {
      overflow: visible;
    }
  }
</style>
