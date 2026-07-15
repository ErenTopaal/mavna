import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WidgetStates } from "./dev/WidgetStates.js";
// Shipped separately from the component so a host can swap it wholesale.
import "@mavna/widget/widget.css";
import "./styles/globals.css";

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element to mount into.");

createRoot(container).render(
  <StrictMode>
    <WidgetStates />
  </StrictMode>,
);
