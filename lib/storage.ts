import { useState, useEffect } from "react";

function getStorageValue<T>(key: string, defaultValue: T) {
  if (typeof window === "undefined") {
    return defaultValue;
  }

  const saved = window.localStorage.getItem(key);
  if (saved === null) {
    return defaultValue;
  }

  try {
    return JSON.parse(saved) as T;
  } catch {
    return defaultValue;
  }
}

export function useLocalStorage<T>(key: string, defaultValue: T | (() => T)) {
  const [value, setValue] = useState(() =>
    getStorageValue(
      key,
      defaultValue instanceof Function ? defaultValue() : defaultValue,
    ),
  );
  useEffect(() => window.localStorage.setItem(key, JSON.stringify(value)), [key, value]);
  return [value, setValue] as const;
}
