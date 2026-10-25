import crypto from "crypto";
import { Types } from "mongoose";

import PaynetPayment from "../models/paynetPayment.model.js";
import PaymentMethod from "../models/paymentMethod.model.js";
import Transaction from "../models/transaction.model.js";
import User from "../models/user.model.js";

import * as paynet from "../services/paynet.js";
import * as ezonepay from "../services/ezonepay.js";
import { handleError } from "../utils/errorHandler.js";

const roundToCents = (v) =>
  Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// Matches the "scheme" in bayocard-mobile/app.json.
const RETURN_DEEP_LINK =
  process.env.EZONE_RETURN_DEEP_LINK ||
  process.env.PAYNET_RETURN_DEEP_LINK ||
  "bayocard://topup-return";

// Gateway top-ups are an individual-only feature - business accounts use
// admin-managed bank deposits / credit terms instead (see transaction.model.js).
const requireIndividual = (req, res) => {
  if (req.user.role !== "individual") {
    res.status(403).json({ code: "WALLET_INDIVIDUAL_ONLY" });
    return false;
  }
  return true;
};

// Atomically flips a payment from "pending" to "paid" so duplicate provider
// webhooks and status checks cannot credit the wallet twice.
const creditWalletForPayment = async ({
  paynetPayment,
  gatewayName,
  gatewayRef,
  receiptReference,
  providerTransactionId,
}) => {
  const claimed = await PaynetPayment.findOneAndUpdate(
    { _id: paynetPayment._id, status: "pending" },
    {
      status: "paid",
      ...(gatewayName ? { gatewayName } : {}),
      ...(gatewayRef ? { gatewayRef } : {}),
      ...(receiptReference ? { receiptReference } : {}),
      ...(providerTransactionId ? { providerTransactionId } : {}),
    },
    { new: true },
  );

  if (!claimed) {
    const user = await User.findById(paynetPayment.userId);
    return { balance: user?.balance ?? null, alreadyCredited: true };
  }

  const paymentMethod = await PaymentMethod.findById(claimed.paymentMethodId)
    .select("fee")
    .lean();
  const feeRate = Number(paymentMethod?.fee ?? 0);
  const creditedAmount =
    Number.isFinite(feeRate) && feeRate > 0
      ? roundToCents(Number(claimed.amount) * (1 - feeRate))
      : roundToCents(Number(claimed.amount));

  // Credit with an atomic $inc rather than reading the balance and writing a
  // sum derived from it. A top-up completing while the same user has a
  // checkout or an outgoing transfer in flight would otherwise persist a total
  // computed from a balance that had already moved, silently discarding
  // whichever of the two writes landed second.
  const user = await User.findOneAndUpdate(
    { _id: claimed.userId },
    { $inc: { balance: creditedAmount } },
    { new: true },
  );

  if (!user) {
    // The account disappeared between initiating the payment and confirming
    // it. Put the payment back in "pending" so the credit is retried (and is
    // visible as unresolved) instead of being recorded as done but never paid.
    await PaynetPayment.updateOne({ _id: claimed._id }, { status: "pending" });
    console.error(
      "[wallet] cannot credit gateway payment - user no longer exists",
      claimed.customRef,
      { userId: String(claimed.userId) },
    );
    return { balance: null, alreadyCredited: false };
  }

  const balanceAfter = roundToCents(user.balance);
  const balanceBefore = roundToCents(balanceAfter - creditedAmount);

  const transaction = new Transaction({
    userId: user._id,
    type: "gateway_deposit",
    amount: creditedAmount,
    balanceBefore,
    balanceAfter,
    paymentRef: claimed.customRef,
  });
  await transaction.save();

  return { balance: balanceAfter, alreadyCredited: false };
};

// Once a payment isn't obviously registered yet, don't fail it the instant a
// receipt lookup 404s - pay.net.ly may not have the reference indexed for a
// few seconds after the customer lands on the hosted page.
const FAIL_ON_404_AFTER_MS = 2 * 60 * 1000;

