import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { App } from "./app";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";

let lastCoarseAt = 0;

function setPointerMode(pointerType: string): void {
  if (pointerType === "touch" || pointerType === "pen") {
    lastCoarseAt = Date.now();
    document.documentElement.dataset.pointer = "coarse";
    return;
  }
  if (Date.now() - lastCoarseAt < 1200) return;
  document.documentElement.dataset.pointer = "fine";
}

setPointerMode(window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches ? "touch" : "mouse");
window.addEventListener("pointerdown", (event) => {
  setPointerMode(event.pointerType);
}, { capture: true, passive: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AuthGate>
        <App />
      </AuthGate>
    </HashRouter>
  </StrictMode>,
);
