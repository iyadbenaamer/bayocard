import { Router } from "express";

import { handlePaynetWebhook } from "../controllers/wallet.controller.js";

const router = Router();

// Legacy callback for Tlync payments created before the Ezone Pay cutover.
router.post("/", handlePaynetWebhook);

export default router;
