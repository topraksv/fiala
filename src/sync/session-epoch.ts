/**
 * User-scoped cancellation for sync and background maintenance.
 *
 * A token is valid only for the session epoch that created it. Starting a
 * different user or stopping the current session aborts the previous signal,
 * so late network responses can never write into the next user's workspace.
 */

export interface SessionEpochToken {
  userId: string;
  epoch: number;
  signal: AbortSignal;
}

export class SessionEpochCancelledError extends Error {
  constructor() {
    super("Session epoch is no longer active");
    this.name = "SessionEpochCancelledError";
  }
}

export class SessionEpoch {
  private epoch = 0;
  private userId: string | null = null;
  private controller: AbortController | null = null;

  /** The account whose session is open, if any. */
  get activeUserId(): string | null {
    return this.userId;
  }

  start(userId: string): SessionEpochToken {
    this.controller?.abort();
    this.epoch += 1;
    this.userId = userId;
    this.controller = new AbortController();
    return { userId, epoch: this.epoch, signal: this.controller.signal };
  }

  capture(userId: string): SessionEpochToken | null {
    if (this.userId !== userId || !this.controller || this.controller.signal.aborted) return null;
    return { userId, epoch: this.epoch, signal: this.controller.signal };
  }

  isCurrent(token: SessionEpochToken): boolean {
    return (
      this.userId === token.userId &&
      this.epoch === token.epoch &&
      this.controller?.signal === token.signal &&
      !token.signal.aborted
    );
  }

  assertCurrent(token: SessionEpochToken): void {
    if (!this.isCurrent(token)) throw new SessionEpochCancelledError();
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.userId = null;
    this.epoch += 1;
  }
}
