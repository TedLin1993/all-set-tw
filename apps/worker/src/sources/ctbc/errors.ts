import type { SourceSyncError, SourceSyncErrorSource } from "../sync-error";

export class CtbcVerificationRequiredError
  extends Error
  implements SourceSyncErrorSource
{
  constructor(message: string) {
    super(message);
    this.name = "CtbcVerificationRequiredError";
  }

  toSyncError(): SourceSyncError {
    return { status: 400, code: "USER_ACTION_REQUIRED", needsUserAction: true };
  }
}
