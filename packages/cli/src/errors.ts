/** An expected failure with a message meant for the user (no stack trace needed). */
export class CrewmindError extends Error {
  override name = 'CrewmindError';
}
