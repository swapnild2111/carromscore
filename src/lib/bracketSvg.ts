import type { PlannedMatch } from './planned';

export const KO_BRACKET_ROUND_ORDER = ['R32', 'R16', 'QF', 'SF', 'Final'] as const;
export const KO_BRACKET_ROUND_RX = /^(R32|R16|QF|SF|Final)$/i;

/** Ordered round names present in the given matches, in canonical bracket order. */
export function koRoundsFromMatches(matches: PlannedMatch[]): string[] {
  const seen = new Set<string>();
  for (const m of matches) if (m.round) seen.add(m.round);
  return KO_BRACKET_ROUND_ORDER.filter((r) => seen.has(r));
}

/**
 * Build a dark-themed SVG tree diagram for a standalone KO bracket.
 *
 * @param rounds   Ordered round labels (e.g. ['QF','SF','Final'])
 * @param matches  All planned matches for the bracket rounds
 * @param nameFn   Resolves a player ID to a display name
 */
export function buildKOBracketSVG(
  rounds: string[],
  matches: PlannedMatch[],
  nameFn: (id: string) => string,
): string {
  if (rounds.length < 1) return '';

  const COL_W = 220;
  const COL_GAP = 40;
  const SLOT_H = 48;
  const SLOT_PAD = 10;
  const NAME_MAX = 20;

  function clip(s: string): string {
    return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
  }

  type Slot = {
    aName: string;
    bName: string;
    isDone: boolean;
    winner?: 'a' | 'b';
    setsA?: number;
    setsB?: number;
    isBye: boolean;
  };

  const cols: Array<{ label: string; slots: Slot[] }> = rounds.map((r) => ({
    label: r,
    slots: matches
      .filter((m) => m.round === r)
      .sort((a, b) => (a.matchOrder ?? 0) - (b.matchOrder ?? 0))
      .map((m) => {
        const aName = m.aResolvedId ? nameFn(m.aResolvedId) : m.aName;
        const bName = m.bResolvedId ? nameFn(m.bResolvedId) : m.bName;
        return {
          aName,
          bName,
          isDone: !!m.completedAt,
          winner: m.result?.winner === 'a' ? 'a' : m.result?.winner === 'b' ? 'b' : undefined,
          setsA: m.result?.setsA,
          setsB: m.result?.setsB,
          isBye: aName === 'Bye' || bName === 'Bye',
        };
      }),
  }));

  const maxSlots = Math.max(...cols.map((c) => c.slots.length), 1);
  const colCount = cols.length;
  const totalH = maxSlots * SLOT_H + (maxSlots - 1) * SLOT_PAD;
  const totalW = colCount * COL_W + (colCount - 1) * COL_GAP;

  const colX = (ci: number) => ci * (COL_W + COL_GAP);
  function slotCY(idx: number, slotCount: number): number {
    const spacing = totalH / slotCount;
    return spacing * idx + spacing / 2;
  }

  const lines: string[] = [];

  // Stage labels
  for (let ci = 0; ci < cols.length; ci++) {
    const x = colX(ci);
    lines.push(`<text x="${x + COL_W / 2}" y="-6" text-anchor="middle" font-size="10" font-weight="700" font-family="sans-serif" fill="#888" letter-spacing="0.06em">${cols[ci]!.label.toUpperCase()}</text>`);
  }

  // Connector lines
  for (let ci = 0; ci < cols.length - 1; ci++) {
    const currCount = cols[ci]!.slots.length;
    const nextCount = cols[ci + 1]!.slots.length;
    const x1 = colX(ci) + COL_W;
    const x2 = colX(ci + 1);
    const xMid = x1 + COL_GAP / 2;
    for (let ni = 0; ni < nextCount; ni++) {
      const cy2 = slotCY(ni, nextCount);
      const srcA = ni * 2;
      const srcB = ni * 2 + 1;
      if (srcA < currCount) {
        const cy1 = slotCY(srcA, currCount);
        lines.push(`<line x1="${x1}" y1="${cy1}" x2="${xMid}" y2="${cy1}" stroke="#555" stroke-width="1.25"/>`);
        lines.push(`<line x1="${xMid}" y1="${cy1}" x2="${xMid}" y2="${cy2}" stroke="#555" stroke-width="1.25"/>`);
      }
      if (srcB < currCount) {
        const cy1 = slotCY(srcB, currCount);
        lines.push(`<line x1="${x1}" y1="${cy1}" x2="${xMid}" y2="${cy1}" stroke="#555" stroke-width="1.25"/>`);
        lines.push(`<line x1="${xMid}" y1="${cy1}" x2="${xMid}" y2="${cy2}" stroke="#555" stroke-width="1.25"/>`);
      }
      lines.push(`<line x1="${xMid}" y1="${cy2}" x2="${x2}" y2="${cy2}" stroke="#555" stroke-width="1.25"/>`);
    }
  }

  // Match slots
  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci]!;
    const x = colX(ci);
    for (let mi = 0; mi < col.slots.length; mi++) {
      const slot = col.slots[mi]!;
      const cy = slotCY(mi, col.slots.length);
      const sy = cy - SLOT_H / 2;

      if (slot.isBye) {
        // Bye slot: single-player box — seeded player auto-advances, no real opponent
        const realName = slot.aName === 'Bye' ? slot.bName : slot.aName;
        lines.push(`
          <rect x="${x}" y="${sy}" width="${COL_W}" height="${SLOT_H}" rx="5" fill="#161b22" stroke="#2a3040" stroke-width="1" stroke-dasharray="4 2"/>
          <text x="${x + 8}" y="${cy + 5}" font-size="11" font-weight="600" font-family="sans-serif" fill="#ccc">${clip(realName)}</text>
          <text x="${x + COL_W - 8}" y="${cy + 5}" text-anchor="end" font-size="9" font-family="sans-serif" fill="#4a5568" letter-spacing="0.05em">BYE</text>
        `);
      } else {
        // Normal match slot
        const aIsWinner = slot.isDone && slot.winner === 'a';
        const bIsWinner = slot.isDone && slot.winner === 'b';
        const aFill = aIsWinner ? '#ffd54a' : '#ccc';
        const bFill = bIsWinner ? '#ffd54a' : '#ccc';
        const aWeight = aIsWinner ? '700' : '400';
        const bWeight = bIsWinner ? '700' : '400';
        const aOpacity = slot.isDone && !aIsWinner ? '0.4' : '1';
        const bOpacity = slot.isDone && !bIsWinner ? '0.4' : '1';
        const score = slot.isDone && slot.setsA !== undefined ? `${slot.setsA}–${slot.setsB}` : '';
        lines.push(`
          <rect x="${x}" y="${sy}" width="${COL_W}" height="${SLOT_H}" rx="5" fill="#1e1e1e" stroke="${slot.isDone ? '#444' : '#333'}" stroke-width="1"/>
          <line x1="${x + 1}" y1="${cy}" x2="${x + COL_W - 1}" y2="${cy}" stroke="#2a2a2a" stroke-width="0.75"/>
          <text x="${x + 8}" y="${sy + 17}" font-size="11" font-weight="${aWeight}" opacity="${aOpacity}" font-family="sans-serif" fill="${aFill}">${clip(slot.aName) || 'TBD'}</text>
          <text x="${x + 8}" y="${sy + SLOT_H - 9}" font-size="11" font-weight="${bWeight}" opacity="${bOpacity}" font-family="sans-serif" fill="${bFill}">${clip(slot.bName) || 'TBD'}</text>
          ${score ? `<text x="${x + COL_W - 6}" y="${cy + 4}" text-anchor="end" font-size="10" font-family="sans-serif" fill="#888" font-weight="600">${score}</text>` : ''}
        `);
      }
    }
  }

  const svgH = Math.max(totalH, 80);
  const svgPadT = 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -${svgPadT} ${totalW + 16} ${svgH + svgPadT + 8}" width="${totalW + 16}" height="${svgH + svgPadT + 8}" style="max-width:100%;height:auto;display:block;overflow:visible">
    ${lines.join('\n')}
  </svg>`;
}
