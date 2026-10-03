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
  import { getDatabase, ref, get } from 'firebase/database';
  import { firebaseApp } from '../../lib/firebase';
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
  import { BRACKET_ROUND_RX, POSITIONAL_ROUND_RX } from '../../lib/bracket';
  import { koRoundsFromMatches, KO_BRACKET_ROUND_RX } from '../../lib/bracketSvg';

  let tournamentKey = $state<string>('');
  let plannedMatches = $state<PlannedMatch[]>([]);
  let historyMatches = $state<MatchRecord[]>([]);
  let unsub: (() => void) | null = null;
  let unsubMatches: (() => void) | null = null;
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
    else if (params.get('qrMode') === 'board') qrMode = 'board';
    // Always write the resolved mode to the URL so it's visible and shareable
    if (!params.has('qrMode')) {
      const url = new URL(window.location.href);
      url.searchParams.set('qrMode', qrMode);
      window.history.replaceState(null, '', url.toString());
    }
    if (!tournamentKey) {
      plannedReady = true;
      playersReady = true;
      historyReady = true;
      return () => {};
    }
    void subscribeTournaments();
    void subscribePlayers();
    // Eagerly load organiser profile — fetch createdBy and profile immediately
    // using static Firebase imports (no dynamic import delay).
    void (async () => {
      try {
        const db = getDatabase(firebaseApp());
        const tSnap = await get(ref(db, `tournaments/${tournamentKey}/createdBy`));
        const uid = tSnap.val() as string | null;
        if (uid) await loadOrgProfile(uid);
      } catch { /* non-fatal */ }
    })();
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

        // Live subscription for match results — scores update as matches complete.
        const { onValue: onVal, query: q2, orderByChild: obc2, equalTo: eq2 } = await import('firebase/database');
        const matchesQ = q2(ref(db, 'matches'), obc2('tournamentKey'), eq2(tournamentKey));
        const unsubFn = onVal(matchesQ, (snap) => {
          const raw = snap.val() as Record<string, Omit<MatchRecord, 'id'>> | null;
          const out: MatchRecord[] = [];
          if (raw) {
            for (const [id, v] of Object.entries(raw)) {
              if (!v || typeof v !== 'object') continue;
              out.push({ id, ...v } as MatchRecord);
            }
          }
          historyMatches = out;
        });
        unsubMatches = () => unsubFn();
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
      unsubMatches?.();
      unsubT();
      unsubP();
      window.clearTimeout(timeoutId);
    };
  });

  // Organiser profile loaded from /organiserProfiles/{createdBy}.
  // Optional — print works fine without it; logo/organizer just won't show.
  type OrgProfile = { displayName?: string; orgName?: string; logoUrl?: string };
  let orgProfile = $state<OrgProfile | null>(null);
  // Co-org profiles: uid → profile. Loaded once when tournament has coOrganisers.
  // Plain object (not Map) so Svelte's $state proxy tracks field additions reactively.
  let coOrgProfiles = $state<Record<string, OrgProfile>>({});
  // Track which co-org profile fetches have been attempted (avoid re-fetching).
  const coOrgFetchAttempted = new Set<string>();

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

  // Load organiser profile — kicked off as early as possible (in onMount via
  // loadOrgProfile) so the logo is ready before the user hits Print.
  async function loadOrgProfile(uid: string) {
    try {
      const db = getDatabase(firebaseApp());
      const snap = await get(ref(db, `organiserProfiles/${uid}`));
      orgProfile = snap.exists() ? (snap.val() as OrgProfile) : null;
    } catch {
      orgProfile = null;
    }
  }
  async function loadCoOrgProfile(uid: string) {
    if (coOrgFetchAttempted.has(uid)) return;
    coOrgFetchAttempted.add(uid);
    try {
      const db = getDatabase(firebaseApp());
      const snap = await get(ref(db, `organiserProfiles/${uid}`));
      if (snap.exists()) {
        coOrgProfiles = { ...coOrgProfiles, [uid]: snap.val() as OrgProfile };
      }
      // If no organiserProfile, the name comes from tournament.coOrgNames (public, already loaded).
    } catch {
      // Silently ignore — name falls back to coOrgNames from tournament record.
    }
  }
  // Re-run profile load whenever the primary organiser UID changes.
  $effect(() => {
    const uid = tournament?.primaryOrganizerUid ?? tournament?.createdBy;
    if (uid) void loadOrgProfile(uid);
  });
  // Kick off co-org profile fetches for logo URLs when tournament loads
  // (needed so we can fall back to a co-org logo if that co-org is primary).
  $effect(() => {
    const coOrgs = tournament?.coOrganisers;
    if (!coOrgs) return;
    for (const uid of Object.keys(coOrgs)) {
      void loadCoOrgProfile(uid);
    }
  });

  // Logo options list: one entry per organiser that could supply a logo.
  // Rebuilds whenever orgProfile, coOrgProfiles, or tournament changes.
  type LogoOption = { uid: string; label: string; logoUrl: string | null };

  function buildLogoOptions(
    t: typeof tournament,
    op: typeof orgProfile,
    cop: typeof coOrgProfiles,
  ): LogoOption[] {
    if (!t) return [];
    const options: LogoOption[] = [];
    const creatorLabel = op?.orgName || op?.displayName || t.organizerName || 'Organiser';
    options.push({ uid: t.createdBy ?? '', label: creatorLabel, logoUrl: op?.logoUrl ?? t.logoUrl ?? null });
    for (const uid of Object.keys(t.coOrganisers ?? {})) {
      const p = cop[uid];
      const label = p?.orgName || p?.displayName || t.coOrgNames?.[uid] || uid.slice(0, 8) + '…';
      options.push({ uid, label, logoUrl: p?.logoUrl ?? null });
    }
    return options;
  }

  // Reactive logo options — reads all three state values so it re-runs on any change.
  let logoOptions = $state<LogoOption[]>([]);
  $effect(() => {
    logoOptions = buildLogoOptions(tournament, orgProfile, coOrgProfiles);
  });

  // Active logo option — driven by primaryOrganizerUid from the tournament record.
  const activeLogoOption = $derived.by<LogoOption | null>(() => {
    if (logoOptions.length === 0) return null;
    const primaryUid = tournament?.primaryOrganizerUid;
    if (primaryUid) {
      const found = logoOptions.find((o) => o.uid === primaryUid);
      if (found) return found;
    }
    return logoOptions[0] ?? null;
  });

  // Derived print values — driven by the primary organiser.
  const printLogoUrl = $derived(activeLogoOption?.logoUrl ?? tournament?.logoUrl ?? null);
  const printOrganizerName = $derived(
    activeLogoOption?.label !== 'Organiser' ? (activeLogoOption?.label ?? null) :
    (orgProfile?.orgName || orgProfile?.displayName || tournament?.organizerName || null)
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
  type RosterRow = { name: string; country?: string; represents?: string };
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
          ...(p.represents ? { represents: p.represents } : {}),
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
            ...(p?.represents ? { represents: p.represents } : {}),
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
    // Derive from assigned board numbers on planned matches
    let max = 0;
    for (const m of plannedMatches) {
      if (m.board && m.board >= 1 && m.board <= 99 && m.board > max) {
        max = m.board;
      }
    }
    // Always also check venueBoards/maxBoards from tournament config — take the
    // larger of the two so all physical boards get stickers even when only some
    // rounds have been created (e.g. 32 venue boards but only 6 matches created so far).
    const venue = tournament?.knockoutCfg?.venueBoards
      ?? tournament?.knockoutCfg?.boardsAvailable
      ?? tournament?.defaults?.maxBoards
      ?? 0;
    max = Math.min(Math.max(max, Math.max(0, venue)), 99);
    if (max === 0) return [];
    const out: number[] = [];
    for (let i = 1; i <= max; i += 1) out.push(i);
    return out;
  });

  // Manual overrides for organizer name/logo — typed directly in the toolbar.
  // Take priority over the Firebase-loaded profile values.

  // QR mode: 'board' = one permanent sticker per physical board (default),
  //          'match' = one QR per planned match showing who plays who.
  let qrMode = $state<'board' | 'match'>('board');

  // QR SVG cache — keyed by board number (board mode) or mid (match mode).
  let qrByBoard = $state<Record<number, string>>({});
  let qrByMid = $state<Record<string, string>>({});
  // Plain (non-reactive) Sets tracking which QRs have already been kicked off —
  // avoids reading qrByMid/qrByBoard inside the $effect, which would make the
  // effect re-run every time a QR resolves and cause a reactive loop in Svelte 5.
  const qrBoardStarted = new Set<number>();
  const qrMidStarted = new Set<string>();
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
    // Board QRs — batch-generate new boards, write all at once to avoid spread races.
    const newBoards = boards.filter((b) => !qrBoardStarted.has(b));
    if (newBoards.length > 0) {
      for (const b of newBoards) qrBoardStarted.add(b);
      void Promise.all(
        newBoards.map((b) =>
          qrToSVG(`${scanBase}?tournament=${encodeURIComponent(tournamentKey)}&board=${b}`, 400)
            .then((svg): [number, string] => [b, svg])
        )
      ).then((pairs) => {
        const next = { ...qrByBoard };
        for (const [b, svg] of pairs) next[b] = svg;
        qrByBoard = next;
      }).catch((err) => { console.error('[PrintBracket] Board QR generation failed:', err); });
    }
    // Match QRs — generate all in parallel, batch-write on completion.
    const toGenerate = plannedMatches.filter((m) => !qrMidStarted.has(m.mid));
    if (toGenerate.length === 0) return;
    for (const m of toGenerate) qrMidStarted.add(m.mid);
    void Promise.all(
      toGenerate.map((m) =>
        qrToSVG(`${scanBase}?planned=${encodeURIComponent(m.mid)}`, 280)
          .then((svg): [string, string] => [m.mid, svg])
      )
    ).then((pairs) => {
      const next = { ...qrByMid };
      for (const [mid, svg] of pairs) next[mid] = svg;
      qrByMid = next;
    }).catch((err) => { console.error('[PrintBracket] QR generation failed:', err); });
  });

  function fmtCfg(d: { mode?: string; bestOf?: number; pointsTarget?: number; maxBoards?: number; timerDuration?: number }, showMode = true): string {
    const mode = d.mode === 'doubles' ? 'Doubles' : 'Singles';
    const bo = d.bestOf ?? 3;
    const pts = d.pointsTarget ?? 25;
    const mb = d.maxBoards ?? 8;
    const mbTxt = mb === 0 ? 'unlimited boards' : `max ${mb} boards`;
    const timer = (d.timerDuration ?? 0) > 0 ? ` · ${d.timerDuration} min` : '';
    return `${showMode ? mode + ' · ' : ''}Best of ${bo} · target ${pts} pts · ${mbTxt}${timer}`;
  }

  // Human-readable config line for the cover page.
  const configLine = $derived.by<string>(() => fmtCfg(tournament?.defaults ?? {}));

  const timerLine = $derived<string | null>(
    (tournament?.defaults?.timerDuration ?? 0) > 0
      ? `${tournament!.defaults!.timerDuration} min`
      : null
  );

  // Per-flight config rows for league tournaments (QF/SF/Final may differ).
  type FlightCfgRow = { flight: string; cfg: string };
  const flightCfgRows = $derived.by<FlightCfgRow[]>(() => {
    const lc = tournament?.leagueCfg;
    if (!lc?.flightCfg) return [];
    const defaults = tournament?.defaults ?? {};
    const rows: FlightCfgRow[] = [];
    for (const [flight, fc] of Object.entries(lc.flightCfg)) {
      const merged = { ...defaults, ...fc };
      rows.push({ flight, cfg: fmtCfg(merged, false) });
    }
    return rows;
  });

  const tournamentName = $derived<string>(
    tournament?.name ?? plannedMatches[0]?.tournament ?? tournamentKey,
  );

  // Match count for the cover — reads directly from the /planned
  // subscription so it reflects every round.
  const matchCount = $derived<number>(plannedMatches.length);

  // Resolved display names for planned slots whose aName/bName is a
  // placeholder like "G1 Winner 3". Maps mid → { aName, bName }.
  // Used by QR cards so they show real player names instead of placeholders.
  const resolvedPlannedNames = $derived.by<Map<string, { aName: string; bName: string }>>(() => {
    const map = new Map<string, { aName: string; bName: string }>();
    if (!plannedMatches.length) return map;
    // Build: roundName → matchOrder → winner name, from history + planned results
    const winnerByRound = new Map<string, Map<number, string>>();
    const addWinner = (roundName: string, order: number, name: string) => {
      if (!winnerByRound.has(roundName)) winnerByRound.set(roundName, new Map());
      if (!winnerByRound.get(roundName)!.has(order)) winnerByRound.get(roundName)!.set(order, name);
    };
    // From planned records with completedAt
    for (const p of plannedMatches) {
      if (!p.completedAt || !p.result || p.matchOrder == null || !p.round) continue;
      const w = p.result.winner;
      if (w === 'a' && p.aName) addWinner(p.round, p.matchOrder, p.aName);
      else if (w === 'b' && p.bName) addWinner(p.round, p.matchOrder, p.bName);
    }
    // From history matches (no QR scan — no completedAt on planned)
    for (const h of historyMatches) {
      const roundName = h.round ?? '';
      if (!roundName) continue;
      const planned = plannedMatches.find((p) => {
        if (p.round !== roundName || p.matchOrder == null) return false;
        const pA = (p.aName ?? '').trim().toLowerCase();
        const pB = (p.bName ?? '').trim().toLowerCase();
        const hA = (h.aName ?? '').trim().toLowerCase();
        const hB = (h.bName ?? '').trim().toLowerCase();
        return (pA === hA && pB === hB) || (pA === hB && pB === hA);
      });
      if (!planned) continue;
      const swapped = (h.aName ?? '').trim().toLowerCase() === (planned.bName ?? '').trim().toLowerCase();
      const w = h.result?.winner;
      const ew = swapped ? (w === 'a' ? 'b' : w === 'b' ? 'a' : w) : w;
      if (ew === 'a' && planned.aName) addWinner(roundName, planned.matchOrder!, planned.aName);
      else if (ew === 'b' && planned.bName) addWinner(roundName, planned.matchOrder!, planned.bName);
    }
    // Resolve placeholder names using tournament round order
    void tournamentTick;
    const t = tournament;
    const tRounds = t?.rounds ?? [];
    for (const m of plannedMatches) {
      const aRx = (m.aName ?? '').match(/^(.+)\s+(?:Winner|Finalist)\s+(\d+)$/i);
      const bRx = (m.bName ?? '').match(/^(.+)\s+(?:Winner|Finalist)\s+(\d+)$/i);
      if (!aRx && !bRx) continue;
      const currentRound = m.round ?? '';
      const currentIdx = tRounds.findIndex((r) => r.name === currentRound);
      if (currentIdx <= 0) continue;
      const prevRoundName = tRounds[currentIdx - 1]!.name;
      const prevWinners = winnerByRound.get(prevRoundName);
      if (!prevWinners) continue;
      const resolvedA = aRx ? (prevWinners.get(parseInt(aRx[2]!, 10)) ?? m.aName ?? '') : (m.aName ?? '');
      const resolvedB = bRx ? (prevWinners.get(parseInt(bRx[2]!, 10)) ?? m.bName ?? '') : (m.bName ?? '');
      if (resolvedA !== m.aName || resolvedB !== m.bName) {
        map.set(m.mid, { aName: resolvedA, bName: resolvedB });
      }
    }
    return map;
  });

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
      const isPositional = POSITIONAL_ROUND_RX.test(sr.roundName);
      const isBracket = !isPositional && BRACKET_ROUND_RX.test(sr.roundName);
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
        // Group / non-bracket round — normalise display names
        const sfx = sr.roundName.replace(/^.*?—\s*/, '').trim();
        const positionalDisplayMap: Record<string, string> = {
          '3rd': '3rd Place', 'L-SF': '5th-8th Semi', 'L-Final': '5th Place', 'L-3rd': '7th Place',
        };
        const sep = sr.roundName.indexOf(' — ');
        const flight = sep !== -1 ? sr.roundName.slice(0, sep) : '';
        const remapped = positionalDisplayMap[sfx];
        const displayName = sr.roundName === 'Group RR' ? 'Round Robin Group'
          : remapped ? (flight ? `${flight} — ${remapped}` : remapped)
          : sr.roundName;
        out.set(sr.roundKey, { key: sr.roundKey, displayName, matches: sr.matches, order: sr.order });
      }
    }
    // For group-phase rounds (e.g. "G1 — Pre-qualify", "G3 — Rounds", "G2 — QF"),
    // sort by stage first (Pre-qualify < Rounds < QF < SF < Final) then by group name,
    // so all Pre-qualify rounds print together, then all Rounds, etc.
    const stagePriority = (name: string): number => {
      const s = name.replace(/^.*?—\s*/, '').toLowerCase();
      if (s.includes('pre-qualify') || s.includes('pre qualify')) return 0;
      if (s.includes('round') && !s.includes('final')) return 1;
      if (s.includes('r16') || s.includes('r32') || s.includes('r64') || s.includes('r128')) return 1;
      if (s.includes('qf') || s.includes('quarter')) return 2;
      // SF/Semi only — must not match l-sf
      if ((s === 'sf' || s === 'semi finals' || s.startsWith('semi')) && !s.startsWith('l-')) return 3;
      if (s === 'final' || s === 'finals') return 4;
      // Positional rounds sort after Final (both old and new names)
      if (s === '3rd place' || s === '3rd') return 5;
      if (s.includes('5th-8th') || s === 'l-sf' || s === '5th-8th semi') return 6;
      if (s === '5th place' || s === 'l-final') return 7;
      if (s === '7th place' || s === 'l-3rd') return 8;
      return 9;
    };
    const isGroupRound = (name: string) => / — /.test(name) && !/^KO —/.test(name);
    return [...out.values()].sort((a, b) => {
      const ag = isGroupRound(a.displayName);
      const bg = isGroupRound(b.displayName);
      if (ag && bg) {
        const sp = stagePriority(a.displayName) - stagePriority(b.displayName);
        if (sp !== 0) return sp;
        return a.displayName.localeCompare(b.displayName, undefined, { numeric: true });
      }
      return a.order - b.order;
    });
  });

  // Canonical stage label shared by SVG builder and template header chips
  function stageLabel(name: string): string {
    const n = name.replace(/^.*?—\s*/, '');
    if (n.includes('Final') && !n.includes('SF')) return 'Finals';
    if (n.includes('SF')) return 'Semi Finals';
    if (n.includes('QF')) return 'Quarter Finals';
    if (n.includes('R16') || n.toLowerCase().includes('round of 16')) return 'Rounds';
    if (/^R\d+$/.test(n)) return 'Rounds';
    return n;
  }

  // Build per-board scores map from match history boardLog.
  // Each entry is one physical board played: { set, board, a, b }.
  type BoardScore = { set: number; board: number; a: number; b: number };
  function buildBoardScoresMap(records: MatchRecord[]): Map<string, BoardScore[]> {
    const m = new Map<string, BoardScore[]>();
    for (const rec of records) {
      if (!rec?.id || !rec.boardLog?.length) continue;
      const boards: BoardScore[] = rec.boardLog
        .filter((e) => e != null)
        .map((e) => ({
          set: e.set ?? 0,
          board: e.board ?? 0,
          a: e.pointsA ?? 0,
          b: e.pointsB ?? 0,
        }))
        .sort((x, y) => x.set !== y.set ? x.set - y.set : x.board - y.board);
      if (boards.length > 0) m.set(rec.id, boards);
    }
    return m;
  }

  // Match slot type used by the SVG builder (works with both history and planned data).
  type BracketSlot = {
    aId?: string; aName: string;
    bId?: string; bName: string;
    isDone: boolean;
    winner?: 'a' | 'b';
    boardScores?: BoardScore[];  // per-board scores from boardLog
    setsA?: number; setsB?: number;
    pointsA?: number; pointsB?: number; // total match points fallback
  };

  // History entry type used by the name-based match lookup below.
  type HistMatchEntry = {
    aName: string; bName: string;
    winner?: 'a' | 'b' | 'draw';
    setsA?: number; setsB?: number;
    finalPointsA?: number; finalPointsB?: number;
  };

  // Build a round → history-entry map, keyed by normalised player names so
  // matches played without a board QR scan (no completedAt on /planned) still
  // get scores and winner. Used by every planned-based bracket builder.
  function buildHistByRound(
    matches: MatchRecord[],
    roundFilter: (r: string) => boolean,
  ): Map<string, HistMatchEntry[]> {
    const map = new Map<string, HistMatchEntry[]>();
    for (const rec of matches) {
      const r = rec.round ?? '';
      if (!r || !roundFilter(r)) continue;
      const arr = map.get(r) ?? [];
      arr.push({
        aName: (rec.aName ?? '').trim().toLowerCase(),
        bName: (rec.bName ?? '').trim().toLowerCase(),
        winner: rec.result?.winner ?? undefined,
        setsA: rec.result?.setsA,
        setsB: rec.result?.setsB,
        finalPointsA: rec.result?.finalPointsA,
        finalPointsB: rec.result?.finalPointsB,
      });
      map.set(r, arr);
    }
    return map;
  }

  // Look up the history entry for a planned match: exact name match first,
  // swapped-sides fallback, then position index.
  function findHistEntry(
    map: Map<string, HistMatchEntry[]>,
    round: string,
    aName: string,
    bName: string,
    fallbackIdx: number,
  ): HistMatchEntry | undefined {
    const bucket = map.get(round);
    if (!bucket) return undefined;
    const an = aName.trim().toLowerCase();
    const bn = bName.trim().toLowerCase();
    return bucket.find((h) => h.aName === an && h.bName === bn)
      ?? bucket.find((h) => h.aName === bn && h.bName === an)
      ?? bucket[fallbackIdx];
  }

  // Build an inline SVG bracket matching the reports-tab style.
  // Stages are merged (all QF matches → one column) and per-set scores shown.
  // Light theme for print.
  function buildFlightBracketSVG(
    cols: Array<{ label: string; slots: BracketSlot[] }>,
    allowSingleCol = false,
  ): string {
    if (cols.length < 1) return '';
    if (cols.length < 2 && !allowSingleCol) return '';

    const COL_W = 240;
    const COL_GAP = 48;
    const NAME_MAX = 22;

    function esc(s: string): string {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function clip(s: string): string {
      return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
    }

    // Slot height is fixed — score always fits on one line (single-set = boards, multi-set = count)
    function slotH(_slot: BracketSlot): number {
      return 44;
    }

    // Score display logic:
    // - setsA + setsB === 1 → single set: show per-board scores (boardLog) > total points > set count
    // - setsA + setsB > 1  → multiple sets: show set count "2–1"
    function scoreLines(slot: BracketSlot): string[] {
      if (!slot.isDone) return [];
      const sA = slot.setsA ?? 0;
      const sB = slot.setsB ?? 0;
      const totalSets = sA + sB;
      if (totalSets <= 1) {
        if (slot.boardScores && slot.boardScores.length > 0 && slot.boardScores.length <= 2) {
          return [slot.boardScores.map((b) => `${b.a}–${b.b}`).join('  ')];
        }
        const pA = slot.pointsA ?? 0;
        const pB = slot.pointsB ?? 0;
        if (pA > 0 || pB > 0) return [`${pA}–${pB}`];
        return [`${sA}–${sB}`];
      }
      return [`${sA}–${sB}`];
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
            font-family="sans-serif" fill="#888" letter-spacing="0.06em">${esc(cols[ci].label.toUpperCase())}</text>`);
    }

    // Connector lines — each next-slot is fed by currCount/nextCount source slots.
    // Handles any ratio (2→1, 4→1, 4→2, 3→1, etc.) rather than hard-coding pairs.
    for (let ci = 0; ci < cols.length - 1; ci++) {
      const currCount = cols[ci].slots.length;
      const nextCount = cols[ci + 1].slots.length;
      const x1 = colX(ci) + COL_W;
      const x2 = colX(ci + 1);
      const xMid = x1 + COL_GAP / 2;
      // How many sources feed each next-slot (may be fractional for uneven brackets)
      const feedRatio = currCount / nextCount;
      for (let ni = 0; ni < nextCount; ni++) {
        const cy2 = slotCY(ni, nextCount);
        // Source range: [firstSrc, lastSrc]
        const firstSrc = Math.round(ni * feedRatio);
        const lastSrc = Math.round((ni + 1) * feedRatio) - 1;
        for (let si = firstSrc; si <= lastSrc && si < currCount; si++) {
          const cy1 = slotCY(si, currCount);
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

        const aName = esc(clip(resolvedName(slot.aId, slot.aName)));
        const bName = esc(clip(resolvedName(slot.bId, slot.bName)));
        const aIsWinner = slot.isDone && slot.winner === 'a';
        const bIsWinner = slot.isDone && slot.winner === 'b';

        const aFill = aIsWinner ? '#000' : '#333';
        const bFill = bIsWinner ? '#000' : '#333';
        const aWeight = aIsWinner ? '700' : '400';
        const bWeight = bIsWinner ? '700' : '400';
        const aOpacity = slot.isDone && !aIsWinner ? '0.38' : '1';
        const bOpacity = slot.isDone && !bIsWinner ? '0.38' : '1';

        const sLines = scoreLines(slot);
        // Estimate pill width: board scores like "25–14  21–4" need ~7px/char at font-size 10
        const maxLineLen = sLines.reduce((m, l) => Math.max(m, l.length), 0);
        const pillW = Math.max(36, Math.min(maxLineLen * 6.5 + 10, COL_W - 90));

        lines.push(`
          <rect x="${x}" y="${sy}" width="${COL_W}" height="${sh}" rx="5"
                fill="#fff" stroke="#bbb" stroke-width="1"/>
          <line x1="${x + 1}" y1="${sy + sh / 2}" x2="${x + COL_W - 1}" y2="${sy + sh / 2}"
                stroke="#ebebeb" stroke-width="0.75"/>
          <text x="${x + 8}" y="${sy + 16}" font-size="11" font-weight="${aWeight}"
                opacity="${aOpacity}" font-family="sans-serif" fill="${aFill}">${aName}</text>
          <text x="${x + 8}" y="${sy + sh - 8}" font-size="11" font-weight="${bWeight}"
                opacity="${bOpacity}" font-family="sans-serif" fill="${bFill}">${bName}</text>
        `);

        if (sLines.length > 0) {
          const px = x + COL_W - pillW - 4;
          const pillH = 17;
          const py = cy - pillH / 2;
          lines.push(`<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="8" fill="#f5f5f5" stroke="#e0e0e0" stroke-width="0.75"/>`);
          lines.push(`<text x="${px + pillW / 2}" y="${py + 12}" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="#444" font-weight="600">${sLines[0]}</text>`);
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

    const setScoresMap = buildBoardScoresMap(historyMatches);

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
        boardScores: setScoresMap.get(rec.id),
        setsA: rec.result?.setsA,
        setsB: rec.result?.setsB,
        pointsA: rec.result?.finalPointsA,
        pointsB: rec.result?.finalPointsB,
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
    const allRoundNames = new Set(sorted.map((r) => r.roundName));
    // histMap is keyed by the RESOLVED names (what actually played), so we must
    // resolve placeholders first and look up history using those real names.
    const resolvedNames = resolvedPlannedNames;
    const mergedMap = new Map<string, { label: string; slots: BracketSlot[] }>();
    for (const r of sorted) {
      const lbl = stageLabel(r.roundName);
      if (!mergedMap.has(lbl)) mergedMap.set(lbl, { label: lbl, slots: [] });
      const arr = mergedMap.get(lbl)!.slots;
      // Build histMap after resolving names so history lookup uses real player names.
      const histMap = buildHistByRound(historyMatches, (rn) => allRoundNames.has(rn));
      for (const m of r.matches) {
        const resolved = resolvedNames.get(m.mid);
        const aName = resolved?.aName ?? m.aName;
        const bName = resolved?.bName ?? m.bName;
        const h = findHistEntry(histMap, r.roundName, aName, bName, arr.length);
        const isDone = !!m.completedAt || !!h;
        // When history sides are swapped vs planned sides, flip the winner.
        const hWinnerCorrected = (() => {
          if (!h) return undefined;
          const swap = h.aName === bName.trim().toLowerCase() && h.bName === aName.trim().toLowerCase();
          if (swap) return h.winner === 'a' ? 'b' : h.winner === 'b' ? 'a' : undefined;
          return h.winner === 'a' ? 'a' : h.winner === 'b' ? 'b' : undefined;
        })();
        arr.push({
          aId: m.aResolvedId,
          aName,
          bId: m.bResolvedId,
          bName,
          isDone,
          winner: m.result?.winner === 'a' ? 'a' : m.result?.winner === 'b' ? 'b'
            : hWinnerCorrected,
          setsA: m.result?.setsA ?? h?.setsA,
          setsB: m.result?.setsB ?? h?.setsB,
          pointsA: h?.finalPointsA,
          pointsB: h?.finalPointsB,
        });
      }
    }
    return [...mergedMap.values()];
  }

  // Per-flight bracket SVGs — keyed by flight name.
  // Always built from /planned (preserves bracket order + position) enriched with
  // history results. The history-direct path was removed because it ignored matchOrder,
  // causing wrong bracket positions (losers shown advancing) and missing future-round
  // slots when only early rounds had history data.
  // Skipped for standalone KO tournaments (standaloneKOBracketSVG handles those).
  const flightBracketSVGs = $derived.by<Map<string, string>>(() => {
    void tournamentTick;
    void playerTick;
    const out = new Map<string, string>();

    if (tournament?.format === 'knockout') return out;

    for (const f of plannedBracketFlights) {
      const cols = plannedFlightToCols(f.rounds);
      const svg = buildFlightBracketSVG(cols);
      if (svg) out.set(f.name, svg);
    }
    return out;
  });

  // Active flights list — used by the template to decide what to render
  const activeBracketFlights = $derived.by<Array<{ name: string }>>(() => {
    if (plannedBracketFlights.length > 0) {
      return plannedBracketFlights.map((f) => ({ name: f.name }));
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

  // Build the Group KO Phase 1 draw diagram SVG for print.
  //
  // Uses the exact same slot visual style as buildFlightBracketSVG (league brackets):
  //   - COL_W=240, SLOT_H=44, white rect rx=5, #bbb border, midline #ebebeb
  //   - Winner: bold text; loser: opacity 0.38 on text
  //   - Score pill: #f5f5f5 fill, #e0e0e0 border, centred at match midpoint
  //   - Connectors: #bbb, stroke-width 1.25
  //
  // Groups are laid out in up to 2 columns (even indices left, odd indices right).
  // SVG uses viewBox + width=100% to scale to fit any print page width.
  function buildGroupKODiagramSVG(
    groups: Array<{ name: string; players: string[]; preQualifyNames?: Set<string>; matchMap: Map<string, {isDone: boolean; winner?: 'a'|'b'; setsA?: number; setsB?: number; pointsA?: number; pointsB?: number; aName: string; bName: string}[]> }>,
  ): string {
    if (groups.length === 0) return '';

    type MatchInfo = { isDone: boolean; winner?: 'a'|'b'; setsA?: number; setsB?: number; pointsA?: number; pointsB?: number; aName: string; bName: string };

    const NAME_MAX = 22;
    function clip(s: string) { return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s; }
    function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function fmtScore(res: MatchInfo | undefined): string {
      if (!res?.isDone) return '';
      const sA = res.setsA ?? 0; const sB = res.setsB ?? 0;
      if (sA + sB <= 1) { const pA = res.pointsA ?? 0; const pB = res.pointsB ?? 0; if (pA > 0 || pB > 0) return `${pA}–${pB}`; }
      return `${sA}–${sB}`;
    }

    // ── Layout constants ──
    // Everything is built on a single ROW_H grid.
    // Each player occupies one row. Match boxes span their two input rows.
    const ROW_H  = 32;   // px per player row — drives all Y positions
    const BOX_H  = 44;   // match-box height (slightly taller than a row for padding)
    const COL_W  = 175;  // match-box width
    const COL_GAP = 36;  // horizontal gap between columns
    const NAME_W = 155;  // player name column width
    const ARM    = 28;   // gap between name col and col-0, and between columns
    const GRP_PAD = 40;
    const LBL_H  = 24;
    const PAD    = 24;

    function colLabel(key: string): string {
      const short = key.replace(/^.*?—\s*/, '');
      const MAP: Record<string,string> = { 'Pre-qualify':'PRE-QUALIFY', Final:'FINAL', SF:'SEMI FINALS', QF:'QUARTER FINALS' };
      return MAP[short] ?? (/^R\d+$/.test(short) ? 'ROUNDS' : short.toUpperCase());
    }

    // ── Per-group pre-computation ──
    // Key insight: build a flat array of "leaf rows" — one per player.
    // Each leaf has an absolute row index within the group (0, 1, 2, …).
    // The Y center of row i is: gy + i * ROW_H + ROW_H/2
    // Match-box centers are the average Y of their two input leaves (or single leaf for bye).
    // This single grid drives EVERYTHING: name positions, box positions, connector lines.

    type Leaf = { player: string; rowIdx: number };
    // A "node" at each column: spans a range of row indices [top, bot] and has a center Y.
    // center = gy + (top + bot) / 2 * ROW_H + ROW_H/2
    // For a match box: top = first input's rowIdx, bot = last input's rowIdx.

    const grpData = groups.map((g, gi) => {
      const pqSet = g.preQualifyNames ?? new Set<string>();
      const hasPQ = pqSet.size >= 2;

      // Walk players in original order — same sequence as the match seeding in groupknockout.ts.
      // Each consecutive PQ pair is kept together inline; bye players occupy their own rows.
      // This ensures SVG row order matches the actual QF match order.
      //
      // leaves: one entry per player row (in display order top→bottom)
      // pqPairLeaves: for each PQ pair, the two leaf indices [leafIdxA, leafIdxB]
      // r2Leaves: virtual row positions for each QF input slot (bye row or PQ-pair midpoint)
      type Span = { topRow: number; botRow: number };
      const leaves: Leaf[] = [];
      // pqPairs stored as [leafIdxA, leafIdxB] so we can build PQ col spans
      const pqPairLeafIndices: [number, number][] = [];
      // r2Leaves: fractional row position for each QF input (bye = its row, pqW = avg of pair rows)
      const r2Leaves: number[] = [];

      let i = 0;
      while (i < g.players.length) {
        const p = g.players[i]!;
        if (hasPQ && pqSet.has(p)) {
          // PQ pair: consume this player and the next PQ player
          const p2 = g.players[i + 1] ?? p; // guard against dangling odd PQ player
          const idxA = leaves.length;
          leaves.push({ player: p,  rowIdx: leaves.length });
          const idxB = leaves.length;
          leaves.push({ player: p2, rowIdx: leaves.length });
          pqPairLeafIndices.push([idxA, idxB]);
          // PQ winner's virtual row = midpoint of its two leaf rows
          r2Leaves.push((leaves[idxA]!.rowIdx + leaves[idxB]!.rowIdx) / 2);
          i += 2;
        } else {
          const idx = leaves.length;
          leaves.push({ player: p, rowIdx: idx });
          r2Leaves.push(idx); // bye: virtual row = its own row
          i++;
        }
      }

      const pqMatchCount = pqPairLeafIndices.length;
      const byePs = g.players.filter((p) => !pqSet.has(p));
      const totalRows = leaves.length;

      // Row center Y (relative to group top gy)
      function rowRelY(rowIdx: number) { return rowIdx * ROW_H + ROW_H / 2; }

      // Match center Y from span [topRow, botRow] (relative to gy)
      function spanRelY(topRow: number, botRow: number) {
        return (rowRelY(topRow) + rowRelY(botRow)) / 2;
      }

      const cols: Span[][] = [];

      if (hasPQ) {
        // Col 0: PQ matches — each span covers the two PQ player rows for that pair
        const pqCol: Span[] = pqPairLeafIndices.map(([idxA, idxB]) => ({
          topRow: leaves[idxA]!.rowIdx,
          botRow: leaves[idxB]!.rowIdx,
        }));
        cols.push(pqCol);
      }

      // Build halving rounds starting from r2 pairs
      let currentSlots = r2Leaves;
      while (currentSlots.length >= 1) {
        const col: Span[] = [];
        for (let i = 0; i + 1 < currentSlots.length; i += 2) {
          col.push({ topRow: currentSlots[i]!, botRow: currentSlots[i + 1]! });
        }
        if (currentSlots.length % 2 === 1) {
          // odd slot gets a bye — span just covers itself
          const last = currentSlots[currentSlots.length - 1]!;
          col.push({ topRow: last, botRow: last });
        }
        cols.push(col);
        if (col.length <= 1) break;
        currentSlots = col.map((s) => (s.topRow + s.botRow) / 2);
      }

      // Round keys per column — must match buildGroupRoundDefs in groupknockout.ts exactly.
      // buildGroupRoundDefs filters by matchCount <= bracketSize/2, which is based on r2Leaves count.
      const allCols: string[] = [];
      if (hasPQ) allCols.push(`${g.name} — Pre-qualify`);
      {
        const n = r2Leaves.length;
        const bSize = n <= 1 ? 2 : Math.pow(2, Math.ceil(Math.log2(n)));
        const maxCount = bSize / 2;
        const allDefs = [
          { lbl: 'R32', mc: 16 }, { lbl: 'R16', mc: 8 },
          { lbl: 'QF',  mc: 4  }, { lbl: 'SF',  mc: 2 },
          { lbl: 'Final', mc: 1 },
        ];
        const defs = allDefs.filter((d) => d.mc <= maxCount);
        if (!defs.some((d) => d.lbl === 'Final')) defs.push({ lbl: 'Final', mc: 1 });
        for (const d of defs) allCols.push(`${g.name} — ${d.lbl}`);
      }

      const groupH = totalRows * ROW_H;

      return { gi, g, hasPQ, byePs, pqMatchCount, leaves, r2Leaves, cols, allCols, groupH, rowRelY, spanRelY };
    });

    // Stack groups vertically
    let stackY = PAD;
    const grpY: number[] = [];
    for (const d of grpData) {
      grpY.push(stackY + LBL_H);
      stackY += d.groupH + LBL_H + GRP_PAD;
    }
    const totalH = PAD + stackY;

    const maxCols = Math.max(...grpData.map((d) => d.allCols.length), 1);
    const nameX   = PAD;
    const minCol0 = nameX + NAME_W + ARM;  // leftmost possible col-0 start (for groups with max cols)
    const totalW  = minCol0 + maxCols * (COL_W + COL_GAP) - COL_GAP + ARM + PAD;
    // Right-align each group's columns: groups with fewer columns start later so Final aligns.
    const colsRight = totalW - PAD - ARM; // right edge of the last column
    function gCol0X(numCols: number) {
      return colsRight - numCols * (COL_W + COL_GAP) + COL_GAP;
    }

    const lines: string[] = [];

    for (let gi = 0; gi < grpData.length; gi++) {
      const d  = grpData[gi]!;
      const gy = grpY[gi]!;
      const multiGroup = groups.length > 1;
      const col0X = gCol0X(d.allCols.length);  // this group's first column left edge

      // Group label
      if (multiGroup) {
        lines.push(`<text x="${nameX}" y="${gy - 6}" font-size="11" font-weight="700" font-family="sans-serif" fill="#555" letter-spacing="0.04em">${esc(d.g.name.toUpperCase())}</text>`);
      }

      // Column headers
      for (let ci = 0; ci < d.allCols.length; ci++) {
        const cx = col0X + ci * (COL_W + COL_GAP);
        lines.push(`<text x="${cx + COL_W/2}" y="${gy - 6}" text-anchor="middle" font-size="9" font-weight="700" font-family="sans-serif" fill="#888" letter-spacing="0.06em">${colLabel(d.allCols[ci]!)}</text>`);
      }

      // ── Player name rows ──
      for (const leaf of d.leaves) {
        const cy = gy + d.rowRelY(leaf.rowIdx);
        const xStubLocal = nameX + NAME_W;
        const nameText = clip(leaf.player);
        // Approx text width at 11px sans-serif: ~6.2px per char
        const approxTextW = Math.min(nameText.length * 6.2 + 4, NAME_W - 10);
        const lineStart = nameX + 5 + approxTextW + 3;
        if (lineStart < xStubLocal - 4) {
          lines.push(`<line x1="${lineStart}" y1="${cy}" x2="${xStubLocal - 4}" y2="${cy}" stroke="#ccc" stroke-width="0.7"/>`);
        }
        lines.push(`<text x="${nameX + 5}" y="${cy + 4}" font-size="11" font-family="sans-serif" fill="#222">${clip(esc(leaf.player))}</text>`);
      }

      // ── Name → col-0 connectors ──
      {
        const xStub  = nameX + NAME_W;
        const xPQMid = xStub + ARM / 2;           // bracket elbow before PQ col
        const cx0    = col0X;                      // PQ col left edge (or first col if no PQ)
        const cx1    = col0X + (COL_W + COL_GAP); // second col left edge

        if (d.hasPQ) {
          // ── PQ player pairs → PQ box ──
          for (const span of d.cols[0]!) {
            const cyA  = gy + d.rowRelY(span.topRow);
            const cyB  = gy + d.rowRelY(span.botRow);
            const midY = (cyA + cyB) / 2;
            lines.push(`<line x1="${xStub}" y1="${cyA}" x2="${xPQMid}" y2="${cyA}" stroke="#bbb" stroke-width="1.25"/>`);
            lines.push(`<line x1="${xStub}" y1="${cyB}" x2="${xPQMid}" y2="${cyB}" stroke="#bbb" stroke-width="1.25"/>`);
            lines.push(`<line x1="${xPQMid}" y1="${cyA}" x2="${xPQMid}" y2="${cyB}" stroke="#bbb" stroke-width="1.25"/>`);
            lines.push(`<line x1="${xPQMid}" y1="${midY}" x2="${cx0}" y2="${midY}" stroke="#bbb" stroke-width="1.25"/>`);
          }

          // ── Bye players + PQ winners → second col (QF) boxes ──
          // xm: the shared vertical bracket X — same x the PQ→QF inter-column connector uses.
          const xm    = col0X + COL_W + COL_GAP / 2;
          const qfCol = d.cols[1]!;
          for (let qi = 0; qi < qfCol.length; qi++) {
            const qspan = qfCol[qi]!;
            const qcY   = gy + d.spanRelY(qspan.topRow, qspan.botRow);
            const r2a   = d.r2Leaves[qi * 2];
            const r2b   = d.r2Leaves[qi * 2 + 1];
            const aIsBye = r2a !== undefined && Number.isInteger(r2a);
            const bIsBye = r2b !== undefined && Number.isInteger(r2b);

            if (aIsBye && bIsBye) {
              // Both bye — bracket arm at xPQMid, then long line to second col
              const cyA = gy + d.rowRelY(r2a!);
              const cyB = gy + d.rowRelY(r2b!);
              lines.push(`<line x1="${xStub}" y1="${cyA}" x2="${xPQMid}" y2="${cyA}" stroke="#bbb" stroke-width="1.25"/>`);
              lines.push(`<line x1="${xStub}" y1="${cyB}" x2="${xPQMid}" y2="${cyB}" stroke="#bbb" stroke-width="1.25"/>`);
              lines.push(`<line x1="${xPQMid}" y1="${cyA}" x2="${xPQMid}" y2="${cyB}" stroke="#bbb" stroke-width="1.25"/>`);
              lines.push(`<line x1="${xPQMid}" y1="${qcY}" x2="${cx1}" y2="${qcY}" stroke="#bbb" stroke-width="1.25"/>`);
            } else if (aIsBye || bIsBye) {
              // One bye + one PQ winner: bye arm to xm, drop to qcY (inter-col draws xm→cx1).
              const byeRow = aIsBye ? r2a! : r2b!;
              const byCy   = gy + d.rowRelY(byeRow);
              lines.push(`<line x1="${xStub}" y1="${byCy}" x2="${xm}" y2="${byCy}" stroke="#bbb" stroke-width="1.25"/>`);
              lines.push(`<line x1="${xm}" y1="${byCy}" x2="${xm}" y2="${qcY}" stroke="#bbb" stroke-width="1.25"/>`);
            }
          }
        } else {
          // No PQ — bracket arms from name col directly to first match column
          for (const span of d.cols[0]!) {
            const cyA  = gy + d.rowRelY(span.topRow);
            const cyB  = span.topRow === span.botRow ? cyA : gy + d.rowRelY(span.botRow);
            const midY = (cyA + cyB) / 2;
            lines.push(`<line x1="${xStub}" y1="${cyA}" x2="${xPQMid}" y2="${cyA}" stroke="#bbb" stroke-width="1.25"/>`);
            if (span.topRow !== span.botRow) {
              lines.push(`<line x1="${xStub}" y1="${cyB}" x2="${xPQMid}" y2="${cyB}" stroke="#bbb" stroke-width="1.25"/>`);
              lines.push(`<line x1="${xPQMid}" y1="${cyA}" x2="${xPQMid}" y2="${cyB}" stroke="#bbb" stroke-width="1.25"/>`);
            }
            lines.push(`<line x1="${xPQMid}" y1="${midY}" x2="${cx0}" y2="${midY}" stroke="#bbb" stroke-width="1.25"/>`);
          }
        }
      }

      // ── Match columns: boxes + inter-column connectors ──
      for (let ci = 0; ci < d.cols.length; ci++) {
        const col = d.cols[ci]!;
        const cx  = col0X + ci * (COL_W + COL_GAP);
        const rk  = d.allCols[ci]!;
        const rRes: MatchInfo[] = d.g.matchMap.get(rk) ?? [];

        // Inter-column connectors (current col → next col)
        if (ci < d.cols.length - 1) {
          const nextCol = d.cols[ci + 1]!;
          const x1  = cx + COL_W;
          const x2  = col0X + (ci + 1) * (COL_W + COL_GAP);
          const xm  = x1 + COL_GAP / 2;

          if (d.hasPQ && ci === 0) {
            // PQ → QF: find the r2Leaves index of each PQ winner (fractional entry),
            // then the QF slot index = floor(r2Leaves_index / 2).
            const fracIndices = d.r2Leaves
              .map((rv, idx) => ({ rv, idx }))
              .filter(({ rv }) => !Number.isInteger(rv));
            for (let mi = 0; mi < col.length; mi++) {
              const span = col[mi]!;
              const cy1  = gy + d.spanRelY(span.topRow, span.botRow);
              const r2idx = fracIndices[mi]?.idx ?? -1;
              const r2i   = r2idx >= 0 ? Math.floor(r2idx / 2) : -1;
              if (r2i >= 0 && r2i < nextCol.length) {
                const ns   = nextCol[r2i]!;
                const cy2  = gy + d.spanRelY(ns.topRow, ns.botRow);
                lines.push(`<line x1="${x1}" y1="${cy1}" x2="${xm}" y2="${cy1}" stroke="#bbb" stroke-width="1.25"/>`);
                lines.push(`<line x1="${xm}" y1="${cy1}" x2="${xm}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
                lines.push(`<line x1="${xm}" y1="${cy2}" x2="${x2}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
              }
            }
          } else {
            // Standard: pairs of current col → next col
            for (let ni = 0; ni < nextCol.length; ni++) {
              const ns   = nextCol[ni]!;
              const cy2  = gy + d.spanRelY(ns.topRow, ns.botRow);
              for (const si of [ni * 2, ni * 2 + 1]) {
                if (si < col.length) {
                  const s   = col[si]!;
                  const cy1 = gy + d.spanRelY(s.topRow, s.botRow);
                  lines.push(`<line x1="${x1}" y1="${cy1}" x2="${xm}" y2="${cy1}" stroke="#bbb" stroke-width="1.25"/>`);
                  lines.push(`<line x1="${xm}" y1="${cy1}" x2="${xm}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
                }
              }
              lines.push(`<line x1="${xm}" y1="${cy2}" x2="${x2}" y2="${cy2}" stroke="#bbb" stroke-width="1.25"/>`);
            }
          }
        }

        // Match boxes
        for (let mi = 0; mi < col.length; mi++) {
          const span = col[mi]!;
          const cy   = gy + d.spanRelY(span.topRow, span.botRow);
          const sy   = cy - BOX_H / 2;
          const res  = rRes[mi];
          const isDone = res?.isDone ?? false;
          const wA  = isDone && res?.winner === 'a';
          const wB  = isDone && res?.winner === 'b';
          const isPlaceholder = (n?: string) => /(?:Pre-qualify Winner|Winner \d+|Finalist \d+)/i.test(n ?? '');
          const aN  = res?.aName ? (isPlaceholder(res.aName) ? '' : clip(esc(res.aName))) : 'TBD';
          const bN  = res?.bName ? (isPlaceholder(res.bName) ? '' : clip(esc(res.bName))) : 'TBD';

          lines.push(`<rect x="${cx}" y="${sy}" width="${COL_W}" height="${BOX_H}" rx="5" fill="#fff" stroke="#bbb" stroke-width="1"/>`);
          lines.push(`<line x1="${cx+1}" y1="${cy}" x2="${cx+COL_W-1}" y2="${cy}" stroke="#ebebeb" stroke-width="0.75"/>`);
          lines.push(`<text x="${cx+7}" y="${sy+16}" font-size="11" font-weight="${wA?'700':'400'}" opacity="${isDone&&!wA?'0.38':'1'}" font-family="sans-serif" fill="#333">${aN}</text>`);
          lines.push(`<text x="${cx+7}" y="${sy+BOX_H-8}" font-size="11" font-weight="${wB?'700':'400'}" opacity="${isDone&&!wB?'0.38':'1'}" font-family="sans-serif" fill="#333">${bN}</text>`);

          const s = fmtScore(res);
          if (s) {
            const pw = Math.max(32, s.length * 6.5 + 10);
            const px = cx + COL_W - pw - 4; const py = cy - 8;
            lines.push(`<rect x="${px}" y="${py}" width="${pw}" height="16" rx="7" fill="#f5f5f5" stroke="#e0e0e0" stroke-width="0.75"/>`);
            lines.push(`<text x="${px+pw/2}" y="${py+11}" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="#444" font-weight="600">${s}</text>`);
          }
        }
      }
    }

    // ── Positional bracket (3rd place + 5th–8th) ──────────────────────────────
    const posRoundSuffixes: Array<{ sfx: string; display: string }> = [
      { sfx: '3rd Place',     display: '3RD PLACE' },
      { sfx: '3rd',           display: '3RD PLACE' },
      { sfx: '5th-8th Place', display: '5TH–8TH SEMI' },
      { sfx: 'L-SF',          display: '5TH–8TH SEMI' },
      { sfx: '5th Place',     display: '5TH PLACE' },
      { sfx: 'L-Final',       display: '5TH PLACE' },
      { sfx: '7th Place',     display: '7TH PLACE' },
      { sfx: 'L-3rd',         display: '7TH PLACE' },
    ];
    const posRoundLabels: Array<{ label: string; displayLabel: string; matches: MatchInfo[] }> = [];
    for (const g of groups) {
      for (const { sfx, display } of posRoundSuffixes) {
        for (const rk of g.matchMap.keys()) {
          if (rk.replace(/^[^—]+—\s*/, '').trim() !== sfx) continue;
          posRoundLabels.push({ label: rk, displayLabel: display, matches: g.matchMap.get(rk) ?? [] });
        }
      }
    }
    const seenPos = new Set<string>();
    const uniquePosRounds = posRoundLabels.filter(({ label }) => !seenPos.has(label) && seenPos.add(label) !== undefined);

    let posY = PAD + stackY + (uniquePosRounds.length > 0 ? GRP_PAD : 0);
    const posLines: string[] = [];
    if (uniquePosRounds.length > 0) {
      posLines.push(`<text x="${nameX}" y="${posY - 6}" font-size="10" font-weight="700" font-family="sans-serif" fill="#888" letter-spacing="0.08em">POSITIONAL</text>`);
      posY += LBL_H;
    }
    for (const { displayLabel, matches } of uniquePosRounds) {
      posLines.push(`<text x="${nameX}" y="${posY + 13}" font-size="9" font-weight="700" font-family="sans-serif" fill="#aaa" letter-spacing="0.06em">${displayLabel}</text>`);
      const boxStartX = nameX + NAME_W + ARM;
      for (let mi = 0; mi < matches.length; mi++) {
        const res = matches[mi]!;
        const cx = boxStartX + mi * (COL_W + COL_GAP);
        const cy = posY + LBL_H + BOX_H / 2;
        const sy = cy - BOX_H / 2;
        const isDone = res.isDone;
        const wA = isDone && res.winner === 'a';
        const wB = isDone && res.winner === 'b';
        const isPosPlaceholder = (n?: string) => /(?:Pre-qualify Winner|Winner \d+|Finalist \d+|(?:Loser|Winner) \d+)/i.test(n ?? '');
        const aN = res.aName ? (isPosPlaceholder(res.aName) ? '' : clip(esc(res.aName))) : 'TBD';
        const bN = res.bName ? (isPosPlaceholder(res.bName) ? '' : clip(esc(res.bName))) : 'TBD';
        posLines.push(`<rect x="${cx}" y="${sy}" width="${COL_W}" height="${BOX_H}" rx="5" fill="#fafafa" stroke="#ccc" stroke-width="1"/>`);
        posLines.push(`<line x1="${cx+1}" y1="${cy}" x2="${cx+COL_W-1}" y2="${cy}" stroke="#ebebeb" stroke-width="0.75"/>`);
        posLines.push(`<text x="${cx+7}" y="${sy+16}" font-size="11" font-weight="${wA?'700':'400'}" opacity="${isDone&&!wA?'0.38':'1'}" font-family="sans-serif" fill="#333">${aN}</text>`);
        posLines.push(`<text x="${cx+7}" y="${sy+BOX_H-8}" font-size="11" font-weight="${wB?'700':'400'}" opacity="${isDone&&!wB?'0.38':'1'}" font-family="sans-serif" fill="#333">${bN}</text>`);
        const s = fmtScore(res);
        if (s) {
          const pw = Math.max(32, s.length * 6.5 + 10);
          const px2 = cx + COL_W - pw - 4; const py2 = cy - 8;
          posLines.push(`<rect x="${px2}" y="${py2}" width="${pw}" height="16" rx="7" fill="#f5f5f5" stroke="#e0e0e0" stroke-width="0.75"/>`);
          posLines.push(`<text x="${px2+pw/2}" y="${py2+11}" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="#444" font-weight="600">${s}</text>`);
        }
      }
      posY += LBL_H + BOX_H + GRP_PAD / 2;
    }

    const extraH = uniquePosRounds.length > 0 ? posY - (PAD + stackY) : 0;
    const svgH = Math.max(totalH + extraH, 120);
    const svgPadT = 20;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -${svgPadT} ${totalW + 16} ${svgH + svgPadT + 8}"
      width="${totalW + 16}" height="${svgH + svgPadT + 8}" style="max-width:100%;height:auto;display:block">
      <rect x="-8" y="-${svgPadT}" width="${totalW + 16}" height="${svgH + svgPadT + 8}" fill="#fff"/>
      ${lines.join('\n')}
      ${posLines.join('\n')}
    </svg>`;
  }

  // Group-phase data for the Group KO draw diagram (Phase 1 only).
  // Includes per-match results so the diagram can show scores and highlight winners.
  const groupDrawData = $derived.by(() => {
    void playerTick;
    void tournamentTick;
    if (tournament?.format !== 'knockout') return null;
    const groups = tournament.groups;
    if (!groups || Object.keys(groups).length === 0) return null;
    const allPlayers = loadAllPlayersFn();
    const byId = new Map(allPlayers.map((p) => [p.id, p.canonicalName]));
    const sorted = Object.values(groups).sort((a, b) => a.order - b.order);
    // Build a lookup: roundName → history records, keyed by normalised player name pair
    // so matches played without QR scan (no completedAt on /planned) still get scores.
    type MatchResult = { winner?: 'a' | 'b'; setsA?: number; setsB?: number; pointsA?: number; pointsB?: number; isDone: boolean; aName: string; bName: string };
    type HistEntry = { finalPointsA?: number; finalPointsB?: number; winner?: 'a'|'b'|'draw'; setsA?: number; setsB?: number; aName: string; bName: string };
    const histByRound = new Map<string, HistEntry[]>();
    for (const rec of historyMatches) {
      const r = rec.round ?? '';
      if (!r) continue;
      const arr = histByRound.get(r) ?? [];
      arr.push({
        finalPointsA: rec.result?.finalPointsA,
        finalPointsB: rec.result?.finalPointsB,
        winner: rec.result?.winner ?? undefined,
        setsA: rec.result?.setsA,
        setsB: rec.result?.setsB,
        aName: (rec.aName ?? '').trim().toLowerCase(),
        bName: (rec.bName ?? '').trim().toLowerCase(),
      });
      histByRound.set(r, arr);
    }
    // Match a planned record to a history entry: prefer exact player-name match,
    // fall back to position index (for doubles or name mismatches).
    function findHistRec(round: string, aName: string, bName: string, fallbackIdx: number): HistEntry | undefined {
      const bucket = histByRound.get(round);
      if (!bucket) return undefined;
      const an = aName.trim().toLowerCase();
      const bn = bName.trim().toLowerCase();
      const exact = bucket.find((h) => h.aName === an && h.bName === bn);
      if (exact) return exact;
      const swapped = bucket.find((h) => h.aName === bn && h.bName === an);
      if (swapped) return swapped;
      return bucket[fallbackIdx];
    }
    const matchMap = new Map<string, MatchResult[]>();
    for (const m of plannedMatches) {
      if (!m.round || !/— (Pre-qualify|R\d+|QF|SF|Final|3rd Place|3rd|5th-8th Place|5th Place|7th Place|L-SF|L-Final|L-3rd)/.test(m.round)) continue;
      const arr = matchMap.get(m.round) ?? [];
      const aName = m.aResolvedId ? (byId.get(m.aResolvedId) ?? m.aName) : m.aName;
      const bName = m.bResolvedId ? (byId.get(m.bResolvedId) ?? m.bName) : m.bName;
      const histRec = findHistRec(m.round, aName, bName, arr.length);
      // isDone: prefer planned.completedAt, fall back to history record existing
      const isDone = !!m.completedAt || !!histRec;
      arr.push({
        isDone,
        winner: m.result?.winner === 'a' ? 'a' : m.result?.winner === 'b' ? 'b'
          : histRec?.winner === 'a' ? 'a' : histRec?.winner === 'b' ? 'b' : undefined,
        setsA: m.result?.setsA ?? histRec?.setsA,
        setsB: m.result?.setsB ?? histRec?.setsB,
        pointsA: histRec?.finalPointsA,
        pointsB: histRec?.finalPointsB,
        aName,
        bName,
      });
      matchMap.set(m.round, arr);
    }
    return sorted.map((g) => {
      const pqNameSet = new Set((g.preQualifyIds ?? []).map((id) => byId.get(id) ?? id));
      return {
        name: g.name,
        players: (g.playerIds ?? []).map((id) => byId.get(id) ?? id),
        preQualifyNames: pqNameSet,
        matchMap,
      };
    });
  });

  const groupKODiagramSVG = $derived.by(() => {
    if (!groupDrawData) return '';
    return buildGroupKODiagramSVG(groupDrawData);
  });

  // Phase 2 KO bracket for Group KO tournaments — uses the same buildFlightBracketSVG
  // as the standalone KO bracket, but filtered to "KO — *" rounds instead.
  const groupKOPhase2SVG = $derived.by<string>(() => {
    void tournamentTick;
    void playerTick;
    if (tournament?.format !== 'knockout') return '';
    if (!tournament.groups || Object.keys(tournament.groups).length < 2) return '';
    const koMatches = plannedMatches
      .filter((m) => /^KO — /.test(m.round ?? ''));
    if (koMatches.length === 0) return '';
    const histKOMap = buildHistByRound(historyMatches, (r) => /^KO — /.test(r));
    // Group by round label, ordering rounds by bracket stage (Pre-QF → R16 → QF → SF → Final)
    // Short aliases (QF/SF) kept for backward compat with data created before the rename.
    const stageRank = (r: string) => {
      const s = r.replace(/^KO — /, '');
      const order = ['Pre-QF', 'Round of 16', 'QF', 'Quarter Finals', 'SF', 'Semi Finals', 'Final'];
      const i = order.indexOf(s);
      return i >= 0 ? i : 99;
    };
    const roundMap = new Map<string, PlannedMatch[]>();
    for (const m of koMatches) {
      const r = m.round!;
      if (!roundMap.has(r)) roundMap.set(r, []);
      roundMap.get(r)!.push(m);
    }
    const roundOrder = [...roundMap.keys()].sort((a, b) => stageRank(a) - stageRank(b));
    // Sort matches within each round by matchOrder
    for (const arr of roundMap.values()) arr.sort((a, b) => (a.matchOrder ?? 0) - (b.matchOrder ?? 0));
    const cols = roundOrder.map((r) => {
      const slots: BracketSlot[] = [];
      for (const m of (roundMap.get(r) ?? [])) {
        const h = findHistEntry(histKOMap, r, m.aName, m.bName, slots.length);
        const isDone = !!m.completedAt || !!h;
        const groupNameSet = new Set(Object.values(tournament?.groups ?? {}).map((g) => g.name));
        const isKOPlaceholder = (n: string, hasId: boolean) =>
          !hasId && (/(?:Winner|Finalist)\s+\d+|KO Qualifier|KO Winner|Pre-QF Winner/i.test(n) || groupNameSet.has(n));
        slots.push({
          aId: m.aResolvedId,
          aName: m.aResolvedId ? (resolvedName(m.aResolvedId, m.aName)) : (isKOPlaceholder(m.aName, false) ? '' : m.aName),
          bId: m.bResolvedId,
          bName: m.bResolvedId ? (resolvedName(m.bResolvedId, m.bName)) : (isKOPlaceholder(m.bName, false) ? '' : m.bName),
          isDone,
          winner: m.result?.winner === 'a' ? 'a' : m.result?.winner === 'b' ? 'b'
            : h?.winner === 'a' ? 'a' : h?.winner === 'b' ? 'b' : undefined,
          setsA: m.result?.setsA ?? h?.setsA,
          setsB: m.result?.setsB ?? h?.setsB,
          pointsA: h?.finalPointsA,
          pointsB: h?.finalPointsB,
        });
      }
      return { label: r.replace(/^KO — /, ''), slots };
    });
    if (cols.length < 1) return '';
    return buildFlightBracketSVG(cols, true);
  });

  // Standalone KO bracket SVG — for format='knockout' tournaments.
  // Uses buildFlightBracketSVG (light/print theme) built from planned matches.
  const standaloneKOBracketSVG = $derived.by<string>(() => {
    void tournamentTick;
    void playerTick;
    if (tournament?.format !== 'knockout') return '';
    const koMatches = plannedMatches.filter((m) => KO_BRACKET_ROUND_RX.test(m.round ?? ''));
    if (koMatches.length === 0) return '';
    const rounds = koRoundsFromMatches(koMatches);
    if (rounds.length === 0) return '';
    const histKOMap = buildHistByRound(historyMatches, (r) => KO_BRACKET_ROUND_RX.test(r));
    const cols = rounds.map((r) => {
      const slots: BracketSlot[] = [];
      for (const m of koMatches.filter((m) => m.round === r).sort((a, b) => (a.matchOrder ?? 0) - (b.matchOrder ?? 0))) {
        const h = findHistEntry(histKOMap, r, m.aName, m.bName, slots.length);
        const isDone = !!m.completedAt || !!h;
        slots.push({
          aId: m.aResolvedId,
          aName: m.aName,
          bId: m.bResolvedId,
          bName: m.bName,
          isDone,
          winner: m.result?.winner === 'a' ? 'a' : m.result?.winner === 'b' ? 'b'
            : h?.winner === 'a' ? 'a' : h?.winner === 'b' ? 'b' : undefined,
          setsA: m.result?.setsA ?? h?.setsA,
          setsB: m.result?.setsB ?? h?.setsB,
          pointsA: h?.finalPointsA,
          pointsB: h?.finalPointsB,
        });
      }
      return { label: stageLabel(r), slots };
    });
    return buildFlightBracketSVG(cols);
  });

  // RR schedule SVG — shown for roundrobin tournaments that have Group RR matches
  // but no knockout bracket yet.
  function buildRRScheduleSVG(matches: PlannedMatch[]): string {
    const sorted = [...matches].sort((a, b) => a.matchOrder - b.matchOrder);
    if (sorted.length === 0) return '';

    const ROW_H = 32;
    const COL_NAME = 180;
    const COL_VS = 24;
    const COL_RESULT = 60;
    const PAD_X = 16;
    const PAD_Y = 24;
    const HEADER_H = 28;
    const TOTAL_W = COL_NAME + COL_VS + COL_NAME + COL_RESULT + PAD_X * 2;
    const TOTAL_H = PAD_Y + HEADER_H + sorted.length * ROW_H + PAD_Y;
    const NAME_MAX = 20;

    function clip(s: string): string {
      return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
    }

    const lines: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${TOTAL_W}" height="${TOTAL_H}" viewBox="0 0 ${TOTAL_W} ${TOTAL_H}">`,
      `<rect width="${TOTAL_W}" height="${TOTAL_H}" fill="#fff"/>`,
      // Header row
      `<rect x="0" y="${PAD_Y}" width="${TOTAL_W}" height="${HEADER_H}" fill="#f0f0f0"/>`,
      `<text x="${PAD_X}" y="${PAD_Y + 18}" font-size="11" font-weight="700" font-family="sans-serif" fill="#555">#</text>`,
      `<text x="${PAD_X + 28}" y="${PAD_Y + 18}" font-size="11" font-weight="700" font-family="sans-serif" fill="#555">Side A</text>`,
      `<text x="${PAD_X + 28 + COL_NAME + COL_VS / 2}" y="${PAD_Y + 18}" text-anchor="middle" font-size="11" font-weight="700" font-family="sans-serif" fill="#555">vs</text>`,
      `<text x="${PAD_X + 28 + COL_NAME + COL_VS}" y="${PAD_Y + 18}" font-size="11" font-weight="700" font-family="sans-serif" fill="#555">Side B</text>`,
      `<text x="${TOTAL_W - PAD_X}" y="${PAD_Y + 18}" text-anchor="end" font-size="11" font-weight="700" font-family="sans-serif" fill="#555">Result</text>`,
    ];

    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      const y = PAD_Y + HEADER_H + i * ROW_H;
      const cy = y + ROW_H / 2 + 4;
      const rowFill = i % 2 === 0 ? '#fff' : '#fafafa';
      const isDone = !!m.completedAt;
      const winnerA = isDone && m.result?.winner === 'a';
      const winnerB = isDone && m.result?.winner === 'b';

      lines.push(`<rect x="0" y="${y}" width="${TOTAL_W}" height="${ROW_H}" fill="${rowFill}"/>`);
      // Match number
      lines.push(`<text x="${PAD_X}" y="${cy}" font-size="10" font-family="sans-serif" fill="#999">${m.matchOrder}</text>`);
      // Side A
      const aFill = winnerA ? '#1a7f4b' : '#1a1a1a';
      lines.push(`<text x="${PAD_X + 28}" y="${cy}" font-size="12" font-weight="${winnerA ? '700' : '400'}" font-family="sans-serif" fill="${aFill}">${clip(resolvedName(m.aResolvedId, m.aName))}</text>`);
      // vs
      lines.push(`<text x="${PAD_X + 28 + COL_NAME + COL_VS / 2}" y="${cy}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#bbb">vs</text>`);
      // Side B
      const bFill = winnerB ? '#1a7f4b' : '#1a1a1a';
      lines.push(`<text x="${PAD_X + 28 + COL_NAME + COL_VS}" y="${cy}" font-size="12" font-weight="${winnerB ? '700' : '400'}" font-family="sans-serif" fill="${bFill}">${clip(resolvedName(m.bResolvedId, m.bName))}</text>`);
      // Result
      if (isDone && m.result) {
        lines.push(`<text x="${TOTAL_W - PAD_X}" y="${cy}" text-anchor="end" font-size="11" font-family="sans-serif" fill="#444">${m.result.setsA}–${m.result.setsB}</text>`);
      }
      // Bottom divider
      lines.push(`<line x1="0" y1="${y + ROW_H}" x2="${TOTAL_W}" y2="${y + ROW_H}" stroke="#e8e8e8" stroke-width="0.5"/>`);
    }

    lines.push('</svg>');
    return lines.join('\n');
  }

  // RR schedule SVG: built from Group RR planned matches for roundrobin tournaments.
  const rrScheduleSVG = $derived.by<string>(() => {
    void tournamentTick;
    void playerTick;
    if (tournament?.format !== 'roundrobin') return '';
    if (flightBracketSVGs.size > 0) return ''; // knockout bracket already exists — don't show RR grid
    const rrMatches = plannedMatches.filter((m) => m.round === 'Group RR');
    return buildRRScheduleSVG(rrMatches);
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
        {#if boards.length > 0 || plannedMatches.length > 0}
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
      {#if boards.length > 0 || plannedMatches.length > 0}
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
          {#if tournament?.startDate}
            <p class="cover-date">{new Date(tournament.startDate + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          {/if}
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
        <div class="meta-row meta-row-full">
          <span class="meta-label">Default format</span>
          <span class="meta-value">{configLine}</span>
        </div>
        {#each flightCfgRows as row (row.flight)}
        <div class="meta-row meta-row-full meta-row-flight">
          <span class="meta-label">{row.flight}</span>
          <span class="meta-value">{row.cfg}</span>
        </div>
        {/each}
        <div class="meta-row">
          <span class="meta-label">Type</span>
          <span class="meta-value">
            {tournament?.type === 'closed' ? 'Invite-only (assigned roster)' : 'Open'}
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Boards</span>
          <span class="meta-value">{tournament?.knockoutCfg?.venueBoards ?? tournament?.knockoutCfg?.boardsAvailable ?? boards.length}</span>
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
                <span class="roster-flag" aria-label={countryName(p.country)}>{flagEmoji(p.country)}</span>
              {/if}
              {#if p.represents}
                <span class="roster-represents">{p.represents}</span>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="cover-empty">No players registered yet.</p>
      {/if}

      {#if mergedSchedule.length > 0}
        <h2 class="cover-section cover-section-schedule">
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
                  {@const schedNames = resolvedPlannedNames.get(m.mid)}
                  {@const isSchedPh = (n?: string) => !n || /(?:Winner|Loser|Finalist)\s+\d+/i.test(n)}
                  {@const aN = schedNames?.aName ?? resolvedName(m.aResolvedId, m.aName)}
                  {@const bN = schedNames?.bName ?? resolvedName(m.bResolvedId, m.bName)}
                  <tr>
                    <td class="sched-board">{qrMode === 'match' ? `M${matchNum}` : (m.board ? `B${m.board}` : '—')}</td>
                    <td class="sched-matchup">
                      <span class="sched-player" class:sched-ph={isSchedPh(aN)}>{aN}{#if m.a2Name} + {resolvedName(m.a2ResolvedId, m.a2Name)}{/if}</span>
                      <span class="sched-vs">vs</span>
                      <span class="sched-player" class:sched-ph={isSchedPh(bN)}>{bN}{#if m.b2Name} + {resolvedName(m.b2ResolvedId, m.b2Name)}{/if}</span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      {/if}

      <div class="page-footer">
        {#if printLogoUrl}
          <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
        {/if}
        {#if printOrganizerName}
          <span class="page-footer-org">Organised by {printOrganizerName}</span>
        {/if}
        <span class="page-footer-brand">carromscore.app</span>
      </div>
    </section>

    {#if rrScheduleSVG}
      <!-- ─── RR SCHEDULE PAGE (roundrobin, pre-knockout) ────────────── -->
      <section class="page bracket-page">
        <div class="bracket-hdr">
          <div class="bracket-hdr-main">
            <p class="brand">Carromscore</p>
            <h2 class="bracket-title">{tournamentName} — Round Robin Schedule</h2>
            {#if printOrganizerName}
              <p class="bracket-organizer">Organised by {printOrganizerName}</p>
            {/if}
          </div>
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="bracket-logo" />
          {/if}
        </div>
        <div class="bracket-svg-wrap">
          {@html rrScheduleSVG}
        </div>
        <div class="page-footer">
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
          {/if}
          {#if printOrganizerName}
            <span class="page-footer-org">Organised by {printOrganizerName}</span>
          {/if}
          <span class="page-footer-brand">carromscore.app</span>
        </div>
      </section>
    {/if}

    {#if groupKODiagramSVG}
      <!-- ─── GROUP KNOCKOUT PHASE 1 PAGE ──────────────────────────── -->
      <section class="page bracket-page">
        <div class="bracket-hdr">
          <div class="bracket-hdr-main">
            <p class="brand">Carromscore</p>
            <h2 class="bracket-title">{tournamentName} — Phase 1: Group Brackets</h2>
            {#if printOrganizerName}
              <p class="bracket-organizer">Organised by {printOrganizerName}</p>
            {/if}
          </div>
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="bracket-logo" />
          {/if}
        </div>
        <div class="bracket-svg-wrap">
          {@html groupKODiagramSVG}
          {#if groupKOPhase2SVG}
            <div class="combined-ko-divider">
              <span class="combined-ko-label">Combined Knockout</span>
            </div>
            {@html groupKOPhase2SVG}
          {/if}
        </div>
        <div class="page-footer">
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
          {/if}
          {#if printOrganizerName}
            <span class="page-footer-org">Organised by {printOrganizerName}</span>
          {/if}
          <span class="page-footer-brand">carromscore.app</span>
        </div>
      </section>
    {/if}

    {#if standaloneKOBracketSVG}
      <!-- ─── STANDALONE KO BRACKET PAGE ──────────────────────────── -->
      <section class="page bracket-page">
        <div class="bracket-hdr">
          <div class="bracket-hdr-main">
            <p class="brand">Carromscore</p>
            <h2 class="bracket-title">{tournamentName} — Draw</h2>
            {#if printOrganizerName}
              <p class="bracket-organizer">Organised by {printOrganizerName}</p>
            {/if}
          </div>
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="bracket-logo" />
          {/if}
        </div>
        <div class="bracket-svg-wrap">
          {@html standaloneKOBracketSVG}
        </div>
        <div class="page-footer">
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
          {/if}
          {#if printOrganizerName}
            <span class="page-footer-org">Organised by {printOrganizerName}</span>
          {/if}
          <span class="page-footer-brand">carromscore.app</span>
        </div>
      </section>
    {/if}

    {#if flightBracketSVGs.size >= 1}
      <!-- ─── BRACKET PAGE(S) ─────────────────────────────────────────
           Single flight: one page with the bracket tree.
           Multi-flight (league): one bracket section per flight on
           one shared page, each with its own header and SVG. -->
      {#each activeBracketFlights as flight (flight.name)}
        {@const flightSVG = flightBracketSVGs.get(flight.name) ?? (activeBracketFlights.length <= 1 ? bracketSVG : '')}
        {#if flightSVG}
          <section class="page bracket-page">
            <div class="bracket-hdr">
              <div class="bracket-hdr-main">
                <p class="brand">Carromscore</p>
                <h2 class="bracket-title">{tournamentName}{flight.name ? ` — ${flight.name}` : ' — Draw'}</h2>
                {#if printOrganizerName}
                  <p class="bracket-organizer">Organised by {printOrganizerName}</p>
                {/if}
              </div>
              {#if printLogoUrl}
                <img src={printLogoUrl} alt="Organiser logo" class="bracket-logo" />
              {/if}
            </div>
            <div class="bracket-svg-wrap">
              {@html flightSVG}
            </div>
            <div class="page-footer">
              {#if printLogoUrl}
                <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
              {/if}
              {#if printOrganizerName}
                <span class="page-footer-org">Organised by {printOrganizerName}</span>
              {/if}
              <span class="page-footer-brand">carromscore.app</span>
            </div>
          </section>
        {/if}
      {/each}
    {/if}

    {#if boards.length > 0 || plannedMatches.length > 0}
    {#if qrMode === 'board' && boards.length > 0}
      <!-- ─── BOARD STICKERS (permanent per-board QR, 2-column grid) ── -->
      <section class="page qr-grid-page">
        <div class="qr-grid-hdr">
          <div class="qr-grid-hdr-main">
            <p class="brand">Carromscore</p>
            <p class="qr-grid-title">{tournamentName} — Board QR Codes</p>
            {#if printOrganizerName}
              <p class="bracket-organizer">Organised by {printOrganizerName}</p>
            {/if}
            <p class="qr-grid-sub">Cut out each sticker and stick it on the physical board. Same QR used every round.</p>
          </div>
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="bracket-logo" />
          {/if}
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
        <div class="page-footer">
          {#if printLogoUrl}
            <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
          {/if}
          {#if printOrganizerName}
            <span class="page-footer-org">Organised by {printOrganizerName}</span>
          {/if}
          <span class="page-footer-brand">carromscore.app</span>
        </div>
      </section>
    {:else if qrMode === 'match' || boards.length === 0}
      <!-- ─── PER-MATCH QR CARDS (one QR per planned match) ─────────── -->
      {#each mergedSchedule as round, ri (round.key)}
        <section class="page qr-grid-page">
          <div class="qr-grid-hdr">
            <div class="qr-grid-hdr-main">
              <p class="brand">Carromscore</p>
              <p class="qr-grid-title">{tournamentName} — Match QR Cards — {round.displayName}</p>
              {#if printOrganizerName}
                <p class="bracket-organizer">Organised by {printOrganizerName}</p>
              {/if}
              <p class="qr-grid-sub">Cut out each card and place at the board for that match. Scan to start scoring.</p>
            </div>
            {#if printLogoUrl}
              <img src={printLogoUrl} alt="Organiser logo" class="bracket-logo" />
            {/if}
          </div>
          <div class="match-qr-grid">
            {#each round.matches as m, mi (m.mid)}
              {@const matchNum = mergedSchedule.slice(0, ri).reduce((acc, r) => acc + r.matches.length, 0) + mi + 1}
              {@const mqrNames = resolvedPlannedNames.get(m.mid)}
              <div class="match-qr-cell">
                <p class="mqr-board">Match {matchNum}</p>
                <div class="mqr-matchup">
                  <span class="mqr-side">{mqrNames?.aName ?? resolvedName(m.aResolvedId, m.aName)}{#if m.a2Name}<br/><span class="mqr-partner">{resolvedName(m.a2ResolvedId, m.a2Name)}</span>{/if}</span>
                  <span class="mqr-vs">vs</span>
                  <span class="mqr-side">{mqrNames?.bName ?? resolvedName(m.bResolvedId, m.bName)}{#if m.b2Name}<br/><span class="mqr-partner">{resolvedName(m.b2ResolvedId, m.b2Name)}</span>{/if}</span>
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
          <div class="page-footer">
            {#if printLogoUrl}
              <img src={printLogoUrl} alt="Organiser logo" class="page-footer-logo" />
            {/if}
            {#if printOrganizerName}
              <span class="page-footer-org">Organised by {printOrganizerName}</span>
            {/if}
            <span class="page-footer-brand">carromscore.app</span>
          </div>
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
  /* Organizer override inputs */
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

  .combined-ko-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 2rem 0 1rem;
  }
  .combined-ko-divider::before,
  .combined-ko-divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid #ccc;
  }
  .combined-ko-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #888;
    text-transform: uppercase;
    white-space: nowrap;
  }

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
  .cover-date {
    margin: 0.15rem 0 0;
    font-size: 1rem;
    color: #555;
    font-weight: 500;
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
    display: grid;
    grid-template-columns: 10rem 1fr;
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
    white-space: nowrap;
  }
  .meta-value {
    color: #000;
    font-weight: 600;
  }
  .meta-row-full {
    grid-column: 1 / -1;
  }
  .meta-row-flight {
    border-left: 3px solid #000;
    padding-left: 0.6rem;
    margin: 0.1rem 0;
  }
  .meta-row-flight .meta-label {
    color: #333;
  }

  .cover-section {
    margin: 1.1rem 0 0.5rem;
    font-size: 1.05rem;
    color: #000;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 800;
  }
  .cover-section-schedule {
    break-before: page;
    margin-top: 0;
    padding-top: 1.5rem;
  }
  .roster {
    list-style: decimal;
    padding-left: 1.6rem;
    margin: 0.4rem 0 0;
    column-count: 2;
    column-gap: 2rem;
  }
  .roster-row {
    break-inside: avoid;
    -webkit-column-break-inside: avoid;
    page-break-inside: avoid;
    padding: 0.18rem 0;
    font-size: 0.9rem;
    color: #111;
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    white-space: nowrap;
    overflow: hidden;
  }
  .roster-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .roster-flag {
    flex-shrink: 0;
    font-size: 0.85rem;
  }
  .roster-represents {
    flex-shrink: 1;
    font-size: 0.78rem;
    color: #888;
    overflow: hidden;
    text-overflow: ellipsis;
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
  .sched-ph {
    color: #bbb;
    font-weight: 400;
    font-style: italic;
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
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding-bottom: 1rem;
    border-bottom: 2px solid #000;
    margin-bottom: 1.2rem;
  }
  .qr-grid-hdr-main {
    flex: 1;
    text-align: center;
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
    gap: 0.75rem 1.2rem;
    flex: 1;
  }
  .qr-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    border: 1.5px dashed #ccc;
    padding: 0.5rem 0.6rem 0.5rem;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .qr-cell-board {
    margin: 0 0 0.3rem;
    font-size: 1.2rem;
    font-weight: 900;
    color: #000;
    letter-spacing: 0.02em;
  }
  .qr-holder {
    background: #fff;
    padding: 0.3rem;
    border: 2px solid #000;
    line-height: 0;
  }
  .qr-holder :global(svg) {
    width: 160px;
    height: 160px;
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
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
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
    width: min(180px, 100%);
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mqr-qr-holder :global(svg) { width: 100% !important; height: 100% !important; max-width: 180px; max-height: 180px; }

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
    .page-footer-brand {
      font-size: 0.68rem;
      color: #bbb;
      font-weight: 600;
      letter-spacing: 0.04em;
      margin-left: auto;
    }
    .cover-meta {
      grid-template-columns: 1fr;
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
    display: flex;
    flex-direction: column;
    color-scheme: light;
    background: #fff;
    color: #000;
  }
  .bracket-hdr {
    display: flex;
    align-items: flex-start;
    gap: 0.9rem;
    margin-bottom: 1.25rem;
    border-bottom: 2px solid #e0e0e0;
    padding-bottom: 0.75rem;
  }
  .bracket-hdr-main {
    flex: 1;
    min-width: 0;
  }
  .bracket-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0.15rem 0 0.25rem;
    line-height: 1.2;
  }
  .bracket-organizer {
    margin: 0;
    font-size: 0.82rem;
    color: #555;
    font-weight: 500;
  }
  .bracket-logo {
    flex-shrink: 0;
    max-height: 3rem;
    max-width: 5rem;
    object-fit: contain;
    align-self: center;
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
      padding-top: 1.5rem;
    }
    .bracket-svg-wrap {
      overflow: visible;
    }
  }

</style>
