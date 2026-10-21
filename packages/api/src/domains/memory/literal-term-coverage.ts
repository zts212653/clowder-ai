interface State {
  edges: Map<string, number>;
  fail: number;
}

function advance(states: State[], state: number, char: string): number {
  while (state && !states[state].edges.has(char)) state = states[state].fail;
  return states[state].edges.get(char) ?? 0;
}

function buildTrie(words: string[]) {
  const states: State[] = [{ edges: new Map(), fail: 0 }];
  const ends = words.map((word) => {
    let state = 0;
    for (let i = 0; i < word.length; i++) {
      const char = word[i];
      let next = states[state].edges.get(char);
      if (next === undefined) {
        next = states.length;
        states[state].edges.set(char, next);
        states.push({ edges: new Map(), fail: 0 });
      }
      state = next;
    }
    return state;
  });
  return { states, ends };
}

function linkFailures(states: State[]): number[] {
  const order = [...states[0].edges.values()];
  for (let i = 0; i < order.length; i++) {
    const parent = states[order[i]];
    for (const [char, next] of parent.edges) {
      states[next].fail = advance(states, parent.fail, char);
      order.push(next);
    }
  }
  return order;
}

function markMatches(states: State[], order: number[], content: string): Uint8Array {
  const seen = new Uint8Array(states.length);
  let state = 0;
  // UTF-16 units preserve String.includes semantics, including surrogate input.
  for (let i = 0; i < content.length; i++) {
    state = advance(states, state, content[i]);
    seen[state] = 1;
  }
  // Propagate once per state, not once per match: repeated/overlapping words
  // cannot multiply work by the number of occurrences or suffix patterns.
  for (let i = order.length - 1; i >= 0; i--) {
    const state = order[i];
    if (seen[state]) seen[states[state].fail] = 1;
  }
  return seen;
}

/** Aho-Corasick distinct-term coverage: O(content length + query states) per row.
 * At most sum(word.length)+1 states; no term cap or change to substring semantics.
 */
export function literalTermCoverage(words: string[]): (content: string) => number {
  const unique = [...new Set(words.filter(Boolean))];
  // Native substring search avoids a JavaScript visit to every character for
  // short natural queries. The fixed bound keeps work <= 4 native scans;
  // larger queries retain the automaton rather than scaling scans with terms.
  if (unique.length <= 4) {
    return (content) => unique.reduce((count, word) => count + Number(content.includes(word)), 0);
  }
  const { states, ends } = buildTrie(unique);
  const order = linkFailures(states);
  return (content) => {
    const seen = markMatches(states, order, content);
    return ends.reduce((count, state) => count + seen[state], 0);
  };
}
