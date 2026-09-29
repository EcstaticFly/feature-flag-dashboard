/** Who is making the request, set by the auth middleware. */
export interface RequestActor {
  /**
   * `user` — an authenticated admin; `sdk` — a caller holding the SDK API key;
   * `system` — the integration endpoint.
   */
  type: 'user' | 'sdk' | 'system';
  /** The user's id, the literal `sdk`, or `system:integration`. Written to audit_log.actor. */
  id: string;
}

declare global {
  namespace Express {
    interface Request {
      actor?: RequestActor;
    }
  }
}
