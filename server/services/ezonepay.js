import crypto from "crypto";
import axios from "axios";

const trimTrailingSlash = (value) => String(value || "").replace(/\/+$/, "");
const DEFAULT_BASE_URL = "https://test.ezonepay.ly";

const getBaseUrl = () =>
  trimTrailingSlash(process.env.EZONE_API_BASE_URL || DEFAULT_BASE_URL);

export const isSandbox = () =>
  new URL(getBaseUrl()).hostname.toLowerCase() === "test.ezonepay.ly";

const getApiKey = () => {
  const apiKey = process.env.EZONE_API_KEY;
  if (!apiKey || apiKey === "REPLACE_ME") {
    const error = new Error("EZONE_API_KEY_MISSING");
    error.code = "EZONE_API_KEY_MISSING";
    throw error;
  }
  return apiKey;
};

const getClient = () =>
  axios.create({
    baseURL: getBaseUrl(),
    headers: {
      "X-API-Key": getApiKey(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: Number(process.env.EZONE_API_TIMEOUT_MS || 30000),
  });

const toEzoneError = (error) => {
  const transformed = new Error(
    error?.response ? "EZONE_API_REQUEST_FAILED" : "EZONE_API_UNAVAILABLE",
  );
  transformed.code = error?.response
    ? "EZONE_API_REQUEST_FAILED"
    : "EZONE_API_UNAVAILABLE";
  transformed.status = error?.response?.status;
  return transformed;
};

export const createPaymentLink = async ({
  amount,
  orderReference,
  redirectUrl,
  customer,
  providerMethodId,
}) => {
  if (!Number.isSafeInteger(providerMethodId) || providerMethodId <= 0) {
    const error = new Error("EZONE_PAYMENT_METHOD_ID_INVALID");
    error.code = "EZONE_PAYMENT_METHOD_ID_INVALID";
    throw error;
  }

  let response;
  try {
    response = await getClient().post("/payment-link/new", {
      Title: "BayoCard Wallet Top-up",
      OrderReference: orderReference,
      IsUniqueOrderReference: true,
      InternalReference: orderReference,
      Amount: amount,
      Currency: 1,
      MaxUsageCount: 1,
      IncludedPaymentMethods: [providerMethodId],
      Customer: {
        FirstName: customer.firstName,
        LastName: customer.lastName,
        PhoneNumber: customer.phone,
      },
      RedirectUrl: redirectUrl,
    });
  } catch (error) {
    if (error.code === "EZONE_API_KEY_MISSING") throw error;
    throw toEzoneError(error);
  }

  const result = response.data?.data || response.data;
  const paymentUrl =
    result?.link || result?.Link || result?.paymentUrl || result?.PaymentUrl;
  const paymentLinkId =
    result?.id ??
    result?.Id ??
    result?.paymentLinkId ??
    result?.PaymentLinkId;
  if (
    typeof paymentUrl !== "string" ||
    !paymentUrl ||
    paymentLinkId == null
  ) {
    const error = new Error("EZONE_API_RESPONSE_INVALID");
    error.code = "EZONE_API_RESPONSE_INVALID";
    throw error;
  }

  return {
    paymentUrl,
    paymentLinkId: String(paymentLinkId),
  };
};

export const getPaymentLinkTransactions = async (paymentLinkId) => {
  let response;
  try {
    response = await getClient().get(
      `/payment-link/${encodeURIComponent(paymentLinkId)}/transactions`,
      { params: { PageNumber: 1, PageSize: 10 } },
    );
  } catch (error) {
    if (error.code === "EZONE_API_KEY_MISSING") throw error;
    throw toEzoneError(error);
  }

  const result = response.data?.data || response.data;
  const items = result?.items ?? result?.Items;
  if (!Array.isArray(items)) {
    const error = new Error("EZONE_API_RESPONSE_INVALID");
    error.code = "EZONE_API_RESPONSE_INVALID";
    throw error;
  }
  return items;
};

export const deletePaymentLink = async (paymentLinkId) => {
  let response;
  try {
    response = await getClient().post(
      `/payment-link/${encodeURIComponent(paymentLinkId)}/delete`,
    );
  } catch (error) {
    if (error.code === "EZONE_API_KEY_MISSING") throw error;
    throw toEzoneError(error);
  }

  return response.data;
};

export const verifyWebhookSignature = (rawBody, signature) => {
  const secret = process.env.EZONE_WEBHOOK_SECRET;
  if (!secret || secret === "REPLACE_ME") {
    const error = new Error("EZONE_WEBHOOK_SECRET_MISSING");
    error.code = "EZONE_WEBHOOK_SECRET_MISSING";
    throw error;
  }
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string") return false;

  const supplied = Buffer.from(signature, "base64");
  if (supplied.toString("base64") !== signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest();
  return (
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected)
  );
};
