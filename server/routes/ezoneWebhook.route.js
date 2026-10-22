import { Router } from "express";

import { handleEzoneWebhook } from "../controllers/wallet.controller.js";

const router = Router();

router.post("/", handleEzoneWebhook);

export default router;
