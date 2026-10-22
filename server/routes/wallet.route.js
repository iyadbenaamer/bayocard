import { Router } from "express";

import {
  getPaymentMethods,
  getTopup,
  openTopup,
  cancelTopup,
} from "../controllers/wallet.controller.js";

import { verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/payment-methods", verifyToken, getPaymentMethods);
router.post("/topup", verifyToken, openTopup);
router.delete("/topup/:ref", verifyToken, cancelTopup);
router.get("/topup/:ref", verifyToken, getTopup);

export default router;
