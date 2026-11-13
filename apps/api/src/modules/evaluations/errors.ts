export class EvaluationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "EvaluationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
