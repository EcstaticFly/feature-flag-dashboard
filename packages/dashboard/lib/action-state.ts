/**
 * Shared shape for Server Action results.
 *
 * Deliberately NOT in the 'use server' module: such a file may only export
 * async functions, so exporting the IDLE constant from there is a runtime
 * error ("a 'use server' file can only export async functions, found object").
 */
export interface ActionState {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  /**
   * What the user submitted, echoed back on failure.
   *
   * React resets an uncontrolled form once its action resolves, so without
   * this a rejected submission would wipe everything they typed. Feeding these
   * back through `defaultValue` makes the reset land on their own input.
   */
  values?: Record<string, string>;
}

export const IDLE: ActionState = { ok: false };
