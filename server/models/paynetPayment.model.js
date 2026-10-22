import { Schema, model, Types } from "mongoose";

const { ObjectId } = Types;

// Existing collection also stores new Ezone Pay top-up attempts so legacy
// Tlync sessions can still be reconciled during the provider cutover.
const paynetPaymentSchema = new Schema(
  {
    userId: { type: ObjectId, ref: "User", required: true },
    paymentMethodId: { type: ObjectId, ref: "PaymentMethod", required: true },
    // Snapshot of the picked method's display label. Its provider method ID is
    // the only payment method allowed on the hosted page.
    payMethodLabel: { type: String },
    // The unique order reference sent to the payment provider and echoed by
    // its webhook.
    customRef: { type: String, required: true, unique: true },
    provider: { type: String, enum: ["ezone"], required: false },
    providerLinkId: { type: String },
    providerTransactionId: { type: String },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "expired"],
      default: "pending",
      required: true,
    },
    paymentUrl: { type: String },
    // Legacy Tlync receipt details; Ezone Pay transaction IDs are stored
    // separately.
    gatewayName: { type: String },
    gatewayRef: { type: String },
    receiptReference: { type: String },
    webhookReceivedAt: { type: Date },
  },
  { timestamps: true },
);

paynetPaymentSchema.index({ userId: 1, createdAt: -1 });
paynetPaymentSchema.index(
  { providerTransactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerTransactionId: { $type: "string" } },
  },
);

const PaynetPayment = model(
  "PaynetPayment",
  paynetPaymentSchema,
  "paynet_payments",
);
export default PaynetPayment;
