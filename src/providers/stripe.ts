import { httpJson, formEncode } from "./http.js";

/**
 * Stripe REST adapter. Base: https://api.stripe.com/v1 — auth: Bearer secret key.
 * Mode is determined ENTIRELY by the key prefix (sk_test_ vs sk_live_); there is
 * no per-request mode flag. Bodies are form-encoded (incl. bracketed nesting).
 */
const BASE = "https://api.stripe.com/v1";

function headers(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export interface StripeProduct {
  id: string;
  name: string;
  active: boolean;
  created: number;
}

export async function createProduct(
  key: string,
  params: { name: string; description?: string },
): Promise<StripeProduct> {
  const data = await httpJson<Record<string, any>>(`${BASE}/products`, {
    method: "POST",
    headers: headers(key),
    body: formEncode({ name: params.name, description: params.description }),
  });
  return { id: data.id, name: data.name, active: data.active, created: data.created };
}

export async function listProducts(key: string, limit = 10): Promise<StripeProduct[]> {
  const data = await httpJson<{ data?: any[] }>(`${BASE}/products`, {
    headers: headers(key),
    query: { limit: String(limit) },
  });
  return (data.data ?? []).map((p: Record<string, any>) => ({
    id: p.id,
    name: p.name,
    active: p.active,
    created: p.created,
  }));
}

export interface StripePrice {
  id: string;
  product: string;
  unitAmount: number | null;
  currency: string;
  recurring: unknown;
}

export async function createPrice(
  key: string,
  params: {
    product: string;
    currency: string;
    unitAmount: number;
    recurringInterval?: "day" | "week" | "month" | "year";
  },
): Promise<StripePrice> {
  const body: Record<string, unknown> = {
    product: params.product,
    currency: params.currency,
    unit_amount: params.unitAmount,
  };
  if (params.recurringInterval) {
    body.recurring = { interval: params.recurringInterval };
  }
  const data = await httpJson<Record<string, any>>(`${BASE}/prices`, {
    method: "POST",
    headers: headers(key),
    body: formEncode(body),
  });
  return {
    id: data.id,
    product: data.product,
    unitAmount: data.unit_amount ?? null,
    currency: data.currency,
    recurring: data.recurring,
  };
}
