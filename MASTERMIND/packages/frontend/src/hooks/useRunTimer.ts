import { useState, useEffect, useRef } from 'react';

/**
 * Tracks elapsed time of the current agent run.
 * Starts when agentState transitions from 'idle' to an active state,
 * stops when it returns to 'idle', preserving the final elapsed value.
 */
export function useRunTimer(agentState: string) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStateRef = useRef(agentState);

  // Handle state transitions
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = agentState;

    const wasIdle = prev === 'idle';
    const isActive = agentState !== 'idle';

    // Transition: idle → active = new run
    if (wasIdle && isActive) {
      startTimeRef.current = Date.now();
      setIsRunning(true);
      setElapsedMs(0);

      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedMs(Date.now() - startTimeRef.current);
        }
      }, 100);
    }

    // Transition: active → idle = run ended
    if (!wasIdle && !isActive && startTimeRef.current) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setElapsedMs(Date.now() - startTimeRef.current);
      setIsRunning(false);
    }
  }, [agentState]);

  // Cleanup interval on unmount only
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { elapsedMs, isRunning };
}
