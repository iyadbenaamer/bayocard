import { Schema, model } from "mongoose";

const paymentMethodSchema = new Schema(
  {
    // Internal identifier for the method, managed by the admin panel.
    name: { type: String, required: true, trim: true, unique: true },
    label: { type: String, required: true, trim: true },
    iconPath: { type: String, required: true },
    provider: { type: String, enum: ["ezone"] },
    providerMethodId: { type: Number, min: 1 },
    isOnline: { type: Boolean },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    // When true (default), the app shows an amount field and enforces
    // min/maxDeposit. When false the app hides the field and the top-up always
    // uses fixedAmount - for methods where the user shouldn't pick the amount.
    amountEnabled: { type: Boolean, default: true },
    minDeposit: { type: Number, min: 0 },
    maxDeposit: { type: Number, default: null, min: 0 },
    // Required only when amountEnabled is false.
    fixedAmount: { type: Number, min: 0 },
  },
  { timestamps: true },
);

paymentMethodSchema.pre("validate", function () {
  if (this.amountEnabled === false) {
    if (this.fixedAmount === undefined || this.fixedAmount === null) {
      throw new Error("PAYMENT_METHOD_FIXED_AMOUNT_REQUIRED");
    }
  } else if (
    this.minDeposit !== undefined &&
    this.maxDeposit !== undefined &&
    this.maxDeposit !== null &&
    this.maxDeposit <= this.minDeposit
  ) {
    throw new Error("PAYMENT_METHOD_MAX_MUST_EXCEED_MIN");
  }
});

const PaymentMethod = model(
  "PaymentMethod",
  paymentMethodSchema,
  "payment_methods",
);

export default PaymentMethod;
