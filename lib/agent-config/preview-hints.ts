/**
 * The two things a tester needs told, both consequences of configuration being
 * resolved once when a call starts.
 *
 * Kept pure and separate from the panel so the rules are testable and stated in
 * one place rather than buried in JSX.
 */

/**
 * True when starting a call would test something other than what is on screen.
 * The gateway reads the SAVED configuration, so unsaved edits would be absent
 * and the natural conclusion — "my change did nothing" — would be wrong.
 */
export function needsSaveChoice(dirty: boolean): boolean {
  return dirty;
}

/**
 * True when the configuration was saved after the current call began, so the
 * running call is still using the older settings.
 *
 * `startedWith` is null when no call is running.
 */
export function settingsChangedDuringCall(
  startedWith: string | null,
  current: string,
): boolean {
  if (startedWith === null) return false;
  return startedWith !== current;
}
