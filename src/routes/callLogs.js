/**
 * Call Logs API Routes.
 */

import { Router } from "express";
import { getRecentCalls, getCallLog, getCallStats } from "../services/callLogger.js";

export const callLogRoutes = Router();

callLogRoutes.get("/calls", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ calls: getRecentCalls(limit) });
});

callLogRoutes.get("/calls/:callUuid", (req, res) => {
  const call = getCallLog(req.params.callUuid);
  if (!call) return res.status(404).json({ error: "Call not found" });
  res.json(call);
});

callLogRoutes.get("/stats", (req, res) => { res.json(getCallStats()); });