// Asks pay.net.ly directly for a payment's status via the Bearer-authenticated
// receipt endpoint. This - not the unsigned webhook body - is the authoritative
// confirmation before a wallet is credited. Returns the resolved status and
// never throws; a transient failure just leaves the payment "pending".
const reconcilePayment = async (paynetPayment) => {
  let receipt;
  try {
    receipt = await paynet.getReceipt({ customRef: paynetPayment.customRef });
  } catch (err) {
    if (
      err.code === "PAYNET_REQUEST_FAILED" &&
      err.status === 404 &&
      Date.now() - new Date(paynetPayment.createdAt).getTime() >
        FAIL_ON_404_AFTER_MS
    ) {
      await PaynetPayment.updateOne(
        { _id: paynetPayment._id, status: "pending" },
        { status: "failed" },
      );
      return "failed";
    }
    console.error(
      "[wallet] failed to reconcile pay.net.ly payment",
      paynetPayment.customRef,
      err,
    );
    return paynetPayment.status;
  }

  if (receipt?.result === "success" && receipt.data) {
    const paidAmount = Number(receipt.data.amount);
    if (
      Number.isFinite(paidAmount) &&
      Math.abs(paidAmount - paynetPayment.amount) > 0.01
    ) {
      // The provider reports a different amount than we initiated - don't
      // credit automatically, leave it for manual review.
      console.error(
        "[wallet] pay.net.ly receipt amount mismatch",
        paynetPayment.customRef,
        { expected: paynetPayment.amount, got: receipt.data.amount },
      );
      return paynetPayment.status;
    }

    await creditWalletForPayment({
      paynetPayment,
      gatewayName: receipt.data.gateway_name,
      gatewayRef: receipt.data.gateway_ref,
      receiptReference: receipt.data.reference,
    });
    return "paid";
  }

  // { result: "incomplete" } or anything unexpected - stay pending.
  return "pending";
};

const reconcileEzonePayment = async (payment) => {
  if (!payment.providerLinkId) return payment.status;

  let transactions;
  try {
    transactions = await ezonepay.getPaymentLinkTransactions(
      payment.providerLinkId,
    );
  } catch (err) {
    console.error(
      "[wallet] failed to reconcile Ezone Pay payment",
      payment.customRef,
      err,
    );
    return payment.status;
  }

  if (transactions.length === 0) return "pending";

  const transaction = transactions[0];
  const paidAmount = Number(transaction.amount ?? transaction.Amount);
  if (
    !Number.isFinite(paidAmount) ||
    Math.abs(paidAmount - payment.amount) > 0.01
  ) {
    console.error(
      "[wallet] Ezone Pay payment amount mismatch",
      payment.customRef,
      {
        expected: payment.amount,
        got: transaction.amount ?? transaction.Amount,
      },
    );
    return payment.status;
  }

  const transactionId = transaction.transactionId ?? transaction.TransactionId;
  await creditWalletForPayment({
    paynetPayment: payment,
    gatewayRef: transactionId == null ? undefined : String(transactionId),
    providerTransactionId:
      transactionId == null ? undefined : String(transactionId),
  });
  return "paid";
};

// Test-mode fallback, used only when the receipt lookup still says pending:
// the webhook body is taken at face value so a manual POST can complete a
// top-up without paying. Still amount-checked and still idempotent via
// creditWalletForPayment's pending->paid guard.
const resolveFromWebhookPayload = async (paynetPayment, payload) => {
  const isSuccess = String(payload.result || "").toLowerCase() === "success";
  if (!isSuccess) {
    await PaynetPayment.updateOne(
      { _id: paynetPayment._id, status: "pending" },
      { status: "failed" },
    );
    return "failed";
  }

  const paidAmount = Number(payload.amount);
  if (
    Number.isFinite(paidAmount) &&
    Math.abs(paidAmount - paynetPayment.amount) > 0.01
  ) {
    console.error(
      "[wallet] test-mode webhook amount mismatch",
      paynetPayment.customRef,
      { expected: paynetPayment.amount, got: payload.amount },
    );
    return paynetPayment.status;
  }

  await creditWalletForPayment({
    paynetPayment,
    gatewayName: payload.payment_method,
    gatewayRef: payload.our_ref,
  });
  return "paid";
};

