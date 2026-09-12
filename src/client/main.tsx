import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { App } from "./app";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";

let lastCoarseAt = 0;

function setHoverAllowed(allowed: boolean): void {
  document.documentElement.classList.toggle("allow-hover", allowed);
  document.documentElement.dataset.pointer = allowed ? "fine" : "coarse";
}

setHoverAllowed(false);
function lockCoarsePointer(): void {
  lastCoarseAt = Date.now();
  setHoverAllowed(false);
}
window.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch" || event.pointerType === "pen") lockCoarsePointer();
}, { capture: true, passive: true });
window.addEventListener("touchstart", lockCoarsePointer, { capture: true, passive: true });
window.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse" || event.buttons !== 0) return;
  if (Math.abs(event.movementX) + Math.abs(event.movementY) < 2) return;
  if (Date.now() - lastCoarseAt < 1200) return;
  setHoverAllowed(true);
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
