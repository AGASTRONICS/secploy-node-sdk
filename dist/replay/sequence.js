"use strict";
/**
 * Segment sequence numbers.
 *
 * `(project, session, seq)` is the identity of a segment - the object key is
 * built from it and the ClickHouse index collapses on it. Reusing a number
 * within a session therefore overwrites an earlier recording, and the plan is
 * charged at `seq == 0`. So a number is consumed only once its upload has
 * succeeded, and a store that outlives a page load must persist it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemorySequence = void 0;
/** For a session that lives exactly as long as the process: React Native. */
class MemorySequence {
    constructor() {
        this.next = 0;
    }
    peek() {
        return this.next;
    }
    commit() {
        this.next++;
    }
}
exports.MemorySequence = MemorySequence;
