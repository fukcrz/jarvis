import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { App } from "./app";
import { AuthGate } from "./components/auth-gate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AuthGate>
        <App />
      </AuthGate>
    </HashRouter>
  </StrictMode>,
);
