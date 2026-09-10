/**
 * Segment sequence numbers.
 *
 * `(project, session, seq)` is the identity of a segment - the object key is
 * built from it and the ClickHouse index collapses on it. Reusing a number
 * within a session therefore overwrites an earlier recording, and the plan is
 * charged at `seq == 0`. So a number is consumed only once its upload has
 * succeeded, and a store that outlives a page load must persist it.
 */

export interface SequenceStore {
  /** The number the next segment will use. */
  peek(): number;
  /** Mark that number used. Call only after the upload succeeded. */
  commit(): void;
}

/** For a session that lives exactly as long as the process: React Native. */
export class MemorySequence implements SequenceStore {
  private next = 0;

  peek(): number {
    return this.next;
  }

  commit(): void {
    this.next++;
  }
}
