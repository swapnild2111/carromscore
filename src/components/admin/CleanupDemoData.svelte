<script lang="ts">
  /**
   * One-shot cleanup for the "League Demo 2026" data written by the seeder.
   * Deletes ONLY the exact records created: tournament, 48 players, 153 planned matches.
   * Nothing else is touched.
   * Remove this file + the cleanup page after use.
   */
  import { ensureAnonAuth } from '../../lib/auth';

  // Exactly what the seeder wrote — hardcoded so we never touch anything else.
  const TOURNAMENT_KEY = 'league-demo-2026';

  // Flight tournaments generated from the parent (normalizeKey of their names)
  const FLIGHT_KEYS = [
    'league-demo-2026-gold-flight',
    'league-demo-2026-silver-flight',
    'league-demo-2026-bronze-flight',
  ];

  const PLAYER_IDS = [
    'ananya-das-8nkh','ananya-das-ne3l','anil-gupta-8n57','anil-gupta-xyu1',
    'anjali-singh-9lgw','anjali-singh-b9tk','arjun-sharma-b8ap','arjun-sharma-khdd',
    'deepak-rao-21sz','deepak-rao-wmkl','divya-menon-vegf','divya-menon-wpxg',
    'farhan-ali-m57j','farhan-ali-yjms','kavya-reddy-1mwm','kavya-reddy-vztd',
    'kiran-malhotra-2809','kiran-malhotra-8ygi','lakshmi-nair-vcqf','lakshmi-nair-xaxh',
    'meera-joshi-l31g','meera-joshi-ql63','mohit-kapoor-4xu8','mohit-kapoor-uuy5',
    'nitin-bose-6vnq','nitin-bose-se9b','pooja-verma-sau9','pooja-verma-svgh',
    'priya-mehta-5i8b','priya-mehta-eej6','rahul-nair-2lkk','rahul-nair-p1yd',
    'rajesh-pandey-f6td','rajesh-pandey-qbto','ravi-pillai-1vf4','ravi-pillai-mrjd',
    'sneha-patel-kt8n','sneha-patel-oyrx','sunita-rao-ld72','sunita-rao-t9b2',
    'suresh-kumar-fd7q','suresh-kumar-xlvl','swati-desai-8b8i','swati-desai-xyzn',
    'tanya-bhatt-iido','tanya-bhatt-k79w','vikram-iyer-c53z','vikram-iyer-p6o7',
  ];

  const PLANNED_KEYS = [
    "-P0y-zg1bUfr3m_HcP0M","-P0y-wYQMKD7ZczYWg6q","-P0xnDuOkR_C8o0bpyiy","-P0y-xdgNEStcH5wsxIp","-P0y-zznJidkbZQpct5L","-P0y-yfvAdrQTnuy_yBk","-P0xnEXZEJJGaHfyZEIc","-P0y-wW29gVAKqjpaUdR","-P0y-yGi2XrR18qGNJcV","-P0xnDCPmXfLQDSmvSWu",
    "-P0y-wnv38kDhF5ksp9v","-P0xnDA1W63SW6jFspOF","-P0xnE5CdCMBxPMCWIRg","-P0y-zSGwfwcIVbESUC1","-P0xnEbIOwqRch7eiqtp","-P0y-wHszCUuX5qoEX4r","-P0y-z4mURUR3sZXHyX0","-P0y-ybEAgv2UAiq5rq_","-P0y-w62r98mQ0TGYNd0","-P0xnEQU551sb7xKuJL0",
    "-P0y-ziMue9IaxnvLnoG","-P0xnEuIayBCBmVtCpo5","-P0y-yrfHKxQzmYjJuup","-P0y-wjCLsW1a2rybg-Q","-P0y-x_1I0InN0UGqiEv","-P0xnDpeiTvwEbtzDSee","-P0y-xkoQmgDqsMEaA3y","-P0y-xT5F4-QeLP44O4G","-P0y-weSh08MDyrzwI9A","-P0xnELn7GsI4M6AwYUg",
    "-P0y-xyve6PaHSApqZUu","-P0xnDLuuTJqjOy_xUHP","-P0xnE0TWQzuh1IUHxpH","-P0y-wAklea8xqwocGXf","-P0xnDgClKkOGTVZDW4m","-P0xnDnLHCuhZM6fWAr5","-P0y-yZtlNWFEBfMXOjL","-P0y-zslwRKFpmjBWK0L","-P0y-x3L2ozmRfA0uf4j","-P0xnDz7RiPUkshrRAF1",
    "-P0xnE7Xz2cqAHyzhOTx","-P0xnDVVYZW4aYAteyYC","-P0y-wgpdA6NvUSqzYJQ","-P0y-yXHgMxu5EJVQxXS","-P0y-wzhvNHIm47wO271","-P0y-zdemjaFcbkJ2ccZ","-P0y-yLO-eCkc5m6X_qs","-P0y-w8QdxePkKlr5Zw2","-P0y-zLBtSpunjNFH-eO","-P0y-w_kvM8Z3RgIhoLL",
    "-P0xnEH0XE6uFZjHPGTM","-P0y-xAPhcGivf9yvB5F","-P0y-xXhbK08MxO84lkz","-P0y-wFWOuvWlvc-3AVr","-P0y-xrr4ndOTjS1tTOe","-P0y-z72tMUucVt2MvmM","-P0xnDH7NoSJsn5hQ-eS","-P0y-wqGdTxDgz5zckhO","-P0xnFEWbNiBrveaGlhS","-P0y-y9c3sPTainPHmd_",
    "-P0y-yu0uGiVpu9-aAnD","-P0y-xwWfg0cf9H5TKA8","-P0y-xJrJju945THO8BC","-P0xnDXlFsHmZ86RWypA","-P0xnDbWY-cjiON1FuUQ","-P0y-yBzxrkA281Y5XMc","-P0xnFGrS4OxtLPwrS1u","-P0xnFJEb_mAwi9chMQz","-P0y-zkjQoNiF8q4TQLz","-P0y-x10DWJzZ7hs3wae",
    "-P0xnDiZ7wV1b4rtx4cX","-P0y-xOVUJL3bQqVFCpx","-P0y-ykd2EUFq-kqiCC0","-P0y-zInAXot-dHclhR0","-P0y-wxOBwzpxU2vyP-a","-P0xnF7OId8J8x9foyUU","-P0y-w3hcYGFeYqxy3eC","-P0xnErtwn0plW-DAsGY","-P0y-zGQ7QKnJ8X_b_9o","-P0y-xpWC9zUHVTocNfI",
    "-P0y-wD5ZtxeA_xFFDIA","-P0xnDEnLXtDegHP-ysq","-P0y-xHRLjB54o3xNQBd","-P0y-zn5OjqleiN8Kd0t","-P0y-wsfhWDfD10jp3Vm","-P0xnEfyK9L1K7bM51yq","-P0xnD7fJp0WN7Q8XKd-","-P0xnEn87ZKKhC2sr5Lh","-P0y-wROS02ba13d0Q3I","-P0y-wTj54Wh6oZ5nO3p",
    "-P0xnDT5kF2KmSpTPk3L","-P0xnD0UxnPTXPilQPNI","-P0y-zE92YT1NzjamnEP","-P0y-wM_wVYYo__QOa-5","-P0y-yiHU0PexXsBEAQZ","-P0y0-18Mne34b7SK9EW","-P0xnEVDuERNeJIMJBGW","-P0y-y4yFSJ8oGKvfaje","-P0xnF9k6ZNIS6Yz6vVv","-P0xnEZw875WTlhG-6g-",
    "-P0xnESsvbKqNKXPpAI5","-P0y-yJ2AddVODzHOlD-","-P0xnEdbxJyx01WDw4Ia","-P0y-xF7-4NCJIoItoMX","-P0y-xg1_syPvDzCdiBZ","-P0xnDs-dzFUTmSUdRF2","-P0y-x81zigWwHE8K7ut","-P0xnEO812iNmKHppn97","-P0xnDdthXCs536dr6Ra","-P0xnDJYTPkAVYQLLOjO",
    "-P0xnD5I7imUjaGPE1vn","-P0y-xVM92cnMZgfv0_c","-P0y-zxSLTB3ac6pltzF","-P0xnE2niCrJslsDr0Jc","-P0xnEEcGXD0biTXMwwE","-P0xnFC6p07udHZESsJf","-P0xnF5-YXTVKaAUgBe4","-P0y-zqSAJrgYHE5jvu6","-P0y-wlZ_6GsNJs4Ral6","-P0y-z9RR4J7P1Aredr5",
    "-P0xnEwfcqQDSZT8FBmX","-P0y-xiQKHFBM8fINPiK","-P0y-ypNsSdAh3N9SX2g","-P0xnEyzgwrHy7CnwKVO","-P0xnECGsH_yJ_2jFKpz","-P0y-wOzWo2lW_u1fHUp","-P0y-yEOdHqU5f4Vr9Be","-P0y-zPu2HCPBaKeQqWp","-P0xnEiKXz8zXO2cij1O","-P0y-zv4F6HUipNHPT5V",
    "-P0y-y2braalfTzJCLeK","-P0xnDkv335ylY3Mz8Q0","-P0y-yn3sJ9yLTZsuY5S","-P0xnDQg4y0MUZGp8SsS","-P0y-ydZjPIjQF79Nsq1","-P0y-zNYqZxEiKYWFrfh","-P0y-xuA23pADUfnij7u","-P0y-y0FayRkTJt-ILKx","-P0xnF0K3rk3twfRW0vW","-P0xnEpVpebiKIo9FG7w",
    "-P0y-xbN4BV-LK2tmcQv","-P0y-xMAR9Kq5i1trOj1","-P0y-x5e1l4nptkOwRhw","-P0xnF2fOwXSI4r0n2sf","-P0xnD2un8XOlJKeZEJR","-P0y-wKELqG7ATIST2GG","-P0y-xQnAPccRCY7sW3r","-P0y-y7JcM7YIExw3hj8","-P0y-zBokRQ2fn76L_Oz","-P0y-wv0bTyeaMPSEyG4",
    "-P0xnDwk9o4KYN_hpgBv","-P0xnDOJ3PoKpvCTvLXl","-P0xnEJPxA2J9uFV7R71",
  ];

  let logs = $state<{ msg: string; ok: boolean }[]>([]);
  let running = $state(false);
  let done = $state(false);

  function log(msg: string, ok = true) { logs.push({ msg, ok }); }

  async function runCleanup() {
    running = true;
    logs = [];

    try {
      await ensureAnonAuth();
      const [{ getDatabase, ref, remove, update }, { firebaseApp }] = await Promise.all([
        import('firebase/database'),
        import('../../lib/firebase'),
      ]);
      const db = getDatabase(firebaseApp());

      // 1. Delete parent tournament + 3 flight tournaments
      const allTournamentKeys = [TOURNAMENT_KEY, ...FLIGHT_KEYS];
      for (const tk of allTournamentKeys) {
        log(`Deleting tournament: ${tk}…`);
        await remove(ref(db, `tournaments/${tk}`));
        log(`  ✓ Deleted`);
      }

      // 2. Delete hardcoded planned matches (group phase) in batches of 20
      log(`Deleting ${PLANNED_KEYS.length} planned matches (group phase)…`);
      const BATCH = 20;
      for (let i = 0; i < PLANNED_KEYS.length; i += BATCH) {
        const batch = PLANNED_KEYS.slice(i, i + BATCH);
        const patch: Record<string, null> = {};
        for (const k of batch) patch[`planned/${k}`] = null;
        await update(ref(db, '/'), patch);
        log(`  ✓ Matches ${i + 1}–${Math.min(i + BATCH, PLANNED_KEYS.length)} deleted`);
      }

      // 2b. Query-sweep for flight-phase planned matches tagged to any of the 4 tournament keys
      const { query, orderByChild, equalTo, get } = await import('firebase/database');
      const allKeys = [TOURNAMENT_KEY, ...FLIGHT_KEYS];
      for (const tk of allKeys) {
        const snap = await get(query(ref(db, 'planned'), orderByChild('tournamentKey'), equalTo(tk)));
        if (snap.exists()) {
          const flightPatch: Record<string, null> = {};
          snap.forEach(child => { flightPatch[`planned/${child.key}`] = null; });
          const count = Object.keys(flightPatch).length;
          await update(ref(db, '/'), flightPatch);
          log(`  ✓ ${count} flight/extra match(es) for ${tk} deleted`);
        }
      }

      // 3. Delete player records
      log(`Deleting ${PLAYER_IDS.length} player records…`);
      const playerPatch: Record<string, null> = {};
      for (const pid of PLAYER_IDS) playerPatch[`players/${pid}`] = null;
      await update(ref(db, '/'), playerPatch);
      log('  ✓ All player records deleted');

      log('');
      log(`Done. Removed: ${allTournamentKeys.length} tournaments · ${PLANNED_KEYS.length} planned matches · ${PLAYER_IDS.length} players.`);
      done = true;
    } catch (err: unknown) {
      log(`Error: ${String(err)}`, false);
    }

    running = false;
  }
