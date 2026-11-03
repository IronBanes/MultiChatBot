import { useEffect } from "react";

/** Keeps the app exactly as tall as the visible area. On phones the on-screen keyboard
 *  shrinks the visual viewport but not the page, so iOS would slide the whole app up
 *  (hiding the header) to reveal the focused field. Sizing the app to the visual
 *  viewport instead makes the keyboard shrink the chat, like Discord. */
export function useKeyboardViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty("--app-height", `${vv.height}px`);
        root.style.setProperty("--app-top", `${vv.offsetTop}px`);
        // A keyboard covers far more than browser chrome does.
        root.toggleAttribute("data-keyboard", window.innerHeight - vv.height > 120);
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
}
