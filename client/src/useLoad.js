// Loading one thing that costs a model call, at most once per key.
//
// A plan, a lesson and the learner model are each a request that can take ten seconds, so a result
// is kept for the life of the page: going back to the plan is instant instead of a second call.
// The cache holds the in-flight promise too, so React's development-mode double render joins the
// first request rather than paying for a second one.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// key -> a promise while it is in flight, then the settled { status, data, error }.
const cache = new Map();

const LOADING = { status: "loading", data: null, error: null };

// Evidence changed (an answer was graded), so anything already loaded may now be stale.
export function forgetLoaded() {
  cache.clear();
}

function cachedState(key) {
  const entry = cache.get(key);
  return entry && typeof entry.then !== "function" ? entry : LOADING;
}

function load(key, fn) {
  const entry = cache.get(key);
  if (entry) return Promise.resolve(entry);

  const promise = fn().then(
    (data) => {
      const settled = { status: "ready", data, error: null };
      cache.set(key, settled);
      return settled;
    },
    (error) => {
      // A failure is not kept: pressing retry must actually retry.
      cache.delete(key);
      return { status: "error", data: null, error };
    }
  );
  cache.set(key, promise);
  return promise;
}

export function useLoad(key, fn) {
  const [state, setState] = useState(() => cachedState(key));
  const fnRef = useRef(fn);
  const [attempt, setAttempt] = useState(0);

  // The latest request function without making it a dependency: callers pass an arrow, which is a
  // new function every render.
  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let live = true;
    load(key, () => fnRef.current()).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const retry = useCallback(() => {
    cache.delete(key);
    setState(LOADING);
    setAttempt((count) => count + 1);
  }, [key]);

  return { ...state, retry };
}