</script>

<div class="wrap">
  <h2>Demo Data Cleanup</h2>
  <p class="desc">Deletes <strong>only</strong> the exact records created by the League Demo seeder:</p>
  <ul class="scope">
    <li>Tournaments: <code>league-demo-2026</code> + Gold/Silver/Bronze Flight records</li>
    <li>{PLAYER_IDS.length} demo players (Arjun Sharma, Priya Mehta, … hardcoded list)</li>
    <li>{PLANNED_KEYS.length} planned matches tagged to that tournament</li>
  </ul>
  <p class="warn">⚠ Real tournaments, real players, and real match history are not touched.</p>

  {#if !done}
    <button class="btn-run" onclick={runCleanup} disabled={running}>
      {running ? 'Deleting…' : 'Delete demo data'}
    </button>
  {/if}

  {#if logs.length > 0}
    <div class="log">
      {#each logs as e}
        <div class:err={!e.ok}>{e.msg}</div>
      {/each}
      {#if running}<div class="spin">…</div>{/if}
    </div>
  {/if}

  {#if done}
    <p class="success">✓ Cleanup complete. Safe to delete this page.</p>
  {/if}
</div>

<style>
  .wrap { max-width: 560px; margin: 2rem auto; padding: 1.5rem; color: var(--fg, #f5f5f5); font-family: inherit; }
  h2 { margin: 0 0 0.5rem; font-size: 1.2rem; color: var(--accent, #ffd54a); }
  .desc { margin: 0 0 0.4rem; font-size: 0.9rem; color: rgba(255,255,255,0.7); }
  .scope { margin: 0 0 0.6rem; padding-left: 1.2rem; font-size: 0.85rem; color: rgba(255,255,255,0.65); line-height: 1.7; }
  .scope code { background: rgba(255,255,255,0.07); padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.8rem; }
  .warn { margin: 0 0 1.2rem; font-size: 0.82rem; color: #e05c5c; }
  .btn-run { padding: 0.6rem 1.4rem; background: #e05c5c; color: #fff; border: none; border-radius: 0.5rem; font: inherit; font-size: 0.95rem; font-weight: 700; cursor: pointer; }
  .btn-run:disabled { opacity: 0.5; cursor: not-allowed; }
  .log { margin-top: 1rem; background: #0e0e0e; border: 1px solid rgba(255,255,255,0.1); border-radius: 0.5rem; padding: 0.75rem 1rem; font-family: monospace; font-size: 0.78rem; line-height: 1.7; max-height: 40vh; overflow-y: auto; color: rgba(255,255,255,0.7); }
  .err { color: #e05c5c; }
  .spin { color: var(--accent, #ffd54a); }
  .success { margin-top: 1rem; color: #9be0a8; font-weight: 700; font-size: 0.9rem; }
</style>
