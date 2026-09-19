// The startup banner: a pixel wordmark drawn with half-block characters.

// 5×7 bitmap glyphs. Rendered with ▀ ▄ █, every terminal cell holds two square-ish pixels.
export const GLYPHS = {
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  ':': ['...', '.##', '.##', '...', '...', '.##', '.##'],
};

const HALF = { '11': '█', '10': '▀', '01': '▄', '00': ' ' };

/** Render `word` as lines of half-block characters (7 pixel rows → 4 lines). */
export function pixelRows(word, spacing = 1) {
  const height = 7;
  const bitmap = Array.from({ length: height }, () => '');
  [...word.toUpperCase()].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
    for (let row = 0; row < height; row++) bitmap[row] += (i ? '.'.repeat(spacing) : '') + glyph[row];
  });
  const lines = [];
  for (let top = 0; top < height; top += 2) {
    let line = '';
    for (let col = 0; col < bitmap[0].length; col++) {
      const upper = bitmap[top][col] === '#' ? 1 : 0;
      const lower = top + 1 < height && bitmap[top + 1][col] === '#' ? 1 : 0;
      line += HALF[`${upper}${lower}`];
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function wordmark(theme, word = 'CINDER:', indent = 2) {
  return pixelRows(word).map((row) => ' '.repeat(indent) + theme.paint('accent.bold', row));
}
