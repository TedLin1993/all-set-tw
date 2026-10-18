export class CtbcVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtbcVerificationRequiredError";
  }
}
