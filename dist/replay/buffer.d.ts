/**
 * The rolling window of recent frames.
 *
 * Mirrors `buffer.dart` in the Dart SDK. Bounded by **bytes**, not by frame
 * count: a busy screen encodes to several times the size of a quiet one, so a
 * count-based bound means the memory this occupies depends on what the user
 * happens to be looking at - which is the one thing an SDK living in someone
 * else's heap must not do.
 *
 * Frames are discarded oldest-first and never written anywhere until an error
 * fires. In the common case - an app that does not crash - every frame this
 * buffer ever holds is thrown away, and that is the design working.
 *
 * A plain array with `shift()`, where `events.ts` uses a ring. The queue there
 * holds ten thousand events; this holds thirty to sixty frames, and at that
 * size the reindexing `shift()` does is cheaper than the bookkeeping a ring
 * would add.
 */
export interface BufferedFrame {
    bytes: Uint8Array;
    /** Epoch milliseconds. */
    capturedAt: number;
}
export declare class FrameRingBuffer {
    readonly maxBytes: number;
    /**
     * A second bound, so a pathological run of tiny frames cannot grow the
     * bookkeeping without bound even while staying under the byte ceiling.
     */
    readonly maxFrames: number;
    private frames;
    private bytes;
    private evicted;
    constructor(maxBytes: number, 
    /**
     * A second bound, so a pathological run of tiny frames cannot grow the
     * bookkeeping without bound even while staying under the byte ceiling.
     */
    maxFrames: number);
    get byteLength(): number;
    get length(): number;
    /**
     * Frames dropped to stay inside the bounds. In steady state this rises
     * forever, which is correct: it is the count of frames the app was never
     * going to need.
     */
    get evictedCount(): number;
    add(frame: BufferedFrame): void;
    /**
     * Everything currently held, oldest first, and empty the buffer.
     *
     * Draining rather than copying: once these frames are on their way to
     * storage the window starts again, so a second error moments later does not
     * upload the same seconds twice.
     */
    drain(): BufferedFrame[];
    clear(): void;
}
/**
 * Drop the oldest frames until the packed segment fits the ceiling.
 *
 * Oldest first because the frames nearest the error are the ones that explain
 * it. Counts the per-frame length prefix and leaves headroom for the header,
 * so the result is under the limit rather than near it - an overshoot is
 * refused by the storage signature and costs the whole segment.
 */
export declare function trimToSegmentBudget(frames: BufferedFrame[], maxSegmentBytes: number, headroom?: number): BufferedFrame[];
