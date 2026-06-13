/**
 * Authentication module — handles user login, registration, and session management.
 */
import { hashPassword, verifyPassword } from "./utils.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface AuthSession {
  userId: string;
  token: string;
  expiresAt: Date;
}

const users = new Map<string, User>();
const sessions = new Map<string, AuthSession>();

export async function registerUser(email: string, password: string): Promise<User> {
  if (users.has(email)) {
    throw new Error("User already exists");
  }
  const passwordHash = await hashPassword(password);
  const user: User = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    createdAt: new Date(),
  };
  users.set(email, user);
  return user;
}

export async function loginUser(email: string, password: string): Promise<AuthSession> {
  const user = users.get(email);
  if (!user) {
    throw new Error("User not found");
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid password");
  }
  const session: AuthSession = {
    userId: user.id,
    token: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
  sessions.set(session.token, session);
  return session;
}

export function validateSession(token: string): AuthSession | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function logoutUser(token: string): void {
  sessions.delete(token);
}