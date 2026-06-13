/**
 * Billing module — handles invoice generation, payment processing, and subscriptions.
 */
import { validateSession } from "./auth.js";

export interface Invoice {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "overdue";
  dueDate: Date;
  lineItems: InvoiceLineItem[];
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Subscription {
  id: string;
  userId: string;
  plan: "free" | "pro" | "enterprise";
  status: "active" | "cancelled" | "expired";
  startedAt: Date;
  expiresAt: Date;
}

const invoices = new Map<string, Invoice>();
const subscriptions = new Map<string, Subscription>();

export async function generateInvoice(
  token: string,
  items: InvoiceLineItem[],
): Promise<Invoice> {
  const session = validateSession(token);
  if (!session) throw new Error("Invalid session");

  const invoice: Invoice = {
    id: crypto.randomUUID(),
    userId: session.userId,
    amount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
    currency: "USD",
    status: "pending",
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    lineItems: items,
  };
  invoices.set(invoice.id, invoice);
  return invoice;
}

export async function processPayment(invoiceId: string, amount: number): Promise<Invoice> {
  const invoice = invoices.get(invoiceId);
  if (!invoice) throw new Error("Invoice not found");
  if (amount < invoice.amount) throw new Error("Insufficient payment");
  invoice.status = "paid";
  return invoice;
}

export function getInvoice(invoiceId: string): Invoice | null {
  return invoices.get(invoiceId) ?? null;
}

export async function createSubscription(
  token: string,
  plan: Subscription["plan"],
): Promise<Subscription> {
  const session = validateSession(token);
  if (!session) throw new Error("Invalid session");

  const subscription: Subscription = {
    id: crypto.randomUUID(),
    userId: session.userId,
    plan,
    status: "active",
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  };
  subscriptions.set(subscription.id, subscription);
  return subscription;
}

export function getSubscription(subscriptionId: string): Subscription | null {
  return subscriptions.get(subscriptionId) ?? null;
}