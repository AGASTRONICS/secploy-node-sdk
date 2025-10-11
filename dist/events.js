"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventHandler = exports.EventQueue = void 0;
class EventQueue {
    constructor() {
        this.queue = [];
    }
    enqueue(event) {
        this.queue.push(event);
    }
    dequeue() {
        return this.queue.shift();
    }
    peek() {
        return this.queue[0];
    }
    size() {
        return this.queue.length;
    }
    clear() {
        this.queue = [];
    }
}
exports.EventQueue = EventQueue;
class EventHandler {
    constructor(queue) {
        this.queue = queue;
    }
    sendEvent(eventType, payload) {
        try {
            const event = {
                type: eventType,
                payload,
                timestamp: Date.now(),
            };
            this.queue.enqueue(event);
            return true;
        }
        catch (error) {
            console.error("Failed to queue event:", error);
            return false;
        }
    }
}
exports.EventHandler = EventHandler;
