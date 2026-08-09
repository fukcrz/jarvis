export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