export const getPaymentMethods = async (req, res) => {
  try {
    if (!requireIndividual(req, res)) return;

    const paymentMethods = await PaymentMethod.find({ active: true }).sort({
      order: 1,
      createdAt: -1,
    });
    // testMode lets the client badge the top-up flow when Ezone Pay uses its
    // test API host.
    return res
      .status(200)
      .json({ paymentMethods, testMode: ezonepay.isSandbox() });
  } catch (err) {
    return handleError(err, res);
  }
};

export const openTopup = async (req, res) => {
  try {
    if (!requireIndividual(req, res)) return;

    const sandbox = ezonepay.isSandbox();

    const { paymentMethodId, amount } = req.body;

    if (!Types.ObjectId.isValid(paymentMethodId || "")) {
      return res.status(400).json({ code: "PAYMENT_METHOD_NOT_FOUND" });
    }

    const paymentMethod = await PaymentMethod.findById(paymentMethodId);
    if (!paymentMethod || !paymentMethod.active) {
      return res.status(404).json({ code: "PAYMENT_METHOD_NOT_FOUND" });
    }
    const providerMethodId = Number(paymentMethod.providerMethodId);
    if (
      paymentMethod.provider !== "ezone" ||
      !Number.isSafeInteger(providerMethodId) ||
      providerMethodId <= 0 ||
      paymentMethod.isOnline === false
    ) {
      return res.status(409).json({ code: "WALLET_TOPUP_METHOD_UNAVAILABLE" });
    }

    let parsedAmount;
    if (paymentMethod.amountEnabled === false) {
      // The method sets the amount; the app never asks the user for it.
      parsedAmount = Number(paymentMethod.fixedAmount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res
          .status(500)
          .json({ code: "PAYMENT_METHOD_FIXED_AMOUNT_MISSING" });
      }
    } else {
      parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ code: "WALLET_TOPUP_AMOUNT_INVALID" });
      }
      const { minDeposit, maxDeposit } = paymentMethod;
      if (
        !Number.isFinite(minDeposit) ||
        (maxDeposit != null && !Number.isFinite(maxDeposit))
      ) {
        return res
          .status(500)
          .json({ code: "PAYMENT_METHOD_DEPOSIT_RANGE_MISSING" });
      }
      if (
        parsedAmount < minDeposit ||
        (maxDeposit != null && parsedAmount > maxDeposit)
      ) {
        return res
          .status(400)
          .json({ code: "WALLET_TOPUP_AMOUNT_OUT_OF_RANGE" });
      }
    }

    const dailyLimit = Number(paymentMethod.dailyLimit);
    if (Number.isFinite(dailyLimit) && dailyLimit > 0) {
      const feeRate = Number(paymentMethod.fee ?? 0);
      const netAmount =
        Number.isFinite(feeRate) && feeRate > 0
          ? parsedAmount * (1 - feeRate)
          : parsedAmount;

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const [totals] = await PaynetPayment.aggregate([
        {
          $match: {
            userId: req.user._id,
            paymentMethodId: paymentMethod._id,
            status: "paid",
            createdAt: { $gte: startOfDay },
          },
        },
        {
          $group: {
            _id: null,
            totalNetToday: {
              $sum: {
                $multiply: [
                  "$amount",
                  { $subtract: [1, paymentMethod.fee ?? 0] },
                ],
              },
            },
          },
        },
      ]);

      const totalNetToday = Number(totals?.totalNetToday ?? 0);
      const remainingDailyLimit = dailyLimit - totalNetToday;
      if (netAmount > remainingDailyLimit) {
        return res.status(400).json({
          code: "WALLET_TOPUP_DAILY_LIMIT_EXCEEDED",
          dailyLimit,
          remainingDailyLimit,
          totalNetToday,
        });
      }
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ code: "USER_NOT_FOUND" });
    }
    const customRef = `bayocard_${crypto.randomBytes(18).toString("hex")}`;

    const nameParts = user.name.trim().split(/\s+/);
    const firstName = nameParts.shift() || user.name;
    const lastName = nameParts.join(" ") || firstName;
    const returnUrl = `${RETURN_DEEP_LINK}?ref=${encodeURIComponent(customRef)}&status=success`;
    const payment = new PaynetPayment({
      userId: req.user._id,
      paymentMethodId: paymentMethod._id,
      payMethodLabel: paymentMethod.label,
      customRef,
      provider: "ezone",
      amount: parsedAmount,
      status: "pending",
    });
    await payment.save();

    let createdLink;
    try {
      createdLink = await ezonepay.createPaymentLink({
        amount: parsedAmount,
        orderReference: customRef,
        redirectUrl: returnUrl,
        providerMethodId,
        customer: {
          firstName,
          lastName,
          phone: user.phone,
        },
      });
    } catch (err) {
      await PaynetPayment.updateOne(
        { _id: payment._id, status: "pending" },
        { status: "failed" },
      );
      const handled = toWalletEzoneError(err, res);
      if (handled) return handled;
      throw err;
    }

    await PaynetPayment.updateOne(
      { _id: payment._id },
      {
        paymentUrl: createdLink.paymentUrl,
        providerLinkId: createdLink.paymentLinkId,
      },
    );

    return res.status(200).json({
      paymentRef: customRef,
      paymentUrl: createdLink.paymentUrl,
      amount: parsedAmount,
      testMode: sandbox,
    });
  } catch (err) {
    return handleError(err, res);
  }
};

