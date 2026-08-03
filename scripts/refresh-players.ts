import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { dedupePlayers, type Player } from './scrape/lib.ts';
import { scrapeMcaAll } from './scrape/mca.ts';
import { scrapeSol5Lit } from './scrape/sol5.ts';

async function main() {
  const buckets = await Promise.all([
    scrapeMcaAll().catch((err) => {
      console.error('[mca] scrape failed:', err.message);
      return [] as Player[];
    }),
    scrapeSol5Lit().catch((err) => {
      console.error('[sol5] scrape failed:', err.message);
      return [] as Player[];
    }),
  ]);

  const merged = dedupePlayers(buckets.flat());
  const outPath = resolve(process.cwd(), 'public/data/players.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const bySource = new Map<string, number>();
  for (const p of merged) {
    bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
  }
  console.log(`Wrote ${merged.length} unique players to ${outPath}`);
  for (const [src, n] of bySource) console.log(`  ${src}: ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
