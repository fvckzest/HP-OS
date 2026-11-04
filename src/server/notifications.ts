/**
 * Notification module boundary.
 *
 * Route handlers may keep importing this stable facade while business
 * handlers use the queue module directly. The implementation is split by
 * ownership: contract and payload rules, transactional queue writes, Site
 * worker operations, and bounded HP-OS recovery.
 */
export * from "./notification-contract";
export * from "./notification-queue";
export * from "./notification-worker";
export * from "./notification-processing";
