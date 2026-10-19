/**
 * main.tsx
 * Mount point. The stylesheet is imported here so Tailwind's build sees it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
// Lenis's own rules (height, the stopped state, nested-scroll containment).
import "lenis/dist/lenis.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error('Missing #root element — check index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
