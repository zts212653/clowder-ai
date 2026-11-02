interface Reader {
  read(command: string, ...args: string[]): Promise<unknown>;
}

/** Coalesce at most eight genuine empty cursor pages. Every physical read still
 * passes the approved transport policy and counts against its global budget.
 * No key, command, MATCH expression or COUNT is substituted. */
export function coalesceSparseScans(reader: Reader): Reader {
  return {
    async read(command, ...args) {
      if (command !== 'SCAN' && command !== 'SSCAN') return reader.read(command, ...args);
      const cursorIndex = command === 'SCAN' ? 0 : 1;
      const next = [...args];
      for (let page = 0; page < 8; page++) {
        const result = await reader.read(command, ...next);
        if (
          !Array.isArray(result) ||
          typeof result[0] !== 'string' ||
          !/^\d+$/.test(result[0]) ||
          !Array.isArray(result[1]) ||
          result[1].some((key: unknown) => typeof key !== 'string')
        )
          throw new Error('Invalid physical source scan');
        if (result[0] === '0' || result[1].length > 0 || page === 7) return result;
        next[cursorIndex] = result[0];
      }
      throw new Error('Sparse scan batch did not settle');
    },
  };
}
