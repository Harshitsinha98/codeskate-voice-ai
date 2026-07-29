/**
 * Call Logger — in-memory call logs (Phase 1).
 */

import { logger } from "../config/logger.js";

const MAX_LOGS = 1000;
const callLogs = new Map();

export function createCallLog(data) {
  const log = {
    callUuid: data.callUuid, from: data.from, to: data.to,
    direction: data.direction || "inbound", status: data.status || "ringing",
    startedAt: data.startedAt || new Date().toISOString(),
    endedAt: null, duration: 0, hangupCause: null, transcript: [],
    createdAt: new Date().toISOString(),
  };
  callLogs.set(data.callUuid, log);
  if (callLogs.size > MAX_LOGS) callLogs.delete(callLogs.keys().next().value);
  return log;
}

export function updateCallLog(callUuid, updates) {
  const log = callLogs.get(callUuid);
  if (!log) return null;
  Object.assign(log, updates);
  return log;
}

export function appendTranscript(callUuid, role, text) {
  if (!callUuid) return;
  const log = callLogs.get(callUuid);
  if (!log) return;
  log.transcript.push({ role, text, at: new Date().toISOString() });
}

export function getCallLog(callUuid) { return callLogs.get(callUuid) || null; }

export function getRecentCalls(limit = 50) {
  return Array.from(callLogs.values()).reverse().slice(0, limit);
}

export function getCallStats() {
  const all = Array.from(callLogs.values());
  const totalCalls = all.length;
  const totalDuration = all.reduce((sum, c) => sum + (c.duration || 0), 0);
  return { totalCalls, totalDuration, completed: all.filter((c) => c.status === "completed").length, averageDuration: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0 };
}
