export type DomainErrorStatus = 400 | 401 | 403 | 404 | 409 | 422;

export class DomainError extends Error {
  readonly code: string;
  readonly status: DomainErrorStatus;

  constructor(code: string, status: DomainErrorStatus, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}
