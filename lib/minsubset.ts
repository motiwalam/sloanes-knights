/**
 * A class representing a subset of integers {0..N} using a disjoint-set data structure.
 *
 * The class only supports removal operations.
 *
 * build(N): initialize set {0..N}
 * remove(S): remove all elements in S
 * min: return the smallest element in the set, or null if empty
 */
export class MinSubset {
  private parent: Int32Array = new Int32Array(0);
  private n = -1;

  // build(N): initialize set {0..N}
  build(N: number): void {
    if (!Number.isInteger(N) || N < 0)
      throw new Error("N must be a non-negative integer.");
    this.n = N;
    // include sentinel N+1 = "empty"
    this.parent = new Int32Array(N + 2);
    for (let i = 0; i <= N + 1; i++) this.parent[i] = i;
  }

  private find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  // delete x by linking it to successor x+1
  private erase(x: number): void {
    const rx = this.find(x);
    const rnext = this.find(x + 1);
    this.parent[rx] = rnext;
  }

  // extract(S): remove all elements in S
  remove(S: number[]): void {
    for (const x of S) {
      if (Number.isInteger(x) && x >= 0 && x <= this.n) {
        this.erase(x);
      }
    }
  }

  // min(): smallest remaining element, or null if empty
  min(): number | null {
    const m = this.find(0);
    return m <= this.n ? m : null;
  }
}
