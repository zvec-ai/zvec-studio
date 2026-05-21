/**
 * Onboarding state hook.
 *
 * Tracks whether the user has completed the first-run onboarding. Backed by
 * ``localStorage`` so the walkthrough never re-opens after the first dismissal.
 * Exposes an imperative reset for tests and a future "Replay onboarding" menu.
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'zvec-studio:onboarded';

function readStored(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStored(value: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore storage failures */
  }
}

export interface UseOnboardingResult {
  readonly open: boolean;
  readonly completed: boolean;
  readonly start: () => void;
  readonly dismiss: () => void;
  readonly reset: () => void;
}

/**
 * @param autoOpenIfNew When true (the default) the dialog opens automatically
 *  for first-time visitors. Set to false in tests / embedded scenarios.
 */
export function useOnboarding(autoOpenIfNew = true): UseOnboardingResult {
  const [completed, setCompleted] = useState<boolean>(() => readStored());
  const [open, setOpen] = useState<boolean>(false);

  useEffect(() => {
    if (autoOpenIfNew && !completed) {
      setOpen(true);
    }
  }, [autoOpenIfNew, completed]);

  const start = useCallback(() => setOpen(true), []);
  const dismiss = useCallback(() => {
    setCompleted(true);
    writeStored(true);
    setOpen(false);
  }, []);
  const reset = useCallback(() => {
    setCompleted(false);
    writeStored(false);
    setOpen(true);
  }, []);

  return { open, completed, start, dismiss, reset };
}

export { STORAGE_KEY as ONBOARDING_STORAGE_KEY };
