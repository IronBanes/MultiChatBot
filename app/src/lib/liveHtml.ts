// Whether HTML in AI replies runs live, per device. A cosmetic preference, so
// localStorage is enough; every mounted reader stays in sync through the
// listener set below.

import { useEffect, useState } from "react";

export type LiveHtml = "off" | "ask" | "auto";

const KEY = "liveHtml";
const DEFAULT: LiveHtml = "ask";

export function readLiveHtml(): LiveHtml {
  try {
    const v = localStorage.getItem(KEY);
    return v === "off" || v === "auto" ? v : v === "ask" ? "ask" : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function writeLiveHtml(v: LiveHtml) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage unavailable */
  }
}

// Every mounted useLiveHtml() subscribes; the setter notifies them all, so
// changing the setting updates open messages without a remount.
const listeners = new Set<(v: LiveHtml) => void>();

export function useLiveHtml(): [LiveHtml, (v: LiveHtml) => void] {
  const [live, setLive] = useState<LiveHtml>(readLiveHtml);
  useEffect(() => {
    const notify = (v: LiveHtml) => setLive(v);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);
  return [
    live,
    (v: LiveHtml) => {
      writeLiveHtml(v);
      for (const notify of listeners) notify(v);
    },
  ];
}