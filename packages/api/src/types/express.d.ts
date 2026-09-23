/** Who is making the request, set by the auth middleware. */
export interface RequestActor {
  /** `user` — an authenticated admin; `sdk` — a caller holding the SDK API key. */
  type: 'user' | 'sdk';
  /** The user's id for `user`; the literal `sdk` otherwise. Written to audit_log.actor. */
  id: string;
}

declare global {
  namespace Express {
    interface Request {
      actor?: RequestActor;
    }
  }
}