export const getTopup = async (req, res) => {
  try {
    if (!requireIndividual(req, res)) return;

    const paymentRef = String(req.params.ref || "");
    if (!paymentRef) {
      return res.status(404).json({ code: "WALLET_TOPUP_SESSION_NOT_FOUND" });
    }

    const paynetPayment = await PaynetPayment.findOne({
      customRef: paymentRef,
      userId: req.user._id,
    });
    if (!paynetPayment) {
      return res.status(404).json({ code: "WALLET_TOPUP_SESSION_NOT_FOUND" });
    }

    let status = paynetPayment.status;
    if (status === "pending") {
      status =
        paynetPayment.provider === "ezone"
          ? await reconcileEzonePayment(paynetPayment)
          : await reconcilePayment(paynetPayment);
    }

    return res.status(200).json({
      paymentRef: paynetPayment.customRef,
      status,
      amount: paynetPayment.amount,
    });
  } catch (err) {
    return handleError(err, res);
  }
};

export const cancelTopup = async (req, res) => {
  try {
    if (!requireIndividual(req, res)) return;

    const paymentRef = String(req.params.ref || "");
    const payment = await PaynetPayment.findOne({
      customRef: paymentRef,
      userId: req.user._id,
    });
    if (!payment) {
      return res.status(404).json({ code: "WALLET_TOPUP_SESSION_NOT_FOUND" });
    }

    if (payment.provider !== "ezone") {
      return res.status(200).json({
        paymentRef: payment.customRef,
        status: payment.status,
      });
    }
    if (!payment.providerLinkId) {
      if (payment.status !== "pending") {
        return res.status(200).json({
          paymentRef: payment.customRef,
          status: payment.status,
        });
      }
      return res.status(409).json({ code: "WALLET_TOPUP_LINK_NOT_READY" });
    }

    if (payment.status === "pending") {
      let transactions;
      try {
        transactions = await ezonepay.getPaymentLinkTransactions(
          payment.providerLinkId,
        );
      } catch (err) {
        console.error(
          "[wallet] failed to check Ezone Pay payment before cancellation",
          payment.customRef,
          err,
        );
        const handled = toWalletEzoneError(err, res);
        if (handled) return handled;
        throw err;
      }

      if (transactions.length > 0) {
        const status = await reconcileEzonePayment(payment);
        if (status !== "paid") {
          return res.status(409).json({ code: "WALLET_TOPUP_ALREADY_USED" });
        }
      }
    }

    try {
      await ezonepay.deletePaymentLink(payment.providerLinkId);
    } catch (err) {
      if (err.code !== "EZONE_API_REQUEST_FAILED" || err.status !== 404) {
        console.error(
          "[wallet] failed to delete dismissed Ezone Pay payment link",
          payment.customRef,
          err,
        );
        const handled = toWalletEzoneError(err, res);
        if (handled) return handled;
        throw err;
      }
    }

    if (payment.status === "pending") {
      await PaynetPayment.findOneAndDelete({
        _id: payment._id,
        status: "pending",
      });
    }

    return res.status(200).json({
      paymentRef: payment.customRef,
    });
  } catch (err) {
    return handleError(err, res);
  }
};

