import "@mavna/widget/widget.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Playground } from "./Playground.js";
import "./playground.css";

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element to mount into.");

createRoot(container).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