const toWalletEzoneError = (err, res) => {
  if (err.code === "EZONE_API_KEY_MISSING") {
    return res.status(500).json({ code: "EZONE_API_KEY_MISSING" });
  }
  if (
    err.code === "EZONE_API_REQUEST_FAILED" ||
    err.code === "EZONE_API_UNAVAILABLE" ||
    err.code === "EZONE_API_RESPONSE_INVALID"
  ) {
    return res.status(502).json({ code: "WALLET_TOPUP_GATEWAY_ERROR" });
  }
  return null;
};

// Public endpoint - no verifyToken. pay.net.ly's backend_url callback carries
// no signature, so it is treated only as a "check now" nudge: we look the
// payment up by the custom_ref we generated (unguessable) and then confirm the
// real state through the Bearer-authenticated receipt endpoint before
// crediting. The wallet credit itself is idempotent (see creditWalletForPayment).
// Always resolves 2xx once handled so the provider stops retrying.
export const handlePaynetWebhook = async (req, res) => {
  try {
    const payload = req.body || {};
    const customRef = String(payload.custom_ref || "");

    if (!customRef) {
      return res.status(200).json({ received: true, ignored: "no_custom_ref" });
    }

    const paynetPayment = await PaynetPayment.findOne({
      customRef,
      provider: { $ne: "ezone" },
    });

    if (paynetPayment) {
      if (paynetPayment.status === "pending") {
        const status = await reconcilePayment(paynetPayment);
        // In test mode a manual webhook POST is a legitimate way to complete a
        // top-up without actually paying, so trust the body as a fallback.
        if (status === "pending" && paynet.isSandbox()) {
          await resolveFromWebhookPayload(paynetPayment, payload);
        }
      }
      await PaynetPayment.updateOne(
        { _id: paynetPayment._id },
        { webhookReceivedAt: new Date() },
      );
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return handleError(err, res);
  }
};

export const handleEzoneWebhook = async (req, res) => {
  let signatureIsValid;
  try {
    signatureIsValid = ezonepay.verifyWebhookSignature(
      req.rawBody,
      req.get("X-Signature"),
    );
  } catch (err) {
    if (err.code === "EZONE_WEBHOOK_SECRET_MISSING") {
      return res.status(503).json({ code: "EZONE_WEBHOOK_SECRET_MISSING" });
    }
    throw err;
  }

  if (!signatureIsValid) {
    return res.status(401).json({ code: "WEBHOOK_SIGNATURE_INVALID" });
  }

  const payload = req.body || {};
  if (
    Number(payload.event) !== 2 ||
    String(payload.transactionType || "").toLowerCase() !== "online"
  ) {
    return res
      .status(200)
      .json({ received: true, ignored: "unsupported_event" });
  }

  const orderReference = String(payload.orderReference || "");
  const transactionId = Number(payload.transactionId);
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    return res.status(400).json({ code: "WEBHOOK_PAYLOAD_INVALID" });
  }
  if (!orderReference) {
    return res
      .status(200)
      .json({ received: true, ignored: "no_order_reference" });
  }

  try {
    const payment = await PaynetPayment.findOne({
      customRef: orderReference,
      provider: "ezone",
    });
    if (!payment) {
      return res
        .status(200)
        .json({ received: true, ignored: "unknown_reference" });
    }

    await creditWalletForPayment({
      paynetPayment: payment,
      gatewayRef: String(transactionId),
      providerTransactionId: String(transactionId),
    });
    await PaynetPayment.updateOne(
      { _id: payment._id },
      { webhookReceivedAt: new Date() },
    );
    return res.status(200).json({ received: true });
  } catch (err) {
    return handleError(err, res);
  }
};
